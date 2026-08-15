import { randomUUID } from "node:crypto";

import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import {
  newRef,
  nowIso,
  stableId,
  type ProjectRef,
  type RoleRef,
  type RunRef,
  type SubgoalRef,
  type Task,
  type TaskRef,
  type TaskExecutionPolicy,
  type TaskResourceAllocation,
  type TaskRun,
  type TaskRunExecutionBinding,
} from "@zendev-lab/spark-core";
import {
  setSessionGoal,
  sparkSessionKey,
  sparkStateCwd,
  subgoalDefinitionDigest,
  type SparkSessionContext,
} from "@zendev-lab/spark-loop";
import type { SparkSessionCloseCandidate } from "@zendev-lab/spark-protocol/session-assignment";
import type { RoleRegistry, RoleSpec } from "@zendev-lab/spark-roles";
import { sparkTaskExecutorRoleRef } from "@zendev-lab/spark-runtime";
import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkReproSubgoal } from "./spark-session-repro.ts";
import {
  fleetLaneKey,
  resolveFleetTaskTarget,
  type ResolvedFleetTarget,
} from "./spark-fleet-target.ts";

export interface ManagedTaskSessionDispatchInput {
  cwd: string;
  ctx: SparkSessionContext;
  ownerSessionId: string;
  /** Causal owning turn; required for repro usage attribution across Task Sessions. */
  parentInvocationId?: string;
  projectRef: ProjectRef;
  taskRefs: TaskRef[];
  registry: RoleRegistry;
  subgoals?: readonly SparkReproSubgoal[];
  resourceAllocations?: Partial<Record<TaskRef, TaskResourceAllocation>>;
  /** Fleet uses stable target lanes and completion mail instead of per-Task Sessions. */
  fleet?: boolean;
  daemonRequest?: typeof requestSparkDaemon;
}

export interface ManagedTaskSessionDispatchRecord {
  runRef: RunRef;
  taskRef: TaskRef;
  roleRef: RoleRef;
  sessionId: string;
  goalId: string;
  jobId: string;
  attempt: number;
  invocationId: string;
}

export interface ManagedTaskSessionReconcileResult {
  inspected: number;
  terminal: number;
  succeeded: number;
  blocked: number;
  failed: number;
  cancelled: number;
  superseded: number;
}

class ManagedTaskSessionDispatchRefusal extends Error {
  readonly accepted = false;
  readonly reason: "attempt_limit";

  constructor(message: string, reason: "attempt_limit") {
    super(message);
    this.name = "ManagedTaskSessionDispatchRefusal";
    this.reason = reason;
  }
}

interface ReservedTaskSessionRun {
  run: TaskRun;
  roleRef: RoleRef;
  goal: string;
  evidenceRequired: string[];
  executionPolicy: TaskExecutionPolicy;
}

export async function dispatchManagedTaskSessions(
  input: ManagedTaskSessionDispatchInput,
): Promise<ManagedTaskSessionDispatchRecord[]> {
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const daemonRequest = input.daemonRequest ?? requestSparkDaemon;
  const store = defaultTaskGraphStore(stateCwd);
  const uniqueTaskRefs = [...new Set(input.taskRefs)];
  await store.reconcileStaleTaskRuns({ projectRef: input.projectRef });
  if (uniqueTaskRefs.length === 0) return [];
  const fleetTargets = input.fleet
    ? await resolveFleetTargets(stateCwd, store, uniqueTaskRefs)
    : undefined;
  const reserved = await store.update(
    (graph) => reserveTaskSessionRuns(graph, input, uniqueTaskRefs, fleetTargets),
    { createIfMissing: false },
  );
  if (!reserved.graph) throw new Error("Spark task graph is unavailable");

  const records: ManagedTaskSessionDispatchRecord[] = [];
  for (const reservation of reserved.result) {
    try {
      const execution = reservation.run.execution;
      if (!execution) throw new Error(`task run ${reservation.run.ref} has no execution binding`);
      const sessionId = taskExecutionSessionId(execution);
      await ensureTaskExecutionSession({
        cwd: input.cwd,
        ctx: input.ctx,
        projectRef: input.projectRef,
        taskRef: reservation.run.taskRef,
        runRef: reservation.run.ref,
        roleRef: reservation.roleRef,
        role: input.registry.get(reservation.roleRef),
        goal: reservation.goal,
        evidenceRequired: reservation.evidenceRequired,
        execution,
        fleetTarget: fleetTargets?.get(reservation.run.taskRef),
        daemonRequest,
      });
      const prompt = renderTaskExecutionPrompt(reservation);
      const submitted = input.fleet
        ? await submitFleetTaskRequest({
            daemonRequest,
            ownerSessionId: input.ownerSessionId,
            sessionId,
            parentInvocationId: input.parentInvocationId,
            projectRef: input.projectRef,
            reservation,
            prompt,
          })
        : await daemonRequest("turn.submit", {
            sessionId,
            prompt,
            ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
            idempotencyKey: `${execution.jobId}:attempt:${execution.attempt}`,
            assignment: taskAssignment(reservation),
            messageMetadata: taskMessageMetadata(input.projectRef, reservation),
          });
      await updateReservedRun(stateCwd, reservation.run.ref, reservation.run.taskRef, (run) => ({
        ...run,
        status: "running",
        startedAt: run.startedAt ?? nowIso(),
        execution: run.execution
          ? { ...run.execution, invocationId: submitted.invocationId }
          : undefined,
      }));
      records.push({
        runRef: reservation.run.ref,
        taskRef: reservation.run.taskRef,
        roleRef: reservation.roleRef,
        sessionId,
        goalId: execution.sessionGoalId,
        jobId: execution.jobId,
        attempt: execution.attempt,
        invocationId: submitted.invocationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (reservation.run.execution) {
        try {
          const failedSessionId = reservation.run.execution.executionSessionId;
          if (!failedSessionId) throw new Error("TaskRun execution Session id is missing");
          await daemonRequest("session.close", {
            sessionId: failedSessionId,
            reason: `TaskRun dispatch failed: ${message}`,
          });
        } catch (closeError) {
          if (!isSessionAlreadyClosed(closeError) && !isSessionNotFound(closeError)) {
            console.error(
              `[spark] failed to close TaskRun Session ${reservation.run.execution.executionSessionId}`,
              closeError,
            );
          }
        }
      }
      await updateReservedRun(stateCwd, reservation.run.ref, reservation.run.taskRef, (run) => ({
        ...run,
        status: "failed",
        failureKind: "runtime_error",
        errorMessage: message,
        finishedAt: nowIso(),
      }));
      throw error;
    }
  }
  return records;
}

export async function reconcileManagedTaskSessions(input: {
  cwd: string;
  ctx: SparkSessionContext;
  projectRef: ProjectRef;
  /** Reconcile only TaskRuns owned by this Session (Fleet completion wake path). */
  ownerSessionId?: string;
  subgoals?: readonly SparkReproSubgoal[];
  daemonRequest?: typeof requestSparkDaemon;
}): Promise<ManagedTaskSessionReconcileResult> {
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const store = defaultTaskGraphStore(stateCwd);
  const snapshot = await store.load();
  const active =
    snapshot
      ?.runs(input.projectRef)
      .filter(
        (run) =>
          run.execution &&
          (!input.ownerSessionId || run.execution.ownerSessionId === input.ownerSessionId) &&
          (run.status === "queued" || run.status === "running"),
      ) ?? [];
  if (active.length === 0) return emptyReconcileResult();

  const daemonRequest = input.daemonRequest ?? requestSparkDaemon;
  const invocationStatuses = new Map<string, string>();
  const timeoutRequests = new Map<RunRef, string>();
  await Promise.all(
    active.map(async (run) => {
      const invocationId = run.execution?.invocationId;
      if (!invocationId) return;
      try {
        const status = await daemonRequest("turn.status", { invocationId });
        invocationStatuses.set(run.ref, status.status);
        const task = snapshot?.getTask(run.taskRef);
        const timeoutMs = task?.executionPolicy?.timeoutMs;
        if (
          (status.status === "queued" || status.status === "running") &&
          timeoutMs !== undefined &&
          taskRunTimedOut(run, timeoutMs)
        ) {
          if (!run.timeoutRequestedAt) {
            const cancelled = await daemonRequest("turn.cancel", {
              invocationId,
              reason: `Task ${run.taskRef} exceeded executionPolicy.timeoutMs=${timeoutMs}.`,
            });
            if (cancelled.cancelRequested) timeoutRequests.set(run.ref, nowIso());
          }
        }
      } catch {
        // The task graph remains authoritative for a child that already wrote
        // its terminal outcome. Missing daemon state fails closed otherwise.
      }
    }),
  );

  const reconciled = await store.update(
    (graph): ManagedTaskSessionReconcileResult => {
      const result = emptyReconcileResult();
      for (const activeRun of active) {
        const run = graph
          .runs(input.projectRef)
          .find((candidate) => candidate.ref === activeRun.ref);
        if (!run?.execution || (run.status !== "queued" && run.status !== "running")) continue;
        result.inspected += 1;
        const task = graph.getTask(run.taskRef);
        const timeoutRequestedAt = run.timeoutRequestedAt ?? timeoutRequests.get(run.ref);
        if (timeoutRequestedAt && !run.timeoutRequestedAt) {
          graph.recordRun({ ...run, timeoutRequestedAt });
        }
        const currentSubgoal = run.execution.subgoalRef
          ? input.subgoals?.find((candidate) => candidate.ref === run.execution?.subgoalRef)
          : undefined;
        const definitionChanged =
          Boolean(run.execution.subgoalRef) &&
          (!currentSubgoal ||
            currentSubgoal.taskRef !== run.taskRef ||
            currentSubgoal.planRevision !== run.execution.planRevision ||
            subgoalDefinitionDigest(currentSubgoal) !== run.execution.definitionDigest);
        if (definitionChanged) {
          const message =
            "superseded: the bound Subgoal revision or definition changed before reconciliation";
          graph.recordRun(
            terminalManagedRun(run, "cancelled", message, task.outputEvidenceRefs, {
              failureKind: "runtime_cancelled",
            }),
          );
          result.terminal += 1;
          result.cancelled += 1;
          result.superseded += 1;
          continue;
        }

        if (task.status === "done") {
          graph.recordRun(
            terminalManagedRun(
              run,
              "succeeded",
              `Task ${task.ref} finished; Subgoal still requires verifier promotion.`,
              task.outputEvidenceRefs,
            ),
          );
          result.terminal += 1;
          result.succeeded += 1;
          continue;
        }
        if (task.status === "failed" || task.status === "cancelled") {
          const status = task.status === "failed" ? "failed" : "cancelled";
          graph.recordRun(
            terminalManagedRun(
              run,
              status,
              `Task ${task.ref} finished with status ${task.status}.`,
              task.outputEvidenceRefs,
              {
                failureKind: task.status === "failed" ? "runtime_error" : "runtime_cancelled",
              },
            ),
          );
          result.terminal += 1;
          result[status] += 1;
          continue;
        }

        const invocationStatus = invocationStatuses.get(run.ref);
        if (invocationStatus === "queued" || invocationStatus === "running") continue;
        if (invocationStatus === "cancelled" && timeoutRequestedAt) {
          graph.recordRun(
            terminalManagedRun(
              { ...run, timeoutRequestedAt },
              "failed",
              `Managed Session exceeded the Task execution timeout requested at ${timeoutRequestedAt}.`,
              task.outputEvidenceRefs,
              { failureKind: "runtime_timeout" },
            ),
          );
          graph.setTaskStatus(task.ref, "failed");
          result.terminal += 1;
          result.failed += 1;
          continue;
        }
        if (invocationStatus === "succeeded") {
          graph.recordRun(
            terminalManagedRun(
              run,
              "blocked",
              `Managed Session settled without finishing bound Task ${task.ref}.`,
              task.outputEvidenceRefs,
              { failureKind: "blocked" },
            ),
          );
          graph.setTaskStatus(task.ref, "blocked");
          result.terminal += 1;
          result.blocked += 1;
          continue;
        }
        if (invocationStatus === "failed" || invocationStatus === "cancelled") {
          const status = invocationStatus === "failed" ? "failed" : "cancelled";
          graph.recordRun(
            terminalManagedRun(
              run,
              status,
              `Managed Session invocation ${run.execution.invocationId} ${invocationStatus}.`,
              task.outputEvidenceRefs,
              {
                failureKind: invocationStatus === "failed" ? "runtime_error" : "runtime_cancelled",
              },
            ),
          );
          graph.setTaskStatus(task.ref, status === "failed" ? "failed" : "cancelled");
          result.terminal += 1;
          result[status] += 1;
        }
      }
      return result;
    },
    { createIfMissing: false },
  );
  const graph = reconciled.graph;
  if (graph) {
    const closeRequests = active.flatMap((previous) => {
      const run = graph.runs(input.projectRef).find((candidate) => candidate.ref === previous.ref);
      if (!run?.execution || run.status === "queued" || run.status === "running") return [];
      const task = graph.getTask(run.taskRef);
      const revisionEnded =
        task.status === "done" || task.status === "failed" || task.status === "cancelled";
      if (run.execution.sessionLifetime !== "task_run" && !revisionEnded) return [];
      const sessionId = taskExecutionSessionId(run.execution);
      return [
        {
          sessionId,
          completion: taskSessionCloseCandidate(graph, input.projectRef, task, run, sessionId),
        },
      ];
    });
    await Promise.all(
      [...new Map(closeRequests.map((request) => [request.sessionId, request])).values()].map(
        async ({ sessionId, completion }) =>
          await daemonRequest("session.close", {
            sessionId,
            reason: `Task execution owner settled in project ${input.projectRef}`,
            ...(completion ? { completion } : {}),
          }),
      ),
    );
  }
  return reconciled.result;
}

function taskSessionCloseCandidate(
  graph: TaskGraph,
  projectRef: ProjectRef,
  task: Task,
  finalRun: TaskRun,
  sessionId: string,
): SparkSessionCloseCandidate | undefined {
  const runs =
    finalRun.execution?.sessionLifetime === "task_revision"
      ? graph.runs(projectRef).filter((run) => {
          if (!run.execution || run.status === "queued" || run.status === "running") return false;
          return taskExecutionSessionId(run.execution) === sessionId;
        })
      : [finalRun];
  const sourceInvocationIds = unique(
    runs.flatMap((run) => (run.execution?.invocationId ? [run.execution.invocationId] : [])),
  ).slice(0, 64);
  if (sourceInvocationIds.length === 0) return undefined;
  const summary = finalRun.completionSummary;
  const outcome = summary?.outcome ?? finalRun.outcome;
  const status = finalRun.status === "succeeded" ? "completed" : finalRun.status;
  if (
    status !== "completed" &&
    status !== "blocked" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    return undefined;
  }
  const evidenceRefs = unique(
    runs.flatMap((run) => [
      ...run.outputEvidenceRefs,
      ...(run.completionSummary?.evidenceRefs ?? []),
    ]),
  ).slice(0, 64);
  const nextAction = boundCloseText(outcome?.nextAction, 2_048);
  return {
    source: "domain_completion",
    status,
    code: normalizeTaskCloseCode(outcome?.code ?? `task_session_${status}`),
    summary:
      boundCloseText(summary?.summary) ??
      `Task ${task.ref} ${status === "completed" ? "completed" : status}.`,
    ...(nextAction ? { nextAction } : {}),
    evidenceRefs,
    artifactRefs: unique(task.artifactRefs).slice(0, 32),
    sourceInvocationIds,
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function boundCloseText(value: string | undefined, maxLength = 4_096): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength).trim() : undefined;
}

function normalizeTaskCloseCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "");
  return (/^[a-z]/u.test(normalized) ? normalized : `task_${normalized || "failed"}`).slice(0, 128);
}

function reserveTaskSessionRuns(
  graph: TaskGraph,
  input: ManagedTaskSessionDispatchInput,
  taskRefs: TaskRef[],
  fleetTargets?: Map<TaskRef, ResolvedFleetTarget>,
): ReservedTaskSessionRun[] {
  const ready = new Set(graph.readyTasks(input.projectRef).map((task) => task.ref));
  const projectRuns = graph.runs(input.projectRef);
  const activeFleetLanes = new Set(
    projectRuns
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => run.execution?.workerLaneKey)
      .filter((lane): lane is string => Boolean(lane)),
  );
  for (const taskRef of taskRefs) {
    const task = graph.getTask(taskRef);
    if (task.projectRef !== input.projectRef) {
      throw new Error(`task ${taskRef} does not belong to project ${input.projectRef}`);
    }
    const recoverableReservation = projectRuns.find(
      (run) =>
        run.taskRef === taskRef &&
        run.status === "queued" &&
        run.execution !== undefined &&
        run.execution.invocationId === undefined,
    );
    if (recoverableReservation) continue;
    const historicalRuns = projectRuns.filter((run) => run.taskRef === taskRef && !run.dryRun);
    const attempt = historicalRuns.length + 1;
    const maxAttempts = task.executionPolicy?.maxAttempts ?? 2;
    if (attempt > maxAttempts) {
      throw new ManagedTaskSessionDispatchRefusal(
        `task ${taskRef} reached maxAttempts=${maxAttempts}; immutable run history requires attempt=${attempt}`,
        "attempt_limit",
      );
    }
  }
  const reservations: ReservedTaskSessionRun[] = [];
  for (const taskRef of taskRefs) {
    const task = graph.getTask(taskRef);
    if (task.projectRef !== input.projectRef) {
      throw new Error(`task ${taskRef} does not belong to project ${input.projectRef}`);
    }
    const activeRun = graph
      .runs(input.projectRef)
      .find(
        (run) => run.taskRef === taskRef && (run.status === "queued" || run.status === "running"),
      );
    const roleRef = sparkTaskExecutorRoleRef(task);
    input.registry.get(roleRef);
    const subgoal = input.subgoals?.find((candidate) => candidate.taskRef === taskRef);
    if (subgoal?.status === "done" || subgoal?.status === "cancelled") {
      throw new Error(`subgoal ${subgoal.ref} is already ${subgoal.status}`);
    }
    const definitionDigest = subgoal ? subgoalDefinitionDigest(subgoal) : undefined;
    const jobId = taskSessionJobId({
      task,
      roleRef,
      ...(subgoal
        ? {
            subgoalRef: subgoal.ref,
            planRevision: subgoal.planRevision,
            definitionDigest,
          }
        : {}),
    });
    if (activeRun) {
      if (
        activeRun.status !== "queued" ||
        !activeRun.execution ||
        activeRun.execution.invocationId ||
        activeRun.execution.ownerSessionId !== input.ownerSessionId ||
        activeRun.execution.jobId !== jobId ||
        activeRun.roleRef !== roleRef
      ) {
        throw new Error(`task ${taskRef} already has active run ${activeRun.ref}`);
      }
      // A process may exit after the TaskGraph reservation commits but before
      // turn.submit. Reuse that exact Run, Session, attempt, and idempotency key
      // so restart never creates a second TaskRun or invocation.
      reservations.push({
        run: activeRun,
        roleRef,
        goal: subgoal?.goal ?? task.plan?.objective ?? task.description,
        evidenceRequired: subgoal?.evidenceRequired ?? task.plan?.evidenceRequired ?? [],
        executionPolicy: task.executionPolicy!,
      });
      continue;
    }
    if (!ready.has(taskRef)) throw new Error(`task ${taskRef} is not in the ready frontier`);
    const historicalRuns = projectRuns.filter((run) => run.taskRef === taskRef && !run.dryRun);
    const attempt = historicalRuns.length + 1;
    const executionPolicy = task.executionPolicy;
    const fleetTarget = fleetTargets?.get(taskRef);
    const workerLaneKey = fleetTarget
      ? fleetLaneKey({
          ownerSessionId: input.ownerSessionId,
          projectRef: input.projectRef,
          roleRef,
          primaryArtifactRef: fleetTarget.primaryArtifactRef,
          writableArtifactRefs: fleetTarget.writableArtifactRefs,
        })
      : undefined;
    if (workerLaneKey && activeFleetLanes.has(workerLaneKey)) {
      throw new Error(`Fleet lane ${workerLaneKey} already has an active TaskRun`);
    }
    if (workerLaneKey) activeFleetLanes.add(workerLaneKey);
    const priorInRevision = historicalRuns
      .filter((run) => run.execution?.jobId === jobId)
      .sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""))
      .at(-1);
    const reuseSession = executionPolicy?.sessionLifetime === "task_revision";
    const reusableExecution = reuseSession ? priorInRevision?.execution : undefined;
    const sessionId = workerLaneKey
      ? executionPolicy?.continuity === "fresh"
        ? `sess_fleet_${stableId(`${workerLaneKey}:${jobId}:attempt:${attempt}`)}`
        : `sess_fleet_${stableId(workerLaneKey)}`
      : ((reusableExecution ? taskExecutionSessionId(reusableExecution) : undefined) ??
        `sess_task_${stableId(`${input.projectRef}:${taskRef}:${jobId}:attempt:${attempt}`)}`);
    const sessionGoalId = reusableExecution?.sessionGoalId ?? randomUUID();
    const execution: TaskRunExecutionBinding = {
      ownerSessionId: input.ownerSessionId,
      sessionId,
      executionSessionId: sessionId,
      sessionGoalId,
      sessionLifetime: executionPolicy?.sessionLifetime ?? "task_revision",
      ...(subgoal ? { subgoalRef: subgoal.ref, planRevision: subgoal.planRevision } : {}),
      ...(definitionDigest ? { definitionDigest } : {}),
      jobId,
      attempt,
      ...(workerLaneKey ? { workerLaneKey } : {}),
    };
    const runRef = newRef("run");
    const runName = `${task.name}-attempt-${attempt}`;
    const claimSessionId = sparkSessionKey({ sessionId });
    graph.claimTask(taskRef, {
      kind: "role-run",
      claimedBy: claimSessionId,
      roleRef,
      runName,
      sessionId: claimSessionId,
      runRef,
      leaseMs: 600_000,
    });
    const run: TaskRun = {
      ref: runRef,
      projectRef: input.projectRef,
      taskRef,
      roleRef,
      runName,
      ownerSessionId: input.ownerSessionId,
      execution,
      resourceAllocation: input.resourceAllocations?.[taskRef],
      status: "queued",
      startedAt: nowIso(),
      updatedAt: nowIso(),
      outputEvidenceRefs: [],
    };
    graph.recordRun(run);
    reservations.push({
      run,
      roleRef,
      goal: subgoal?.goal ?? task.plan?.objective ?? task.description,
      evidenceRequired: subgoal?.evidenceRequired ?? task.plan?.evidenceRequired ?? [],
      executionPolicy: task.executionPolicy!,
    });
  }
  return reservations;
}

async function ensureTaskExecutionSession(input: {
  cwd: string;
  ctx: SparkSessionContext;
  projectRef: ProjectRef;
  taskRef: TaskRef;
  runRef: RunRef;
  roleRef: RoleRef;
  role: RoleSpec;
  goal: string;
  evidenceRequired: string[];
  execution: TaskRunExecutionBinding;
  fleetTarget?: ResolvedFleetTarget;
  daemonRequest: typeof requestSparkDaemon;
}): Promise<void> {
  const sessionId = taskExecutionSessionId(input.execution);
  const fleetWorkerTarget =
    input.fleetTarget && input.fleetTarget.writableArtifactRefs.length > 0
      ? input.fleetTarget
      : undefined;
  const owner = await input.daemonRequest("session.get", {
    sessionId: input.execution.ownerSessionId,
  });
  if (owner.scope.kind !== "workspace") {
    throw new Error("TaskRun Sessions require a Workspace-owned supervisor");
  }
  try {
    await input.daemonRequest("session.create", {
      sessionId,
      scope: { kind: "workspace", workspaceId: owner.scope.workspaceId },
      roleBinding: { kind: "explicit", roleRef: input.roleRef },
      ...(fleetWorkerTarget
        ? {
            supervisorSessionId: input.execution.ownerSessionId,
            cwd: fleetWorkerTarget.primaryRoot,
            cwdArtifactRef: fleetWorkerTarget.primaryArtifactRef,
          }
        : {
            ...(owner.cwd ? { cwd: owner.cwd } : {}),
            ...(owner.cwdArtifactRef ? { cwdArtifactRef: owner.cwdArtifactRef } : {}),
          }),
      ...(fleetWorkerTarget && input.execution.workerLaneKey
        ? {
            fleetWorker: {
              ownerSessionId: input.execution.ownerSessionId,
              projectRef: input.projectRef,
              roleRef: input.roleRef,
              laneKey: input.execution.workerLaneKey,
              primaryArtifactRef: fleetWorkerTarget.primaryArtifactRef,
              writableArtifactRefs: fleetWorkerTarget.writableArtifactRefs,
            },
          }
        : {
            taskExecution: {
              ...(input.execution.sessionLifetime === "task_revision"
                ? {
                    ownerKind: "task_revision" as const,
                    revisionRef: input.execution.jobId,
                    originatingRunRef: input.runRef,
                  }
                : {
                    ownerKind: "task_run" as const,
                    runRef: input.runRef,
                  }),
              supervisorSessionId: input.execution.ownerSessionId,
              projectRef: input.projectRef,
              taskRef: input.taskRef,
              sessionGoalId: input.execution.sessionGoalId,
              ...(input.execution.subgoalRef ? { subgoalRef: input.execution.subgoalRef } : {}),
              roleRef: input.roleRef,
              ...(input.execution.planRevision
                ? { planRevision: input.execution.planRevision }
                : {}),
              ...(input.execution.definitionDigest
                ? { definitionDigest: input.execution.definitionDigest }
                : {}),
              jobId: input.execution.jobId,
              attempt: input.execution.attempt,
            },
          }),
    });
  } catch (error) {
    if (!isSessionAlreadyExists(error)) throw error;
    const existing = await input.daemonRequest("session.get", {
      sessionId,
    });
    if (existing.lifecycle !== "open" || existing.placement !== "active") {
      throw new Error(
        `Fleet worker Session ${sessionId} is unavailable after daemon restart: lifecycle=${existing.lifecycle}, placement=${existing.placement}`,
      );
    }
    const bindingMatches = fleetWorkerTarget
      ? existing.owner.kind === "session" &&
        existing.owner.supervisorSessionId === input.execution.ownerSessionId &&
        existing.roleBinding.kind === "explicit" &&
        existing.roleBinding.roleRef === input.roleRef &&
        existing.fleetWorker?.ownerSessionId === input.execution.ownerSessionId &&
        existing.fleetWorker.projectRef === input.projectRef &&
        existing.fleetWorker.roleRef === input.roleRef &&
        existing.fleetWorker.laneKey === input.execution.workerLaneKey &&
        existing.fleetWorker.primaryArtifactRef === fleetWorkerTarget.primaryArtifactRef &&
        sameStrings(
          existing.fleetWorker?.writableArtifactRefs ?? [],
          fleetWorkerTarget.writableArtifactRefs,
        )
      : (existing.owner.kind === "task_run" || existing.owner.kind === "task_revision") &&
        existing.owner.kind ===
          (input.execution.sessionLifetime === "task_revision" ? "task_revision" : "task_run") &&
        existing.owner.jobId === input.execution.jobId &&
        existing.owner.taskRef === input.taskRef &&
        existing.owner.sessionGoalId === input.execution.sessionGoalId &&
        existing.roleBinding.kind === "explicit" &&
        existing.roleBinding.roleRef === input.roleRef;
    if (!bindingMatches) {
      throw new Error(`managed session ${sessionId} has a conflicting owner or execution binding`);
    }
  }
  if (fleetWorkerTarget) return;
  const goal = await setSessionGoal(
    input.cwd,
    { ...input.ctx, sessionId },
    {
      objective: input.goal,
      source: "explicit",
      status: "active",
      goalId: input.execution.sessionGoalId,
    },
  );
  if (goal.goalId !== input.execution.sessionGoalId) {
    throw new Error(`managed session ${sessionId} has a conflicting goal`);
  }
}

async function resolveFleetTargets(
  stateCwd: string,
  store: ReturnType<typeof defaultTaskGraphStore>,
  taskRefs: TaskRef[],
): Promise<Map<TaskRef, ResolvedFleetTarget>> {
  const graph = await store.load();
  if (!graph) throw new Error("Spark task graph is unavailable");
  const entries = await Promise.all(
    taskRefs.map(async (taskRef) => {
      const task = graph.getTask(taskRef);
      return [taskRef, await resolveFleetTaskTarget({ workspaceCwd: stateCwd, task })] as const;
    }),
  );
  return new Map(entries);
}

async function submitFleetTaskRequest(input: {
  daemonRequest: typeof requestSparkDaemon;
  ownerSessionId: string;
  sessionId: string;
  parentInvocationId?: string;
  projectRef: ProjectRef;
  reservation: ReservedTaskSessionRun;
  prompt: string;
}): Promise<{ invocationId: string }> {
  const execution = input.reservation.run.execution;
  if (!execution) throw new Error("Fleet TaskRun has no execution binding");
  const result = await input.daemonRequest("session.send", {
    toSessionId: input.sessionId,
    fromSessionId: input.ownerSessionId,
    kind: "request",
    intent: "fleet.task.execute",
    payload: taskMessageMetadata(input.projectRef, input.reservation),
    idempotencyKey: `${execution.jobId}:attempt:${execution.attempt}`,
    body: input.prompt,
    origin: { surface: "local", host: "daemon" },
    ...(input.parentInvocationId ? { parentInvocationId: input.parentInvocationId } : {}),
    notifyOnCompletion: true,
    source: "tool",
  });
  if (!result.submitted) throw new Error("Fleet request was not admitted as an invocation");
  return result.submitted;
}

function taskAssignment(reservation: ReservedTaskSessionRun) {
  const execution = reservation.run.execution;
  if (!execution) throw new Error("TaskRun has no execution binding");
  return {
    goal: reservation.goal,
    target: {
      sessionId: taskExecutionSessionId(execution),
      role: reservation.roleRef,
    },
    constraints: [
      `Work only on ${reservation.run.taskRef}.`,
      "Do not select, claim, or mutate another Project Task.",
      "Record inspectable evidence and finish the bound task explicitly.",
    ],
    evidence: reservation.evidenceRequired,
    source: { kind: "internal" as const, externalRef: execution.jobId },
    title: `Task execution ${reservation.run.taskRef}`,
  };
}

function taskMessageMetadata(
  projectRef: ProjectRef,
  reservation: ReservedTaskSessionRun,
): Record<string, string | number> {
  const execution = reservation.run.execution;
  if (!execution) throw new Error("TaskRun has no execution binding");
  return {
    kind: "task_execution",
    projectRef,
    taskRef: reservation.run.taskRef,
    runRef: reservation.run.ref,
    jobId: execution.jobId,
    attempt: execution.attempt,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function updateReservedRun(
  cwd: string,
  runRef: RunRef,
  taskRef: TaskRef,
  update: (run: TaskRun) => TaskRun,
): Promise<void> {
  await defaultTaskGraphStore(cwd).update(
    (graph) => {
      const run = graph.runs().find((candidate) => candidate.ref === runRef);
      if (!run) throw new Error(`unknown reserved task run: ${runRef}`);
      const updated = update(run);
      graph.recordRun({ ...updated, updatedAt: nowIso() });
      if (updated.status === "failed" || updated.status === "cancelled") {
        graph.setTaskStatus(taskRef, "failed");
      }
    },
    { createIfMissing: false },
  );
}

function taskSessionJobId(input: {
  task: ReturnType<TaskGraph["getTask"]>;
  roleRef: RoleRef;
  subgoalRef?: SubgoalRef;
  planRevision?: number;
  definitionDigest?: string;
}): string {
  return `task-job:${stableId(
    JSON.stringify({
      taskRef: input.task.ref,
      title: input.task.title,
      description: input.task.description,
      kind: input.task.kind,
      roleRef: input.roleRef,
      plan: input.task.plan,
      executionPolicy: input.task.executionPolicy,
      inputEvidenceRefs: input.task.inputEvidenceRefs,
      subgoalRef: input.subgoalRef,
      planRevision: input.planRevision,
      definitionDigest: input.definitionDigest,
    }),
  )}`;
}

function renderTaskExecutionPrompt(reservation: ReservedTaskSessionRun): string {
  const execution = reservation.run.execution;
  if (!execution) throw new Error(`task run ${reservation.run.ref} has no execution binding`);
  return [
    `Execute the Project Task ${reservation.run.taskRef}.`,
    `Your Session Goal is exactly: ${reservation.goal}`,
    `TaskRun: ${reservation.run.ref}; jobId=${execution.jobId}; attempt=${execution.attempt}.`,
    `Execution policy: sessionLifetime=${reservation.executionPolicy.sessionLifetime}; isolation=${reservation.executionPolicy.isolation}; comparison=${reservation.executionPolicy.comparison}; maxAttempts=${reservation.executionPolicy.maxAttempts}.`,
    reservation.executionPolicy.isolation === "readonly"
      ? "Do not modify repository source or external state."
      : reservation.executionPolicy.isolation === "isolated_worktree"
        ? "Modify source only inside the Task-owned isolated worktree supplied by the owner workflow."
        : `Write experiment outputs only under .spark/task-results/${execution.jobId}/.`,
    ...(reservation.run.resourceAllocation
      ? [
          `Resource lease: ${reservation.run.resourceAllocation.leaseId} on ${reservation.run.resourceAllocation.nodeId}.`,
          reservation.run.resourceAllocation.gpuIds.length > 0
            ? `Use only allocated GPUs: CUDA_VISIBLE_DEVICES=${reservation.run.resourceAllocation.gpuIds.join(",")}.`
            : "This Task has no GPU allocation.",
          reservation.run.resourceAllocation.concurrencyKeys.length > 0
            ? `Held concurrency keys: ${reservation.run.resourceAllocation.concurrencyKeys.join(", ")}.`
            : "No concurrency keys are held.",
        ]
      : []),
    reservation.evidenceRequired.length > 0
      ? `Required evidence: ${reservation.evidenceRequired.join("; ")}`
      : "Record inspectable evidence appropriate to the Task.",
    "Stay within this Task. When complete, call task_write with action=finish and include the evidence refs.",
    "If blocked, finish the Task as failed with a concrete summary; do not claim or mutate another Task.",
  ].join("\n");
}

function terminalManagedRun(
  run: TaskRun,
  status: "succeeded" | "blocked" | "failed" | "cancelled",
  summary: string,
  evidenceRefs: TaskRun["outputEvidenceRefs"],
  extra: Pick<TaskRun, "failureKind"> = {},
): TaskRun {
  const timestamp = nowIso();
  return {
    ...run,
    ...extra,
    status,
    errorMessage: status === "succeeded" ? undefined : summary,
    finishedAt: timestamp,
    outputEvidenceRefs: [...evidenceRefs],
    completionSummary: {
      runRef: run.ref,
      taskRef: run.taskRef,
      roleRef: run.roleRef,
      runName: run.runName,
      status,
      summary,
      evidenceRefs: [...evidenceRefs],
      createdAt: timestamp,
    },
  };
}

function emptyReconcileResult(): ManagedTaskSessionReconcileResult {
  return {
    inspected: 0,
    terminal: 0,
    succeeded: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
    superseded: 0,
  };
}

function taskRunTimedOut(run: TaskRun, timeoutMs: number): boolean {
  if (run.timeoutRequestedAt) return true;
  const startedAt = Date.parse(run.startedAt ?? "");
  return Number.isFinite(startedAt) && Date.now() - startedAt >= timeoutMs;
}

/** Decode old TaskRun snapshots once; active dispatch consumes the canonical sessionId. */
function taskExecutionSessionId(execution: TaskRunExecutionBinding): string {
  const sessionId = execution.sessionId ?? execution.executionSessionId;
  if (!sessionId?.trim()) throw new Error("task execution binding sessionId is required");
  return sessionId;
}

function isSessionAlreadyExists(error: unknown): boolean {
  return (
    error instanceof SparkDaemonRemoteError &&
    isRecord(error.payload) &&
    error.payload.code === "session_exists"
  );
}

function isSessionAlreadyClosed(error: unknown): boolean {
  return (
    error instanceof SparkDaemonRemoteError &&
    isRecord(error.payload) &&
    (error.payload.code === "session_closed" || error.payload.code === "session_closing")
  );
}

function isSessionNotFound(error: unknown): boolean {
  return (
    error instanceof SparkDaemonRemoteError &&
    isRecord(error.payload) &&
    error.payload.code === "session_not_found"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
