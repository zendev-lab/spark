import { driverUpdateEvent, SparkDriverStore } from "../../store/drivers.ts";
import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveWorkspaceLocalPath } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type DriverRequest = Extract<LocalRpcServiceRequest, { method: `driver.${string}` }>;

export async function handleDriverRequest(
  ctx: LocalRpcDispatchContext,
  request: DriverRequest,
): Promise<LocalRpcServiceOutput<DriverRequest>> {
  const store = new SparkDriverStore(ctx.db);
  const mutation = (record: ReturnType<SparkDriverStore["start"]>) => {
    const result = store.mutationResult(record);
    ctx.options.eventBus?.publish(driverUpdateEvent(result.driver));
    return result;
  };
  switch (request.method) {
    case "driver.start": {
      const session = await ctx.options.sessionRegistry?.get(request.params.ownerSessionId);
      if (ctx.options.sessionRegistry && !session) {
        throw new SparkDaemonControlError(
          "driver_owner_not_found",
          `Driver owner session was not found: ${request.params.ownerSessionId}`,
        );
      }
      if (session?.status === "archived") {
        throw new SparkDaemonControlError(
          "driver_owner_archived",
          `Driver owner session is archived: ${request.params.ownerSessionId}`,
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
          "driver_owner_not_found",
          `Driver owner session has no execution cwd: ${request.params.ownerSessionId}`,
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
    case "driver.status":
      return store.listResult(request.params);
    case "driver.stop":
      return mutation(
        store.stop(request.params.driverId, request.params.reason ?? "stopped by control plane"),
      );
    case "driver.restart":
      return mutation(
        store.restart(
          request.params.driverId,
          request.params.reason ?? "restarted by control plane",
        ),
      );
    case "driver.wake":
      return mutation(
        store.wake(request.params.driverId, {
          prompt: request.params.prompt,
          reason: request.params.reason ?? "manual wake",
        }),
      );
    case "driver.schedule":
      return mutation(store.schedule(request.params));
  }
}
