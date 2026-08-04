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
import type { RoleRegistry } from "@zendev-lab/spark-roles";
import { sparkTaskExecutorRoleRef } from "@zendev-lab/spark-runtime";
import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkReproSubgoal } from "./spark-session-repro.ts";

export interface ManagedTaskSessionDispatchInput {
  cwd: string;
  ctx: SparkSessionContext;
  ownerSessionId: string;
  projectRef: ProjectRef;
  taskRefs: TaskRef[];
  registry: RoleRegistry;
  subgoals?: readonly SparkReproSubgoal[];
  resourceAllocations?: Partial<Record<TaskRef, TaskResourceAllocation>>;
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

interface ReservedTaskSessionRun {
  run: TaskRun;
  roleRef: RoleRef;
  goal: string;
  evidenceRequired: string[];
  executionPolicy: TaskExecutionPolicy;
  relation: {
    subgoalRef?: SubgoalRef;
    planRevision?: number;
    definitionDigest?: string;
  };
}

export async function dispatchManagedTaskSessions(
  input: ManagedTaskSessionDispatchInput,
): Promise<ManagedTaskSessionDispatchRecord[]> {
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const daemonRequest = input.daemonRequest ?? requestSparkDaemon;
  const store = defaultTaskGraphStore(stateCwd);
  const uniqueTaskRefs = [...new Set(input.taskRefs)];
  if (uniqueTaskRefs.length === 0) return [];
  const reserved = await store.update(
    (graph) => reserveTaskSessionRuns(graph, input, uniqueTaskRefs),
    { createIfMissing: false },
  );
  if (!reserved.graph) throw new Error("Spark task graph is unavailable");

  const records: ManagedTaskSessionDispatchRecord[] = [];
  for (const reservation of reserved.result) {
    try {
      const execution = reservation.run.execution;
      if (!execution) throw new Error(`task run ${reservation.run.ref} has no execution binding`);
      await ensureTaskExecutionSession({
        cwd: input.cwd,
        ctx: input.ctx,
        projectRef: input.projectRef,
        taskRef: reservation.run.taskRef,
        runRef: reservation.run.ref,
        roleRef: reservation.roleRef,
        goal: reservation.goal,
        evidenceRequired: reservation.evidenceRequired,
        execution,
        daemonRequest,
      });
      const submitted = await daemonRequest("turn.submit", {
        sessionId: execution.executionSessionId,
        prompt: renderTaskExecutionPrompt(reservation),
        idempotencyKey: `${execution.jobId}:attempt:${execution.attempt}`,
        assignment: {
          goal: reservation.goal,
          target: {
            sessionId: execution.executionSessionId,
            role: reservation.roleRef,
          },
          constraints: [
            `Work only on ${reservation.run.taskRef}.`,
            "Do not select, claim, or mutate another Project Task.",
            "Record inspectable evidence and finish the bound task explicitly.",
          ],
          evidence: reservation.evidenceRequired,
          source: { kind: "internal", externalRef: execution.jobId },
          title: `Task execution ${reservation.run.taskRef}`,
        },
        messageMetadata: {
          kind: "task_execution",
          projectRef: input.projectRef,
          taskRef: reservation.run.taskRef,
          runRef: reservation.run.ref,
          jobId: execution.jobId,
          attempt: execution.attempt,
        },
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
        sessionId: execution.executionSessionId,
        goalId: execution.sessionGoalId,
        jobId: execution.jobId,
        attempt: execution.attempt,
        invocationId: submitted.invocationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
  subgoals?: readonly SparkReproSubgoal[];
  daemonRequest?: typeof requestSparkDaemon;
}): Promise<ManagedTaskSessionReconcileResult> {
  const stateCwd = sparkStateCwd(input.cwd, input.ctx);
  const store = defaultTaskGraphStore(stateCwd);
  const snapshot = await store.load();
  const active =
    snapshot
      ?.runs(input.projectRef)
      .filter((run) => run.execution && (run.status === "queued" || run.status === "running")) ??
    [];
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
  return reconciled.result;
}

function reserveTaskSessionRuns(
  graph: TaskGraph,
  input: ManagedTaskSessionDispatchInput,
  taskRefs: TaskRef[],
): ReservedTaskSessionRun[] {
  const ready = new Set(graph.readyTasks(input.projectRef).map((task) => task.ref));
  const reservations: ReservedTaskSessionRun[] = [];
  for (const taskRef of taskRefs) {
    const task = graph.getTask(taskRef);
    if (task.projectRef !== input.projectRef) {
      throw new Error(`task ${taskRef} does not belong to project ${input.projectRef}`);
    }
    if (!ready.has(taskRef)) throw new Error(`task ${taskRef} is not in the ready frontier`);
    const activeRun = graph
      .runs(input.projectRef)
      .find(
        (run) => run.taskRef === taskRef && (run.status === "queued" || run.status === "running"),
      );
    if (activeRun) throw new Error(`task ${taskRef} already has active run ${activeRun.ref}`);

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
    const prior = graph
      .runs(input.projectRef)
      .filter((run) => run.taskRef === taskRef && run.execution?.jobId === jobId)
      .sort((left, right) => (left.execution?.attempt ?? 0) - (right.execution?.attempt ?? 0))
      .at(-1);
    const attempt = (prior?.execution?.attempt ?? 0) + 1;
    const executionPolicy = task.executionPolicy;
    if (attempt > (executionPolicy?.maxAttempts ?? 2)) {
      throw new Error(
        `task ${taskRef} reached maxAttempts=${executionPolicy?.maxAttempts ?? 2} for ${jobId}`,
      );
    }
    const reuseSession = executionPolicy?.continuity !== "fresh";
    const executionSessionId =
      (reuseSession ? prior?.execution?.executionSessionId : undefined) ??
      `sess_task_${stableId(
        `${input.projectRef}:${taskRef}:${jobId}:${reuseSession ? "stable" : attempt}`,
      )}`;
    const sessionGoalId =
      (reuseSession ? prior?.execution?.sessionGoalId : undefined) ?? randomUUID();
    const execution: TaskRunExecutionBinding = {
      ownerSessionId: input.ownerSessionId,
      executionSessionId,
      sessionGoalId,
      ...(subgoal ? { subgoalRef: subgoal.ref, planRevision: subgoal.planRevision } : {}),
      ...(definitionDigest ? { definitionDigest } : {}),
      jobId,
      attempt,
    };
    const runRef = newRef("run");
    const runName = `${task.name}-attempt-${attempt}`;
    const claimSessionId = sparkSessionKey({ sessionId: executionSessionId });
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
      outputEvidenceRefs: [],
    };
    graph.recordRun(run);
    reservations.push({
      run,
      roleRef,
      goal: subgoal?.goal ?? task.plan?.objective ?? task.description,
      evidenceRequired: subgoal?.evidenceRequired ?? task.plan?.evidenceRequired ?? [],
      executionPolicy: task.executionPolicy!,
      relation: {
        ...(subgoal
          ? {
              subgoalRef: subgoal.ref,
              planRevision: subgoal.planRevision,
              definitionDigest,
            }
          : {}),
      },
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
  goal: string;
  evidenceRequired: string[];
  execution: TaskRunExecutionBinding;
  daemonRequest: typeof requestSparkDaemon;
}): Promise<void> {
  const owner = await input.daemonRequest("session.get", {
    sessionId: input.execution.ownerSessionId,
  });
  try {
    await input.daemonRequest("session.create", {
      sessionId: input.execution.executionSessionId,
      scope:
        owner.scope.kind === "workspace"
          ? { kind: "workspace", workspaceId: owner.scope.workspaceId }
          : { kind: "daemon" },
      role: input.roleRef,
      ...(owner.cwd ? { cwd: owner.cwd } : {}),
      ...(owner.cwdArtifactRef ? { cwdArtifactRef: owner.cwdArtifactRef } : {}),
      taskExecution: {
        ownerSessionId: input.execution.ownerSessionId,
        projectRef: input.projectRef,
        taskRef: input.taskRef,
        runRef: input.runRef,
        sessionGoalId: input.execution.sessionGoalId,
        ...(input.execution.subgoalRef ? { subgoalRef: input.execution.subgoalRef } : {}),
        roleRef: input.roleRef,
        ...(input.execution.planRevision ? { planRevision: input.execution.planRevision } : {}),
        ...(input.execution.definitionDigest
          ? { definitionDigest: input.execution.definitionDigest }
          : {}),
        jobId: input.execution.jobId,
        attempt: input.execution.attempt,
      },
    });
  } catch (error) {
    if (!isSessionAlreadyExists(error)) throw error;
    const existing = await input.daemonRequest("session.get", {
      sessionId: input.execution.executionSessionId,
    });
    if (
      existing.relation?.kind !== "task_execution" ||
      existing.relation.jobId !== input.execution.jobId ||
      existing.relation.taskRef !== input.taskRef ||
      existing.relation.sessionGoalId !== input.execution.sessionGoalId
    ) {
      throw new Error(
        `managed session ${input.execution.executionSessionId} has a conflicting relation`,
      );
    }
  }
  const goal = await setSessionGoal(
    input.cwd,
    { ...input.ctx, sessionId: input.execution.executionSessionId },
    {
      objective: input.goal,
      source: "explicit",
      status: "active",
      goalId: input.execution.sessionGoalId,
    },
  );
  if (goal.goalId !== input.execution.sessionGoalId) {
    throw new Error(`managed session ${input.execution.executionSessionId} has a conflicting goal`);
  }
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
      graph.recordRun(updated);
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
    `Execution policy: continuity=${reservation.executionPolicy.continuity}; isolation=${reservation.executionPolicy.isolation}; comparison=${reservation.executionPolicy.comparison}; maxAttempts=${reservation.executionPolicy.maxAttempts}.`,
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

function isSessionAlreadyExists(error: unknown): boolean {
  return (
    error instanceof SparkDaemonRemoteError &&
    isRecord(error.payload) &&
    error.payload.code === "session_exists"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
