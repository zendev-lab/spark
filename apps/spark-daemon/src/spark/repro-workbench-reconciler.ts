import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { loadSessionGoal } from "@zendev-lab/spark-loop";
import {
  sparkTokenUsageAggregateSchema,
  type SparkTokenUsageAggregate,
} from "@zendev-lab/spark-protocol/token-usage";
import {
  normalizeSparkReproWorkSummary,
  type SparkReproWorkSummary,
} from "@zendev-lab/spark-repro/work-summary";
import {
  normalizeSparkReproWorkSummaryV3,
  sparkReproWorkSummaryV3Base,
  SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA,
  type SparkReproWorkSummaryV3,
} from "@zendev-lab/spark-repro/three-lane-work-summary";
import {
  renderSparkReproWorkbenchA2ui,
  sparkReproWorkbenchCheckpointArtifactRef,
  sparkReproWorkbenchProjectionDigest,
  type SparkReproWorkbenchCheckpointKind,
} from "@zendev-lab/spark-repro/workbench";

import type { SparkLoopRecord, SparkLoopStore } from "../store/loops.ts";
import {
  WorkbenchArtifactBindingStore,
  type WorkbenchArtifactBinding,
} from "../store/workbench-artifact-bindings.ts";

import { errorMessage } from "../cli-shared.ts";

const REPRO_SUMMARY_PATH = "outputs/spark-summary.json";

export interface ReproWorkbenchReconcileResult {
  examined: number;
  projected: number;
  checkpointed: number;
  sealed: number;
  errors: Array<{ loopId: string; message: string }>;
}

/**
 * Rebuild daemon-owned Workbench Documents only from typed Goal/Repro/Loop
 * state. Artifact content is an output; it is never parsed back into runtime
 * truth. Missing summaries leave a durable pending binding for later replay.
 */
export async function reconcileReproWorkbenchArtifacts(input: {
  loopStore: SparkLoopStore;
  bindings: WorkbenchArtifactBindingStore;
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined;
  validateFormalEvidence?: (input: {
    cwd: string;
    ownerSessionId: string;
    work: SparkReproWorkSummary;
  }) => Promise<void>;
}): Promise<ReproWorkbenchReconcileResult> {
  const loops = input.loopStore.list({ includeTerminal: true }).filter(isReproWorkbenchLoop);
  const result: ReproWorkbenchReconcileResult = {
    examined: loops.length,
    projected: 0,
    checkpointed: 0,
    sealed: 0,
    errors: [],
  };
  for (const loop of loops) {
    let binding: WorkbenchArtifactBinding | undefined;
    let stateCwd: string | undefined;
    try {
      binding = input.bindings.ensure({
        ownerSessionId: loop.ownerSessionId,
        goalId: loop.binding.goalId!,
        workflowRunId: loop.binding.workflowRunId!,
        loopId: loop.loopId,
        reproId: loop.binding.reproId!,
        generation: loop.generation,
      });
      stateCwd = resolveLoopStateCwd(loop, input.resolveWorkspaceCwd);
      const summary = await readCanonicalSummary(loop, stateCwd);
      if (!summary) continue;
      await input.validateFormalEvidence?.({
        cwd: stateCwd,
        ownerSessionId: loop.ownerSessionId,
        work: sparkReproWorkSummaryV3Base(summary.work),
      });
      const goal = await loadSessionGoal(stateCwd, { sessionId: loop.ownerSessionId });
      if (!goal || goal.goalId !== binding.goalId) {
        throw new Error(`Goal ${binding.goalId} is unavailable for Workbench projection`);
      }
      const checkpointsBefore = input.bindings.listCheckpoints(binding.bindingId);
      const stageCreated = await ensureCheckpoint({
        binding,
        bindings: input.bindings,
        loop,
        work: summary.work,
        goalContract: goal.contract,
        tokenUsage: summary.tokenUsage,
        artifactCwd: stateCwd,
        kind: "stage",
        checkpointId: `stage:${summary.work.stage}`,
        checkpoints: checkpointsBefore,
      });
      result.checkpointed += Number(stageCreated);
      const afterStage = input.bindings.listCheckpoints(binding.bindingId);
      if (summary.work.status === "complete") {
        const finalCreated = await ensureCheckpoint({
          binding,
          bindings: input.bindings,
          loop,
          work: summary.work,
          goalContract: goal.contract,
          tokenUsage: summary.tokenUsage,
          artifactCwd: stateCwd,
          kind: "final",
          checkpointId: "final",
          checkpoints: afterStage,
        });
        result.checkpointed += Number(finalCreated);
      }
      const checkpoints = input.bindings.listCheckpoints(binding.bindingId);
      const terminal = shouldSealReproWorkbench(loop.status, summary.work.status);
      const projected = await projectLiveWorkbench({
        binding: input.bindings.getByLoop(loop.loopId) ?? binding,
        bindings: input.bindings,
        loop,
        work: summary.work,
        goalContract: goal.contract,
        tokenUsage: summary.tokenUsage,
        artifactCwd: stateCwd,
        checkpoints,
        seal: terminal,
      });
      result.projected += Number(projected);
      result.sealed += Number(projected && terminal);
    } catch (error) {
      if (binding) {
        try {
          await reopenSealedWorkbenchAfterError(
            stateCwd ?? resolveLoopStateCwd(loop, input.resolveWorkspaceCwd),
            binding,
            error,
          );
          input.bindings.recordError(binding.bindingId, error);
        } catch (lifecycleError) {
          input.bindings.recordError(
            binding.bindingId,
            new Error(
              `${errorMessage(error)}; Workbench Artifact reopen pending: ${errorMessage(lifecycleError)}`,
            ),
          );
          result.errors.push({
            loopId: loop.loopId,
            message: `Workbench error projection failed: ${errorMessage(lifecycleError)}`,
          });
          continue;
        }
      }
      result.errors.push({
        loopId: loop.loopId,
        message: errorMessage(error),
      });
    }
  }
  return result;
}

async function reopenSealedWorkbenchAfterError(
  artifactCwd: string,
  binding: WorkbenchArtifactBinding,
  error: unknown,
): Promise<void> {
  const store = defaultArtifactStore(artifactCwd);
  const current = await store.tryGet(binding.artifactRef);
  if (
    current?.body.kind !== "document" ||
    current.body.management?.bindingId !== binding.bindingId
  ) {
    if (binding.lifecycle === "sealed") {
      throw new Error(`sealed Workbench Artifact is unavailable: ${binding.artifactRef}`);
    }
    return;
  }
  if (current.body.management.lifecycle === "live") return;
  if (current.body.management.lifecycle !== "sealed") {
    throw new Error(`sealed Workbench Artifact has invalid lifecycle: ${binding.artifactRef}`);
  }
  await store.putManagedDocument({
    ref: binding.artifactRef,
    bindingId: binding.bindingId,
    title: current.title,
    mediaType: current.body.mediaType,
    content: current.body.content,
    expectedRevision: current.body.revision,
    progress: {
      ...(current.body.progress ?? {}),
      label: `error · ${errorMessage(error).slice(0, 160)}`,
    },
    reopen: true,
  });
}

export function shouldSealReproWorkbench(
  loopStatus: SparkLoopRecord["status"],
  workStatus: SparkReproWorkSummary["status"],
): boolean {
  return loopStatus === "completed" && workStatus === "complete";
}

async function projectLiveWorkbench(input: {
  binding: WorkbenchArtifactBinding;
  bindings: WorkbenchArtifactBindingStore;
  loop: SparkLoopRecord;
  work: SparkReproWorkSummaryV3;
  goalContract: Parameters<typeof renderSparkReproWorkbenchA2ui>[0]["goalContract"];
  tokenUsage?: SparkTokenUsageAggregate;
  artifactCwd: string;
  checkpoints: Parameters<typeof renderSparkReproWorkbenchA2ui>[0]["checkpoints"];
  seal: boolean;
}): Promise<boolean> {
  const lifecycle = input.seal ? "sealed" : "live";
  const digestInput = {
    work: input.work,
    goalContract: input.goalContract,
    loop: input.loop,
    artifactRef: input.binding.artifactRef,
    lifecycle,
    ...(input.tokenUsage ? { tokenUsage: input.tokenUsage } : {}),
    checkpoints: input.checkpoints,
  } as const;
  const projectionDigest = sparkReproWorkbenchProjectionDigest(digestInput);
  const store = defaultArtifactStore(input.artifactCwd);
  const current = await store.tryGet(input.binding.artifactRef);
  if (
    input.binding.projectionDigest === projectionDigest &&
    current?.body.kind === "document" &&
    current.body.revision === input.binding.revision &&
    current.hash === input.binding.artifactHash
  ) {
    return false;
  }
  if (current?.body.kind === "document") {
    const expectedCurrentContent = renderSparkReproWorkbenchA2ui({
      ...digestInput,
      revision: current.body.revision,
    });
    if (
      current.body.management?.bindingId === input.binding.bindingId &&
      current.body.management.lifecycle === lifecycle &&
      current.body.content === expectedCurrentContent &&
      current.hash
    ) {
      input.bindings.recordProjection({
        bindingId: input.binding.bindingId,
        expectedRevision: input.binding.revision,
        revision: current.body.revision,
        artifactHash: current.hash,
        projectionDigest,
        generation: input.loop.generation,
        stage: input.work.stage,
        sealed: current.body.management.lifecycle === "sealed",
      });
      return true;
    }
  }
  const expectedRevision = current?.body.kind === "document" ? current.body.revision : null;
  const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
  const content = renderSparkReproWorkbenchA2ui({ ...digestInput, revision: nextRevision });
  const written = await store.putManagedDocument({
    ref: input.binding.artifactRef,
    bindingId: input.binding.bindingId,
    title: `Repro Workbench · ${input.work.title}`,
    mediaType: "application/vnd.a2ui+json",
    content,
    expectedRevision,
    progress: {
      stage: input.work.stage,
      label: `${input.work.stage} · ${input.work.status}`,
      ...(input.work.progress.quantified ? { percent: input.work.progress.percent } : {}),
    },
    seal: input.seal,
    reopen:
      current?.body.kind === "document" &&
      current.body.management?.lifecycle === "sealed" &&
      !input.seal,
  });
  input.bindings.recordProjection({
    bindingId: input.binding.bindingId,
    expectedRevision: input.binding.revision,
    revision: written.artifact.body.revision,
    artifactHash: written.artifact.hash!,
    projectionDigest,
    generation: input.loop.generation,
    stage: input.work.stage,
    sealed: input.seal,
  });
  return true;
}

async function ensureCheckpoint(input: {
  binding: WorkbenchArtifactBinding;
  bindings: WorkbenchArtifactBindingStore;
  loop: SparkLoopRecord;
  work: SparkReproWorkSummaryV3;
  goalContract: Parameters<typeof renderSparkReproWorkbenchA2ui>[0]["goalContract"];
  tokenUsage?: SparkTokenUsageAggregate;
  artifactCwd: string;
  kind: SparkReproWorkbenchCheckpointKind;
  checkpointId: string;
  checkpoints: Parameters<typeof renderSparkReproWorkbenchA2ui>[0]["checkpoints"];
}): Promise<boolean> {
  if (
    input.bindings
      .listCheckpoints(input.binding.bindingId)
      .some((checkpoint) => checkpoint.checkpointId === input.checkpointId)
  ) {
    return false;
  }
  const artifactRef = sparkReproWorkbenchCheckpointArtifactRef(
    input.binding.reproId,
    input.checkpointId,
  );
  const content = renderSparkReproWorkbenchA2ui({
    work: input.work,
    goalContract: input.goalContract,
    loop: input.loop,
    artifactRef,
    revision: 1,
    lifecycle: "sealed",
    ...(input.tokenUsage ? { tokenUsage: input.tokenUsage } : {}),
    checkpoints: input.checkpoints,
  });
  const managedBindingId = `${input.binding.bindingId}:${input.checkpointId}`;
  const store = defaultArtifactStore(input.artifactCwd);
  const existing = await store.tryGet(artifactRef);
  const artifact =
    existing?.body.kind === "document" &&
    existing.body.management?.bindingId === managedBindingId &&
    existing.body.management.lifecycle === "sealed" &&
    existing.body.content === content
      ? { artifact: existing }
      : await store.putManagedDocument({
          ref: artifactRef,
          bindingId: managedBindingId,
          title: `Repro Workbench checkpoint · ${input.work.title} · ${input.checkpointId}`,
          mediaType: "application/vnd.a2ui+json",
          content,
          expectedRevision: null,
          seal: true,
        });
  if (artifact.artifact.body.kind !== "document") {
    throw new Error(`Workbench checkpoint Artifact is not a Document: ${artifactRef}`);
  }
  input.bindings.recordCheckpoint({
    checkpointId: input.checkpointId,
    bindingId: input.binding.bindingId,
    kind: input.kind,
    stage: input.work.stage,
    artifactRef,
    revision: artifact.artifact.body.revision,
    artifactHash: artifact.artifact.hash!,
    work: input.work,
  });
  return true;
}

function isReproWorkbenchLoop(loop: SparkLoopRecord): boolean {
  return Boolean(
    loop.binding.reproId &&
    loop.binding.goalId &&
    loop.binding.workflowRunId &&
    loop.binding.workflowSelector === "builtin:repro",
  );
}

function resolveLoopStateCwd(
  loop: SparkLoopRecord,
  resolveWorkspaceCwd?: (workspaceId: string) => string | undefined,
): string {
  const workspaceId = loop.route.workspaceId;
  if (!workspaceId) return loop.route.cwd;
  const workspaceCwd = resolveWorkspaceCwd?.(workspaceId);
  if (!workspaceCwd) {
    throw new Error(`Workspace ${workspaceId} is unavailable for Workbench projection`);
  }
  return workspaceCwd;
}

async function readCanonicalSummary(
  loop: SparkLoopRecord,
  stateCwd: string,
): Promise<{
  work: SparkReproWorkSummaryV3;
  tokenUsage?: SparkTokenUsageAggregate;
} | null> {
  let text: string;
  try {
    text = await readFile(resolve(stateCwd, REPRO_SUMMARY_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value) || value.format !== "spark-repro-summary/v1" || !isRecord(value.work)) {
    throw new Error(`invalid ${REPRO_SUMMARY_PATH} envelope`);
  }
  const stored = value.work;
  const legacy = stored.schema !== SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA;
  const work = legacy
    ? normalizeSparkReproWorkSummaryV3(normalizeSparkReproWorkSummary(stored))
    : normalizeSparkReproWorkSummaryV3(stored as unknown as SparkReproWorkSummaryV3);
  if (!legacy) {
    for (const field of ["schema", "status", "progress", "technicalGoal"] as const) {
      if (!isDeepStrictEqual(stored[field], work[field])) {
        throw new Error(`${REPRO_SUMMARY_PATH} work.${field} is not canonical`);
      }
    }
  }
  if (work.reproId !== loop.binding.reproId) {
    throw new Error(`${REPRO_SUMMARY_PATH} belongs to a different Repro run`);
  }
  const tokenUsage =
    value.tokenUsage === undefined
      ? undefined
      : sparkTokenUsageAggregateSchema.parse(value.tokenUsage);
  if (tokenUsage && tokenUsage.scope.reproId !== work.reproId) {
    throw new Error(`${REPRO_SUMMARY_PATH} token scope does not match Repro run`);
  }
  return { work, ...(tokenUsage ? { tokenUsage } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
