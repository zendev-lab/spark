import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkChannelDeliveryStore } from "../../store/channel-deliveries.ts";
import { sparkDaemonServerStatusSummaries } from "../../store/workspaces.js";
import { SparkDaemonControlError } from "../../control-error.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type DaemonRequest = Extract<
  LocalRpcServiceRequest,
  { method: "daemon.status" | "daemon.stop" | "daemon.restart" }
>;

export async function handleDaemonRequest(
  ctx: LocalRpcDispatchContext,
  request: DaemonRequest,
): Promise<LocalRpcServiceOutput<DaemonRequest>> {
  const { db, onStop, options } = ctx;
  switch (request.method) {
    case "daemon.status": {
      const store = new SparkInvocationStore(db);
      const oldestActive = store.oldestActive();
      return {
        servers: sparkDaemonServerStatusSummaries(db),
        invocations: store.counts(),
        invocationHealth: {
          ...(oldestActive.queued ? { oldestQueuedAt: oldestActive.queued } : {}),
          ...(oldestActive.running ? { oldestRunningAt: oldestActive.running } : {}),
        },
        channelDeliveries: new SparkChannelDeliveryStore(db).summary(),
        lifecycle: options.getLifecycle?.() ?? { state: "running" },
        ...(options.getBuildFingerprint ? { buildFingerprint: options.getBuildFingerprint() } : {}),
        observedAt: new Date().toISOString(),
      };
    }
    case "daemon.stop":
      options.onStopRequested?.();
      setTimeout(() => {
        void onStop?.();
      }, 0);
      return {
        stopping: true,
        observedAt: new Date().toISOString(),
      };
    case "daemon.restart": {
      if (!options.onRestart) {
        throw new SparkDaemonControlError(
          "daemon_restart_unavailable",
          "Spark daemon restart control is not available.",
        );
      }
      try {
        return await options.onRestart();
      } catch (error) {
        if (error instanceof SparkDaemonControlError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new SparkDaemonControlError(
          "daemon_restart_unavailable",
          `Spark daemon restart could not arm its successor: ${message}`,
        );
      }
    }
  }
}
