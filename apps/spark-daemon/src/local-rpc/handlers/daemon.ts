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
        console.error(
          `[spark-daemon] restart scheduling failed: ${daemonRestartFailureLogDetail(error)}`,
        );
        throw new SparkDaemonControlError(
          "daemon_restart_unavailable",
          "Spark daemon could not arm a safe restart successor. Inspect `spark daemon logs --lines 100`, correct the reported local lifecycle error, and retry.",
        );
      }
    }
  }
}

function daemonRestartFailureLogDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(
      /((?:authorization|token|secret|api[_ -]?key|password|passphrase)\s*[:=]\s*)\S+/giu,
      "$1[redacted]",
    )
    .replace(/\b(Bearer|QQBot)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(/([?&](?:access_token|client_secret|token|secret)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/(^|[\s("'=])\/(?:[^\s"'()]+\/)*[^\s"'():]*/gu, "$1<path>")
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 499)}…`;
}
