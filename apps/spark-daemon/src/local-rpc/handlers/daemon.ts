import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkChannelDeliveryStore } from "../../store/channel-deliveries.ts";
import { SparkDaemonUserTokenStore } from "../../store/daemon-user-tokens.ts";
import { sparkDaemonServerStatusSummaries } from "../../store/workspaces.js";
import { SparkDaemonControlError } from "../../control-error.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type DaemonRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "daemon.status"
      | "daemon.stop"
      | "daemon.restart"
      | "daemon.access.create"
      | "daemon.access.list"
      | "daemon.access.revoke"
      | "daemon.access.verify";
  }
>;

export async function handleDaemonRequest(
  ctx: LocalRpcDispatchContext,
  request: DaemonRequest,
): Promise<LocalRpcServiceOutput<DaemonRequest>> {
  const { db, onStop, options } = ctx;
  switch (request.method) {
    case "daemon.access.create": {
      const store = new SparkDaemonUserTokenStore(db);
      const created = store.create({
        ...(request.params.label !== undefined ? { label: request.params.label } : {}),
        ...(request.params.expiresAt !== undefined ? { expiresAt: request.params.expiresAt } : {}),
      });
      return created;
    }
    case "daemon.access.list": {
      return { tokens: new SparkDaemonUserTokenStore(db).list() };
    }
    case "daemon.access.revoke": {
      const revoked = new SparkDaemonUserTokenStore(db).revoke(request.params.id);
      return { id: request.params.id, revoked };
    }
    case "daemon.access.verify": {
      const record = new SparkDaemonUserTokenStore(db).verify(request.params.token);
      return { valid: record !== undefined };
    }
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
        ...(options.getExecutionStatus ? { execution: options.getExecutionStatus() } : {}),
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
  const message = error instanceof Error ? error.message : String(error);
  const knownFailures = [
    ["restart helper IPC is unavailable", "restart helper IPC is unavailable"],
    ["restart helper exited before readiness", "restart helper exited before readiness"],
    ["restart helper was not fully armed", "restart helper did not complete arming"],
    ["restart helper did not receive a process id", "restart helper process did not start"],
    ["restart arming was cancelled", "restart helper arming was cancelled"],
    [
      "restart intent changed while a helper was being armed",
      "restart intent changed during arming",
    ],
    ["restart fence generation mismatch", "restart fence generation mismatch"],
    ["targets a different build", "restart target build changed during arming"],
  ] as const;
  return (
    knownFailures.find(([fragment]) => message.includes(fragment))?.[1] ??
    "internal restart scheduling failure"
  );
}
