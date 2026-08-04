import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import { sparkLoopMutationResultSchema } from "@zendev-lab/spark-protocol";
import { loopUpdateEvent, SparkLoopStore } from "../../store/loops.ts";
import {
  WorkbenchArtifactBindingStore,
  workbenchRequestDigest,
} from "../../store/workbench-artifact-bindings.ts";
import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type LoopRequest = Extract<LocalRpcServiceRequest, { method: `loop.${string}` }>;

export async function handleLoopRequest(
  ctx: LocalRpcDispatchContext,
  request: LoopRequest,
): Promise<LocalRpcServiceOutput<LoopRequest>> {
  const store = new SparkLoopStore(ctx.db);
  const mutation = (record: ReturnType<SparkLoopStore["start"]>) => {
    const result = store.mutationResult(record);
    ctx.options.eventBus?.publish(loopUpdateEvent(result.loop));
    return result;
  };
  switch (request.method) {
    case "loop.start": {
      const session = await ctx.options.sessionRegistry?.get(request.params.ownerSessionId);
      if (ctx.options.sessionRegistry && !session) {
        throw new SparkDaemonControlError(
          "loop_owner_not_found",
          `Loop owner session was not found: ${request.params.ownerSessionId}`,
        );
      }
      if (session?.status === "archived") {
        throw new SparkDaemonControlError(
          "loop_owner_archived",
          `Loop owner session is archived: ${request.params.ownerSessionId}`,
        );
      }
      if (!session) return mutation(store.start(request.params));
      const cwd =
        session.cwd?.trim() ||
        (session.scope.kind === "workspace"
          ? resolveWorkspaceLocalPath(ctx.db, session.scope.workspaceId)
          : undefined);
      if (!cwd) {
        throw new SparkDaemonControlError(
          "loop_owner_not_found",
          `Loop owner session has no execution cwd: ${request.params.ownerSessionId}`,
        );
      }
      return mutation(
        store.start({
          ...request.params,
          cwd,
          ...(session.scope.kind === "workspace" ? { workspaceId: session.scope.workspaceId } : {}),
        }),
      );
    }
    case "loop.status":
      return store.listResult(request.params);
    case "loop.stop":
      return mutation(
        store.stop(request.params.loopId, request.params.reason ?? "stopped by control plane"),
      );
    case "loop.restart":
      return mutation(
        store.restart(request.params.loopId, request.params.reason ?? "restarted by control plane"),
      );
    case "loop.wake":
      return mutation(
        store.wake(request.params.loopId, {
          prompt: request.params.prompt,
          reason: request.params.reason ?? "manual wake",
        }),
      );
    case "loop.schedule":
      return mutation(store.schedule(request.params));
    case "loop.control": {
      const action = request.params.action;
      const actionContext = action.context;
      const bindingStore = new WorkbenchArtifactBindingStore(ctx.db);
      const requestDigest = workbenchRequestDigest(request.params);
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
      assertTrustedWorkbenchAction({ binding, current, action });
      const artifactCwd = resolveLoopStateCwd(ctx, current);
      const artifact = await defaultArtifactStore(artifactCwd).tryGet(actionContext.artifactRef);
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
      ctx.db.exec("BEGIN IMMEDIATE");
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
          ctx.db.exec("COMMIT");
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
        ctx.db.exec("COMMIT");
        ctx.options.eventBus?.publish(loopUpdateEvent(result.loop));
        return result;
      } catch (error) {
        if (ctx.db.isTransaction) ctx.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function assertTrustedWorkbenchAction(input: {
  binding: ReturnType<WorkbenchArtifactBindingStore["getByArtifact"]> & {};
  current: ReturnType<SparkLoopStore["require"]>;
  action: Extract<LoopRequest, { method: "loop.control" }>["params"]["action"];
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
  actionId: Extract<
    LoopRequest,
    { method: "loop.control" }
  >["params"]["action"]["context"]["actionId"],
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
  status: string,
): SparkDaemonControlError {
  return new SparkDaemonControlError(
    "workbench_action_stale",
    `Workbench action ${actionId} is unavailable for Loop ${loopId} in ${status}`,
  );
}

function resolveLoopStateCwd(
  ctx: LocalRpcDispatchContext,
  current: ReturnType<SparkLoopStore["require"]>,
): string {
  const workspaceId = current.route.workspaceId;
  if (!workspaceId) return current.route.cwd;
  const workspaceCwd = resolveWorkspaceLocalPath(ctx.db, workspaceId);
  if (!workspaceCwd) {
    throw new SparkDaemonControlError(
      "workbench_action_untrusted",
      `Workspace ${workspaceId} is unavailable for Workbench action admission`,
    );
  }
  return workspaceCwd;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}
