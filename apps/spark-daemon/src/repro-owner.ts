import { createHash } from "node:crypto";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { EvidenceRef, RoleRef, RunRef } from "@zendev-lab/spark-invocation";
import { type TaskRun } from "@zendev-lab/spark-tasks";
import {
  acceptSparkReproLaneResult,
  activateSparkReproV10,
  answerSparkReproAttention,
  bindSparkReproCheckpointRun,
  blockSparkReproV10,
  createSparkReproV10,
  currentSparkReproCheckpoint,
  migrateSparkSessionReproV9,
  stopSparkReproV10,
  type SparkReproCheckpoint,
  type SparkReproFrozenModel,
  type SparkReproLane,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import {
  createAutonomousAskInteractionRequestId,
  parseSparkModelValue,
  type SparkEvidenceAnswerEvent,
  type SparkSessionReproWorkView,
} from "@zendev-lab/spark-protocol";
import {
  createSparkRoleRegistry,
  defaultProjectRoleModelSettingsStore,
  defaultUserRoleModelSettingsStore,
  resolveRoleModelSetting,
} from "@zendev-lab/spark-roles";
import {
  sparkSessionWorkspaceState,
  updateSparkSessionWorkspaceState,
} from "@zendev-lab/spark-driver";
import { defaultTaskGraphStore, isUnfinishedTaskStatus } from "@zendev-lab/spark-tasks";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import type { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { humanAnswerEvidenceRef } from "./core/human-answer-evidence.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { SparkReproV10Store } from "./store/repro-v10.ts";
import type { DatabaseSync } from "node:sqlite";
import type { SparkDaemonWorkspace } from "./store/workspaces.js";

export const SPARK_REPRO_LANE_ROLE_REFS = {
  implementation: "role:extension-repro-implementation-explorer",
  exactness: "role:extension-repro-exactness-instrumentation-worker",
  formalize: "role:extension-repro-precision-fixer",
} as const satisfies Record<SparkReproLane, RoleRef>;

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "blocked", "failed", "cancelled", "stale"]);

export interface SparkReproOwnerOptions {
  db: DatabaseSync;
  workspace: SparkDaemonWorkspace;
  sessionRegistry: DaemonSessionRegistry;
  sessionSupervisor?: SessionSupervisor;
  modelControl: SparkDaemonModelControl;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  submitTurn(input: {
    sessionId: string;
    prompt: string;
    idempotencyKey: string;
    assignment: {
      goal: string;
      target: { sessionId: string; role: RoleRef };
      constraints: string[];
      evidence: string[];
      source: { kind: "internal"; externalRef: string };
      title: string;
    };
    messageMetadata: Record<string, unknown>;
  }): Promise<{ invocationId: string }>;
  onProjectionNeeded?: (repro: SparkSessionRepro) => void | Promise<void>;
}

export class SparkReproOwner {
  readonly #options: SparkReproOwnerOptions;
  readonly #store: SparkReproV10Store;

  constructor(options: SparkReproOwnerOptions) {
    this.#options = options;
    this.#store = new SparkReproV10Store(options.db);
  }

  async start(input: {
    ownerSessionId: string;
    objective: string;
    reproId?: string;
  }): Promise<{ repro: SparkSessionRepro; changed: boolean }> {
    const preflight = await this.#preflight(input.ownerSessionId);
    const reproId =
      input.reproId ??
      `repro:${stableId(this.#options.workspace.id, input.ownerSessionId, input.objective.trim())}`;
    const intent = createSparkReproV10({
      reproId,
      ownerSessionId: input.ownerSessionId,
      workspaceId: this.#options.workspace.id,
      objective: input.objective,
      laneRoles: SPARK_REPRO_LANE_ROLE_REFS,
      laneModels: preflight.models,
      now: now(),
    });
    const inserted = this.#store.insertIntent(intent);
    let repro = inserted.state;
    if (repro.status === "provisioning") {
      await this.#ensureTopology(repro);
      const activated = activateSparkReproV10(repro, now());
      if (!this.#store.replace(activated, repro.updatedAt)) {
        repro = this.#store.get(repro.reproId) ?? activated;
      } else {
        repro = activated;
      }
    }
    if (repro.status === "active") repro = await this.#ensureCurrentRun(repro);
    await this.#project(repro);
    return { repro, changed: inserted.changed || repro !== inserted.state };
  }

  status(ownerSessionId: string): SparkSessionRepro | undefined {
    return this.#store.currentForOwner(ownerSessionId);
  }

  async migrateV9(
    ownerSessionId: string,
    legacy: unknown,
  ): Promise<{ repro: SparkSessionRepro; changed: boolean }> {
    const preflight = await this.#preflight(ownerSessionId);
    const migrated = migrateSparkSessionReproV9(legacy, {
      ownerSessionId,
      workspaceId: this.#options.workspace.id,
      laneRoles: SPARK_REPRO_LANE_ROLE_REFS,
      laneModels: preflight.models,
      now: now(),
    });
    const inserted = this.#store.insertIntent(migrated);
    if (inserted.changed) await this.#project(inserted.state);
    return { repro: inserted.state, changed: inserted.changed };
  }

  async reconcile(reproId: string): Promise<{ repro: SparkSessionRepro; changed: boolean }> {
    let current = this.#store.get(reproId);
    if (!current) throw new Error(`unknown Repro ${reproId}`);
    let changed = false;
    if (current.status === "provisioning") {
      await this.#ensureTopology(current);
      const activated = activateSparkReproV10(current, now());
      if (this.#store.replace(activated, current.updatedAt)) {
        current = activated;
        changed = true;
      } else {
        current = this.#store.get(reproId) ?? activated;
      }
    }
    if (current.status === "waiting_attention") {
      await this.#ensureAttention(current);
      await this.#project(current);
      return { repro: current, changed };
    }
    if (current.status === "stopped") {
      await this.#cleanupStopped(current, "Repro stopped by user");
      await this.#project(current);
      return { repro: current, changed };
    }
    if (current.status !== "active") {
      await this.#project(current);
      return { repro: current, changed };
    }

    const beforeDispatch = current;
    current = await this.#ensureCurrentRun(current);
    if (current !== beforeDispatch) changed = true;
    const checkpoint = currentSparkReproCheckpoint(current);
    if (!checkpoint?.runRef || checkpoint.status !== "running") {
      await this.#project(current);
      return { repro: current, changed };
    }
    const graphStore = defaultTaskGraphStore(this.#options.workspace.localPath);
    let graph = await graphStore.load();
    let run = graph
      ?.runs(current.projectRef)
      .find((candidate) => candidate.ref === checkpoint.runRef);
    if (!run)
      return await this.#blockRejectedRun(current, `TaskRun ${checkpoint.runRef} is missing`);
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      const task = graph?.getTask(run.taskRef);
      if (
        task &&
        (task.status === "done" || task.status === "failed" || task.status === "cancelled")
      ) {
        const evidenceStore = defaultEvidenceStore(this.#options.workspace.localPath);
        const evidenceRecords = await Promise.all(
          task.outputEvidenceRefs.map(async (ref) => ({
            ref,
            record: await evidenceStore.tryGet(ref),
          })),
        );
        const terminalEvidenceRefs = new Set(
          evidenceRecords
            .filter(
              ({ record }) =>
                record?.provenance.taskRef === checkpoint.taskRef &&
                record.provenance.runRef === checkpoint.runRef,
            )
            .map(({ ref }) => ref),
        );
        const timestamp = now();
        const updated = await graphStore.update(
          (mutable) => {
            const latest = mutable
              .runs(current.projectRef)
              .find((candidate) => candidate.ref === checkpoint.runRef);
            if (!latest || TERMINAL_RUN_STATUSES.has(latest.status)) return latest;
            const latestTask = mutable.getTask(latest.taskRef);
            if (
              latestTask.status !== "done" &&
              latestTask.status !== "failed" &&
              latestTask.status !== "cancelled"
            ) {
              return latest;
            }
            const status =
              latestTask.status === "done"
                ? "succeeded"
                : latestTask.status === "failed"
                  ? "failed"
                  : "cancelled";
            const summary = `Repro checkpoint Task ${latestTask.ref} finished with status ${latestTask.status}.`;
            const outputEvidenceRefs = latestTask.outputEvidenceRefs.filter((ref) =>
              terminalEvidenceRefs.has(ref),
            );
            return mutable.recordRun({
              ...latest,
              status,
              ...(status === "succeeded"
                ? { errorMessage: undefined, failureKind: undefined }
                : {
                    errorMessage: summary,
                    failureKind: status === "cancelled" ? "runtime_cancelled" : "runtime_error",
                  }),
              outputEvidenceRefs,
              completionSummary: {
                runRef: latest.ref,
                taskRef: latest.taskRef,
                roleRef: latest.roleRef,
                runName: latest.runName,
                status,
                summary,
                evidenceRefs: outputEvidenceRefs,
                createdAt: timestamp,
              },
              finishedAt: timestamp,
              updatedAt: timestamp,
            });
          },
          { createIfMissing: false },
        );
        graph = updated.graph;
        run = graph
          ?.runs(current.projectRef)
          .find((candidate) => candidate.ref === checkpoint.runRef);
      }
    }
    if (!run)
      return await this.#blockRejectedRun(current, `TaskRun ${checkpoint.runRef} disappeared`);
    if (!TERMINAL_RUN_STATUSES.has(run.status) && run.execution?.invocationId) {
      const invocation = new SparkInvocationStore(this.#options.db).getSummary(
        run.execution.invocationId,
      );
      if (invocation && isTerminalInvocationStatus(invocation.status)) {
        const terminalStatus = invocation.status === "cancelled" ? "cancelled" : "failed";
        const message =
          invocation.status === "succeeded"
            ? "daemon Invocation completed without a terminal TaskRun lane-result envelope"
            : `daemon Invocation ended with status ${invocation.status}`;
        const updated = await graphStore.update(
          (mutable) => {
            const latest = mutable
              .runs(current.projectRef)
              .find((candidate) => candidate.ref === checkpoint.runRef);
            if (!latest || TERMINAL_RUN_STATUSES.has(latest.status)) return latest;
            return mutable.recordRun({
              ...latest,
              status: terminalStatus,
              failureKind: terminalStatus === "cancelled" ? "runtime_cancelled" : "runtime_error",
              errorMessage: message,
              finishedAt: now(),
              updatedAt: now(),
            });
          },
          { createIfMissing: false },
        );
        graph = updated.graph;
        run = graph
          ?.runs(current.projectRef)
          .find((candidate) => candidate.ref === checkpoint.runRef);
      }
    }
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) {
      await this.#project(current);
      return { repro: current, changed };
    }
    try {
      return { repro: await this.ingestTerminalTaskRun(run), changed: true };
    } catch (error) {
      return await this.#blockRejectedRun(
        current,
        `Rejected terminal TaskRun ${run.ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async stop(ownerSessionId: string, reason = "Repro stopped by user"): Promise<SparkSessionRepro> {
    const current = this.#store.currentForOwner(ownerSessionId);
    if (!current) throw new Error("no Repro is owned by this Session");
    const stopped = current.status === "stopped" ? current : stopSparkReproV10(current, now());
    if (stopped !== current && !this.#store.replace(stopped, current.updatedAt)) {
      throw new Error("Repro changed while stopping");
    }
    await this.#cleanupStopped(stopped, reason);
    await this.#project(stopped);
    return stopped;
  }

  async #cleanupStopped(repro: SparkSessionRepro, reason: string): Promise<void> {
    const invocations = new SparkInvocationStore(this.#options.db);
    const graphStore = defaultTaskGraphStore(this.#options.workspace.localPath);
    const graph = await graphStore.load();
    for (const run of graph?.runs(repro.projectRef) ?? []) {
      if (
        run.execution?.ownerSessionId !== repro.ownerSessionId ||
        TERMINAL_RUN_STATUSES.has(run.status)
      ) {
        continue;
      }
      if (run.execution.invocationId) {
        invocations.requestCancellation(run.execution.invocationId, reason);
      }
    }
    await graphStore.update(
      (mutable) => {
        const timestamp = now();
        for (const run of mutable.runs(repro.projectRef)) {
          if (
            run.execution?.ownerSessionId !== repro.ownerSessionId ||
            TERMINAL_RUN_STATUSES.has(run.status)
          ) {
            continue;
          }
          mutable.recordRun({
            ...run,
            status: "cancelled",
            failureKind: "runtime_cancelled",
            errorMessage: reason,
            finishedAt: timestamp,
            updatedAt: timestamp,
          });
        }
        for (const lane of Object.values(repro.lanes)) {
          const task = mutable.getTask(lane.taskRef);
          if (!isUnfinishedTaskStatus(task.status)) continue;
          mutable.setTaskStatus(task.ref, "cancelled", {
            cancelledBy: repro.ownerSessionId,
            cancellationReason: reason,
          });
        }
      },
      { createIfMissing: false },
    );
    for (const lane of Object.values(repro.lanes)) {
      const session = await this.#options.sessionRegistry.get(lane.sessionId);
      if (!session || session.lifecycle === "closed") continue;
      if (this.#options.sessionSupervisor) {
        await this.#options.sessionSupervisor.close({ sessionId: lane.sessionId, reason });
      } else {
        await this.#options.sessionRegistry.close({ sessionId: lane.sessionId, reason });
      }
    }
  }

  async ingestTerminalTaskRun(run: TaskRun): Promise<SparkSessionRepro> {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`TaskRun ${run.ref} is not terminal`);
    }
    const current = this.#store.currentForOwner(run.execution?.ownerSessionId ?? "");
    if (!current) throw new Error(`TaskRun ${run.ref} has no Repro owner`);
    const checkpoint = currentSparkReproCheckpoint(current);
    if (!checkpoint || checkpoint.runRef !== run.ref) {
      throw new Error(`TaskRun ${run.ref} is not the current Repro checkpoint attempt`);
    }
    if (
      run.taskRef !== checkpoint.taskRef ||
      (run.execution?.sessionId ?? run.execution?.executionSessionId) !== checkpoint.sessionId
    ) {
      throw new Error("terminal TaskRun envelope does not match Repro checkpoint provenance");
    }
    const runEvidenceRefs = new Set([
      ...run.outputEvidenceRefs,
      ...(run.completionSummary?.evidenceRefs ?? []),
    ]);
    const evidenceStore = defaultEvidenceStore(this.#options.workspace.localPath);
    let accepted: SparkSessionRepro | undefined;
    for (const evidenceRef of [...runEvidenceRefs].sort()) {
      const carrier = await evidenceStore.tryGet(evidenceRef);
      if (!carrier || carrier.format !== "json" || !isRecord(carrier.body)) continue;
      if (carrier.body.schema !== "spark.repro.lane-result/v2") continue;
      const result = carrier.body;
      const referenced = Array.isArray(result.evidenceRefs)
        ? result.evidenceRefs.filter((ref): ref is EvidenceRef => typeof ref === "string")
        : [];
      const records = await Promise.all(referenced.map((ref) => evidenceStore.tryGet(ref)));
      const carrierMatches =
        carrier.provenance.runRef === run.ref &&
        carrier.provenance.taskRef === run.taskRef &&
        runEvidenceRefs.has(evidenceRef);
      const referencesMatch = referenced.every((ref, index) => {
        const record = records[index];
        return (
          runEvidenceRefs.has(ref) &&
          record?.provenance.runRef === run.ref &&
          record.provenance.taskRef === run.taskRef
        );
      });
      if (!carrierMatches || !referencesMatch) {
        throw new Error("Repro lane result Evidence is not wholly bound to its terminal TaskRun");
      }
      accepted = acceptSparkReproLaneResult(current, result, now());
      break;
    }
    if (!accepted) throw new Error(`TaskRun ${run.ref} has no spark.repro.lane-result/v2 Evidence`);
    if (!this.#store.replace(accepted, current.updatedAt)) {
      const replayed = this.#store.get(current.reproId);
      if (replayed?.receipts.some((receipt) => receipt.runRef === run.ref)) return replayed;
      throw new Error("Repro checkpoint changed while accepting terminal TaskRun");
    }
    if (accepted.status === "waiting_attention") await this.#ensureAttention(accepted);
    const advanced =
      accepted.status === "active" ? await this.#ensureCurrentRun(accepted) : accepted;
    await this.#project(advanced);
    return advanced;
  }

  async resumeAnswer(event: SparkEvidenceAnswerEvent): Promise<SparkSessionRepro | undefined> {
    if (event.binding.modeScope !== "repro") return undefined;
    const current = this.#store.get(event.binding.goalOrReproId);
    if (!current || current.status !== "waiting_attention") return current;
    const checkpoint = currentSparkReproCheckpoint(current);
    if (!checkpoint || checkpoint.checkpointId !== event.binding.ownerStepOrUnresolvedId) {
      throw new Error("Repro AnswerEvent does not match the current checkpoint");
    }
    const resumed = answerSparkReproAttention(current, {
      checkpointId: checkpoint.checkpointId,
      answerEvidenceRef: humanAnswerEvidenceRef(event),
      answerKind: event.binding.expectedAnswerKind as "single" | "multi" | "freeform",
      now: now(),
    });
    if (!this.#store.replace(resumed, current.updatedAt)) {
      throw new Error("Repro checkpoint changed while accepting AnswerEvent");
    }
    const dispatched = await this.#ensureCurrentRun(resumed);
    await this.#project(dispatched);
    return dispatched;
  }

  async #preflight(ownerSessionId: string): Promise<{
    models: Record<SparkReproLane, SparkReproFrozenModel>;
  }> {
    const owner = await this.#options.sessionRegistry.get(ownerSessionId);
    if (!owner || owner.lifecycle !== "open" || owner.scope.kind !== "workspace") {
      throw new Error("Repro owner must be an open Workspace Session");
    }
    if (owner.scope.workspaceId !== this.#options.workspace.id) {
      throw new Error("Repro owner Session belongs to another Workspace");
    }
    const registry = await createSparkRoleRegistry(this.#options.workspace.localPath);
    const inherited = await this.#options.modelControl.effectiveModel(ownerSessionId);
    const thinkingLevel = await this.#options.modelControl.effectiveThinkingLevel(ownerSessionId);
    const models = {} as Record<SparkReproLane, SparkReproFrozenModel>;
    for (const lane of Object.keys(SPARK_REPRO_LANE_ROLE_REFS) as SparkReproLane[]) {
      const roleRef = SPARK_REPRO_LANE_ROLE_REFS[lane];
      const role = registry.get(roleRef);
      if (!role) throw new Error(`required Repro Role is unavailable: ${roleRef}`);
      const configured = await resolveRoleModelSetting({
        roleRef,
        roleId: role.id,
        roleName: role.id,
        modelType: role.modelType,
        projectStore: defaultProjectRoleModelSettingsStore(this.#options.workspace.localPath),
        userStore: defaultUserRoleModelSettingsStore(),
      });
      const model = configured ? parseSparkModelValue(configured.model) : inherited;
      await this.#options.modelControl.prepareModel(model);
      models[lane] = {
        provider: model.providerName,
        model: model.modelId,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    }
    return { models };
  }

  async #ensureTopology(repro: SparkSessionRepro): Promise<void> {
    await defaultTaskGraphStore(this.#options.workspace.localPath).update(
      (graph) => {
        graph.ensureProject(repro.projectRef, {
          title: `Repro · ${repro.objective}`,
          description: `Daemon-owned Repro v10 topology for ${repro.reproId}`,
          kind: "repro",
          kindState: { reproId: repro.reproId, version: 10 },
        });
        for (const lane of Object.values(repro.lanes)) {
          graph.ensureTask(lane.taskRef, {
            projectRef: repro.projectRef,
            name: `repro-${lane.lane}-${stableId(repro.reproId).slice(0, 8)}`,
            title: `${lane.lane} · ${repro.objective}`,
            description: `Execute the ${lane.lane} lane for ${repro.workItem.workItemId}.`,
            kind: "implement",
            status: "ready",
            roleRef: lane.roleRef,
            plan: {
              objective: `Produce accepted ${lane.lane} checkpoint Evidence for ${repro.objective}`,
              contextRefs: [],
              constraints: [],
              nonGoals: [],
              steps: [
                `Inspect the Workspace sources required by the ${lane.lane} checkpoint and validate the result against the objective`,
              ],
              successCriteria: [
                `The terminal TaskRun for ${lane.taskRef} validates a strict spark.repro.lane-result/v2 Evidence envelope bound to its Session, TaskRef, and RunRef.`,
              ],
              evidenceRequired: [
                `TaskRun outputEvidenceRefs contain the spark.repro.lane-result/v2 carrier and every Evidence ref declared by that carrier.`,
              ],
              openQuestions: [],
              askRefs: [],
            },
            executionPolicy: {
              maxAttempts: 8,
              timeoutMs: 7_200_000,
              sessionLifetime: "task_revision",
              sessionRetention: "owner_terminal",
              isolation: "workspace",
              comparison: "single_side",
              continuity: "reuse_within_revision",
              concurrencyKeys: [],
            },
          });
          const firstCheckpoint = repro.checkpoints.find(
            (checkpoint) => checkpoint.lane === lane.lane,
          )!;
          const runRef = `run:repro-${stableId(firstCheckpoint.checkpointId, "1")}` as RunRef;
          if (!graph.runs(repro.projectRef).some((run) => run.ref === runRef)) {
            graph.recordRun({
              ref: runRef,
              projectRef: repro.projectRef,
              taskRef: lane.taskRef,
              roleRef: lane.roleRef,
              runName: `${firstCheckpoint.kind}-attempt-1`,
              ownerSessionId: repro.ownerSessionId,
              execution: {
                ownerSessionId: repro.ownerSessionId,
                sessionId: lane.sessionId,
                executionSessionId: lane.sessionId,
                sessionGoalId: `goal:${stableId(repro.reproId, lane.lane)}`,
                sessionLifetime: "task_revision",
                jobId: `repro-checkpoint:${firstCheckpoint.checkpointId}`,
                attempt: 1,
              },
              status: "queued",
              startedAt: now(),
              updatedAt: now(),
              outputEvidenceRefs: [],
            });
          }
        }
      },
      { createIfMissing: true },
    );
    for (const lane of Object.values(repro.lanes)) {
      const firstCheckpoint = repro.checkpoints.find(
        (checkpoint) => checkpoint.lane === lane.lane,
      )!;
      const sessionGoalId = `goal:${stableId(repro.reproId, lane.lane)}`;
      const originatingRunRef = `run:repro-${stableId(
        firstCheckpoint.checkpointId,
        "1",
      )}` as RunRef;
      const existing = await this.#options.sessionRegistry.get(lane.sessionId);
      if (!existing) {
        await this.#options.sessionRegistry.create({
          sessionId: lane.sessionId,
          name: `Repro ${lane.lane}`,
          scope: { kind: "workspace", workspaceId: repro.workspaceId },
          supervisorSessionId: repro.ownerSessionId,
          roleBinding: { kind: "explicit", roleRef: lane.roleRef },
          placement: "child",
          cwd: this.#options.workspace.localPath,
          taskExecution: {
            originKind: "task_revision",
            projectRef: repro.projectRef,
            taskRef: lane.taskRef,
            revisionRef: `repro-lane:${repro.reproId}:${lane.lane}`,
            originatingRunRef,
            sessionGoalId,
            roleRef: lane.roleRef,
            jobId: `repro-checkpoint:${firstCheckpoint.checkpointId}`,
            attempt: 1,
          },
        });
      } else if (
        existing.lineage.kind !== "child" ||
        existing.lineage.parentSessionId !== repro.ownerSessionId ||
        existing.lineage.origin.kind !== "task_revision" ||
        existing.lineage.origin.projectRef !== repro.projectRef ||
        existing.lineage.origin.taskRef !== lane.taskRef ||
        existing.roleBinding.kind !== "explicit" ||
        existing.roleBinding.roleRef !== lane.roleRef
      ) {
        throw new Error(`Repro lane Session identity conflict: ${lane.sessionId}`);
      }
      await this.#options.sessionRegistry.setModel(lane.sessionId, {
        providerName: lane.model.provider,
        modelId: lane.model.model,
      });
      if (lane.model.thinkingLevel) {
        await this.#options.sessionRegistry.setThinkingLevel(
          lane.sessionId,
          lane.model.thinkingLevel as Parameters<DaemonSessionRegistry["setThinkingLevel"]>[1],
        );
      }
      await updateSparkSessionWorkspaceState(
        this.#options.workspace.localPath,
        { sessionId: lane.sessionId },
        (current) =>
          sparkSessionWorkspaceState({
            projectRef: repro.projectRef,
            currentTaskRef: lane.taskRef,
            ...(current?.driverAuthority ? { driverAuthority: current.driverAuthority } : {}),
          }),
      );
    }
  }

  async #ensureCurrentRun(repro: SparkSessionRepro): Promise<SparkSessionRepro> {
    const checkpoint = currentSparkReproCheckpoint(repro);
    if (!checkpoint || checkpoint.status === "accepted" || checkpoint.status === "attention") {
      return repro;
    }
    const attempt = checkpoint.status === "running" ? checkpoint.attempt : checkpoint.attempt + 1;
    const runRef =
      checkpoint.runRef ??
      (`run:repro-${stableId(checkpoint.checkpointId, String(attempt))}` as RunRef);
    const graphStore = defaultTaskGraphStore(this.#options.workspace.localPath);
    const reserved = await graphStore.update(
      (graph) => {
        const existing = graph.runs(repro.projectRef).find((run) => run.ref === runRef);
        if (existing && checkpoint.status === "running") return existing;
        const task = graph.getTask(checkpoint.taskRef);
        if (task.status !== "ready") graph.setTaskStatus(task.ref, "ready");
        const jobId = `repro-checkpoint:${checkpoint.checkpointId}`;
        graph.claimTask(checkpoint.taskRef, {
          kind: "role-run",
          claimedBy: checkpoint.sessionId,
          roleRef: repro.lanes[checkpoint.lane].roleRef,
          runName: `${checkpoint.kind}-attempt-${attempt}`,
          sessionId: checkpoint.sessionId,
          runRef,
          leaseMs: 7_200_000,
        });
        if (existing) return existing;
        return graph.recordRun({
          ref: runRef,
          projectRef: repro.projectRef,
          taskRef: checkpoint.taskRef,
          roleRef: repro.lanes[checkpoint.lane].roleRef,
          runName: `${checkpoint.kind}-attempt-${attempt}`,
          ownerSessionId: repro.ownerSessionId,
          execution: {
            ownerSessionId: repro.ownerSessionId,
            sessionId: checkpoint.sessionId,
            executionSessionId: checkpoint.sessionId,
            sessionGoalId: `goal:${stableId(repro.reproId, checkpoint.lane)}`,
            sessionLifetime: "task_revision",
            jobId,
            attempt,
          },
          status: "queued",
          startedAt: now(),
          updatedAt: now(),
          outputEvidenceRefs: [],
        });
      },
      { createIfMissing: false },
    );
    if (!reserved.graph) throw new Error("Repro TaskGraph is unavailable");
    let bound = repro;
    if (checkpoint.status !== "running") {
      bound = bindSparkReproCheckpointRun(repro, {
        checkpointId: checkpoint.checkpointId,
        runRef,
        now: now(),
      });
      if (!this.#store.replace(bound, repro.updatedAt)) {
        bound = this.#store.get(repro.reproId) ?? bound;
      }
    }
    const run = reserved.graph.runs(repro.projectRef).find((candidate) => candidate.ref === runRef);
    if (!run?.execution) throw new Error(`Repro TaskRun ${runRef} was not reserved`);
    if (!run.execution.invocationId) {
      const submitted = await this.#options.submitTurn({
        sessionId: checkpoint.sessionId,
        prompt: renderCheckpointPrompt(bound, currentSparkReproCheckpoint(bound)!),
        idempotencyKey: `${run.execution.jobId}:attempt:${attempt}`,
        assignment: {
          goal: `${checkpoint.kind}: ${repro.objective}`,
          target: {
            sessionId: checkpoint.sessionId,
            role: repro.lanes[checkpoint.lane].roleRef,
          },
          constraints: [
            `Work only on ${checkpoint.taskRef}.`,
            "Treat Workspace cwd as a container that may hold zero, one, or many repositories.",
            "Do not assume cwd is a Git repository and do not publish or merge changes.",
          ],
          evidence: ["One strict spark.repro.lane-result/v2 carrier and all referenced Evidence."],
          source: { kind: "internal", externalRef: run.execution.jobId },
          title: `Repro checkpoint ${checkpoint.kind}`,
        },
        messageMetadata: {
          kind: "repro_checkpoint",
          reproId: repro.reproId,
          checkpointId: checkpoint.checkpointId,
          taskRef: checkpoint.taskRef,
          runRef,
          attempt,
          sessionMail: {
            requestPayload: {
              kind: "task_execution",
              projectRef: repro.projectRef,
              taskRef: checkpoint.taskRef,
              runRef,
              jobId: run.execution.jobId,
              attempt,
            },
          },
        },
      });
      await graphStore.update(
        (graph) => {
          const current = graph
            .runs(repro.projectRef)
            .find((candidate) => candidate.ref === runRef);
          if (!current?.execution) throw new Error(`Repro TaskRun ${runRef} disappeared`);
          graph.recordRun({
            ...current,
            status: "running",
            execution: { ...current.execution, invocationId: submitted.invocationId },
            updatedAt: now(),
          });
        },
        { createIfMissing: false },
      );
    }
    return bound;
  }

  async #ensureAttention(repro: SparkSessionRepro): Promise<void> {
    const checkpoint = currentSparkReproCheckpoint(repro);
    const attention = checkpoint?.attention;
    if (!checkpoint || !attention || !this.#options.humanWaits) return;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          reproId: repro.reproId,
          checkpointId: checkpoint.checkpointId,
          attempt: checkpoint.attempt,
          decisionKey: attention.decisionKey,
          question: attention.question,
        }),
      )
      .digest("hex");
    const questionId = `question:${stableId(requestHash)}`;
    this.#options.humanWaits.register({
      interactionRequestId: createAutonomousAskInteractionRequestId(requestHash),
      sessionId: repro.ownerSessionId,
      workspaceId: repro.workspaceId,
      projectId: repro.projectRef,
      delivery: "async",
      kind: "ask_user",
      title: `Repro needs input · ${checkpoint.kind}`,
      prompt: attention.reason,
      questions: [
        {
          id: questionId,
          type: attention.expectedAnswerKind,
          prompt: attention.question,
          required: true,
        },
      ],
      evidenceRequest: {
        schema: "spark.evidence-request/v1",
        askRef: `ask:${requestHash}`,
        ownerSessionId: repro.ownerSessionId,
        goalOrReproId: repro.reproId,
        modeScope: "repro",
        planRevision: checkpoint.attempt,
        ownerStepOrUnresolvedId: checkpoint.checkpointId,
        stepDefinitionDigest: stableId(repro.reproId, checkpoint.kind),
        requestHash,
        ownerQuestionId: questionId,
        expectedAnswerKind: attention.expectedAnswerKind,
      },
    });
  }

  async #blockRejectedRun(
    current: SparkSessionRepro,
    reason: string,
  ): Promise<{ repro: SparkSessionRepro; changed: boolean }> {
    const blocked = blockSparkReproV10(current, reason, now());
    if (blocked === current) return { repro: current, changed: false };
    if (!this.#store.replace(blocked, current.updatedAt)) {
      const concurrent = this.#store.get(current.reproId);
      if (concurrent)
        return { repro: concurrent, changed: concurrent.updatedAt !== current.updatedAt };
      throw new Error(`Repro ${current.reproId} disappeared while recording a rejected TaskRun`);
    }
    await this.#project(blocked);
    return { repro: blocked, changed: true };
  }

  async #project(repro: SparkSessionRepro): Promise<void> {
    try {
      await this.#options.onProjectionNeeded?.(repro);
    } catch {
      // The Repro transition is authoritative. A missing projection receipt
      // keeps this run in the bounded startup reconciliation set.
    }
  }
}

export function projectSparkReproV10(repro: SparkSessionRepro): SparkSessionReproWorkView {
  const checkpoint = currentSparkReproCheckpoint(repro);
  const lanes = Object.fromEntries(
    Object.entries(repro.lanes).map(([lane, binding]) => [
      lane,
      {
        sessionId: binding.sessionId,
        taskRef: binding.taskRef,
        roleRef: binding.roleRef,
      },
    ]),
  ) as SparkSessionReproWorkView["lanes"];
  return {
    version: 10,
    reproId: repro.reproId,
    status: repro.status,
    objective: repro.objective,
    workItemId: repro.workItem.workItemId,
    lanes,
    ...(checkpoint
      ? {
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            kind: checkpoint.kind,
            lane: checkpoint.lane,
            status: checkpoint.status,
            sessionId: checkpoint.sessionId,
            taskRef: checkpoint.taskRef,
            ...(checkpoint.runRef ? { runRef: checkpoint.runRef } : {}),
            attempt: checkpoint.attempt,
            evidenceRefs: checkpoint.evidenceRefs.slice(0, 12),
            ...(checkpoint.summary ? { summary: checkpoint.summary.slice(0, 512) } : {}),
            ...(checkpoint.attention
              ? {
                  attention: {
                    decisionKey: checkpoint.attention.decisionKey,
                    question: checkpoint.attention.question.slice(0, 512),
                    expectedAnswerKind: checkpoint.attention.expectedAnswerKind,
                  },
                }
              : {}),
          },
        }
      : {}),
    progress: {
      accepted: repro.checkpoints.filter((candidate) => candidate.status === "accepted").length,
      total: 5,
    },
    ...(repro.formalizedRevision ? { formalizedRevision: repro.formalizedRevision } : {}),
    ...(repro.blockingReason ? { blockingReason: repro.blockingReason.slice(0, 512) } : {}),
    updatedAt: repro.updatedAt,
  };
}

function renderCheckpointPrompt(
  repro: SparkSessionRepro,
  checkpoint: SparkReproCheckpoint,
): string {
  return [
    `Execute Repro v10 checkpoint ${checkpoint.kind} for objective: ${repro.objective}`,
    `Repro: ${repro.reproId}`,
    `WorkItem: ${repro.workItem.workItemId}`,
    `Checkpoint: ${checkpoint.checkpointId}`,
    `Source checkpoint: ${checkpoint.sourceCheckpointId ?? "none"}`,
    `Parent checkpoint: ${checkpoint.parentCheckpointId ?? "none"}`,
    `Session: ${checkpoint.sessionId}`,
    `TaskRef: ${checkpoint.taskRef}`,
    `RunRef: ${checkpoint.runRef}`,
    "The Workspace may contain zero, one, or many Git repositories. Discover only what the objective requires; cwd itself is not a repository contract.",
    "Finish by attaching one strict spark.repro.lane-result/v2 JSON Evidence and every referenced Evidence to this exact TaskRun.",
    "The result must carry checkpointId, sourceCheckpointId when present, sessionId, taskRef, and runRef exactly as supplied.",
    checkpoint.kind === "formalize"
      ? "Formalize must set formalizedRevision. No other checkpoint may set it."
      : "Do not set formalizedRevision.",
  ].join("\n");
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function now(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalInvocationStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
