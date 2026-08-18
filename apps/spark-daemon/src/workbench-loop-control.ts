import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import {
  sparkLoopMutationResultSchema,
  type SparkLoopControlRequest,
  type SparkLoopMutationResult,
  type SparkLoopView,
} from "@zendev-lab/spark-protocol";

import { SparkDaemonControlError } from "./control-error.ts";
import { SparkLoopStore, loopUpdateEvent } from "./store/loops.ts";
import { resolveWorkspaceLocalPath } from "./store/workspaces.ts";
import {
  WorkbenchArtifactBindingStore,
  workbenchRequestDigest,
} from "./store/workbench-artifact-bindings.ts";
import type { DatabaseSync } from "node:sqlite";

import { errorMessage } from "./cli-shared.ts";

export async function executeTrustedWorkbenchLoopControl(input: {
  db: DatabaseSync;
  request: SparkLoopControlRequest;
  expectedOwnerSessionId?: string;
  publish?: (event: ReturnType<typeof loopUpdateEvent>) => void;
}): Promise<SparkLoopMutationResult> {
  const store = new SparkLoopStore(input.db);
  const bindingStore = new WorkbenchArtifactBindingStore(input.db);
  const action = input.request.action;
  const actionContext = action.context;
  const requestDigest = workbenchRequestDigest(input.request);
  const prior = bindingStore.readActionReceipt(actionContext.idempotencyKey);
  if (prior) {
    if (prior.requestDigest !== requestDigest) {
      throw new SparkDaemonControlError(
        "workbench_action_conflict",
        `Workbench action idempotency key was reused: ${actionContext.idempotencyKey}`,
      );
    }
    return sparkLoopMutationResultSchema.parse(prior.result);
  }

  const binding = bindingStore.getByArtifact(actionContext.artifactRef);
  if (!binding) {
    throw new SparkDaemonControlError(
      "workbench_binding_not_found",
      `Trusted Workbench binding was not found: ${actionContext.artifactRef}`,
    );
  }
  const current = store.require(actionContext.loopId);
  if (input.expectedOwnerSessionId && current.ownerSessionId !== input.expectedOwnerSessionId) {
    throw new SparkDaemonControlError(
      "workbench_action_untrusted",
      `Workbench action does not belong to Session ${input.expectedOwnerSessionId}`,
    );
  }
  assertTrustedWorkbenchAction({ binding, current, action });
  let artifact: Awaited<ReturnType<ReturnType<typeof defaultArtifactStore>["tryGet"]>>;
  try {
    artifact = await defaultArtifactStore(resolveLoopStateCwd(input.db, current)).tryGet(
      actionContext.artifactRef,
    );
  } catch (error) {
    throw new SparkDaemonControlError(
      "workbench_action_untrusted",
      `Workbench Artifact integrity check failed: ${binding.artifactRef} (${errorMessage(error)})`,
    );
  }
  if (
    artifact?.body.kind !== "document" ||
    artifact.body.management?.authority !== "daemon" ||
    artifact.body.management.bindingId !== binding.bindingId ||
    artifact.body.management.lifecycle !== "live" ||
    artifact.body.revision !== binding.revision ||
    artifact.hash !== binding.artifactHash
  ) {
    throw new SparkDaemonControlError(
      "workbench_action_untrusted",
      `Workbench Artifact provenance does not match its daemon binding: ${binding.artifactRef}`,
    );
  }
  input.db.exec("BEGIN IMMEDIATE");
  try {
    const replay = bindingStore.readActionReceipt(actionContext.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new SparkDaemonControlError(
          "workbench_action_conflict",
          `Workbench action idempotency key was reused: ${actionContext.idempotencyKey}`,
        );
      }
      const replayed = sparkLoopMutationResultSchema.parse(replay.result);
      input.db.exec("COMMIT");
      return replayed;
    }
    const lockedBinding = bindingStore.getByArtifact(actionContext.artifactRef);
    const refreshed = store.require(current.loopId);
    if (!lockedBinding) {
      throw new SparkDaemonControlError(
        "workbench_binding_not_found",
        `Trusted Workbench binding was not found: ${actionContext.artifactRef}`,
      );
    }
    assertTrustedWorkbenchAction({ binding: lockedBinding, current: refreshed, action });
    if (
      lockedBinding.artifactHash !== artifact.hash ||
      lockedBinding.revision !== artifact.body.revision
    ) {
      throw new SparkDaemonControlError(
        "workbench_action_untrusted",
        `Workbench Artifact changed during action admission: ${lockedBinding.artifactRef}`,
      );
    }
    const controlled = controlLoop(store, refreshed, actionContext.actionId);
    const result = store.mutationResult(controlled);
    bindingStore.recordActionReceipt({
      idempotencyKey: actionContext.idempotencyKey,
      requestDigest,
      bindingId: lockedBinding.bindingId,
      result,
    });
    input.db.exec("COMMIT");
    input.publish?.(loopUpdateEvent(result.loop));
    return result;
  } catch (error) {
    if (input.db.isTransaction) input.db.exec("ROLLBACK");
    throw error;
  }
}

function assertTrustedWorkbenchAction(input: {
  binding: NonNullable<ReturnType<WorkbenchArtifactBindingStore["getByArtifact"]>>;
  current: ReturnType<SparkLoopStore["require"]>;
  action: SparkLoopControlRequest["action"];
}): void {
  const { binding, current, action } = input;
  const context = action.context;
  if (
    binding.lifecycle !== "live" ||
    binding.loopId !== context.loopId ||
    binding.revision !== context.revision ||
    binding.generation !== context.generation ||
    current.generation !== context.generation ||
    current.ownerSessionId !== binding.ownerSessionId ||
    current.binding.goalId !== binding.goalId ||
    current.binding.workflowRunId !== binding.workflowRunId ||
    current.binding.reproId !== binding.reproId ||
    current.binding.workflowSelector !== "builtin:repro" ||
    action.surfaceId !== `spark-repro-${safeId(binding.reproId)}` ||
    action.sourceComponentId !== `control-${context.actionId}`
  ) {
    throw new SparkDaemonControlError(
      "workbench_action_stale",
      `Workbench action is stale or does not own Loop ${context.loopId}`,
    );
  }
}

function controlLoop(
  store: SparkLoopStore,
  current: ReturnType<SparkLoopStore["require"]>,
  actionId: SparkLoopControlRequest["action"]["context"]["actionId"],
) {
  switch (actionId) {
    case "pause":
      return store.pause(current.loopId, current.generation, "paused from trusted Workbench");
    case "resume":
      if (current.status !== "paused" && current.status !== "blocked") {
        throw staleActionState(current.loopId, actionId, current.status);
      }
      return store.wake(current.loopId, { reason: "resumed from trusted Workbench" });
    case "run_now":
      if (
        current.status !== "scheduled" &&
        current.status !== "dormant" &&
        current.status !== "paused"
      ) {
        throw staleActionState(current.loopId, actionId, current.status);
      }
      return store.wake(current.loopId, { reason: "run now requested from trusted Workbench" });
    case "retry_checkpoint":
      return store.retryCheckpoint(
        current.loopId,
        current.generation,
        "checkpoint retry requested from trusted Workbench",
      );
    case "stop":
      return store.stop(current.loopId, "stopped from trusted Workbench");
  }
}

function staleActionState(
  loopId: string,
  actionId: string,
  status: SparkLoopView["status"],
): SparkDaemonControlError {
  return new SparkDaemonControlError(
    "workbench_action_stale",
    `Workbench action ${actionId} is unavailable for Loop ${loopId} in ${status}`,
  );
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

function resolveLoopStateCwd(
  db: DatabaseSync,
  current: ReturnType<SparkLoopStore["require"]>,
): string {
  const workspaceId = current.route.workspaceId;
  if (!workspaceId) return current.route.cwd;
  const workspaceCwd = resolveWorkspaceLocalPath(db, workspaceId);
  if (!workspaceCwd) {
    throw new SparkDaemonControlError(
      "workbench_action_untrusted",
      `Workspace ${workspaceId} is unavailable for Workbench action admission`,
    );
  }
  return workspaceCwd;
}
