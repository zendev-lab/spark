import { loopUpdateEvent, SparkLoopStore } from "../../store/loops.ts";
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
  }
}
