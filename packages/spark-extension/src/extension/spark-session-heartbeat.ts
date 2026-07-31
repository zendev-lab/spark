import {
  createSparkDaemonClient,
  startSparkDaemonSessionHeartbeat,
  type SparkDaemonClient,
  type SparkDaemonSessionHeartbeatEvent,
  type SparkDaemonSessionHeartbeatHandle,
} from "@zendev-lab/spark-daemon-client";
import type { SparkSessionLeaseIdentity } from "@zendev-lab/spark-core";
import { sparkSessionKey } from "@zendev-lab/spark-loop";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkSessionHeartbeatControllerOptions {
  client?: SparkDaemonClient;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
}

export interface SparkSessionHeartbeatController {
  lease(): SparkSessionLeaseIdentity | undefined;
  start(ctx: SparkToolContext): Promise<void>;
  stop(ctx: SparkToolContext): Promise<void>;
}

export function createSparkSessionHeartbeatController(
  options: SparkSessionHeartbeatControllerOptions = {},
): SparkSessionHeartbeatController {
  const client = options.client ?? createSparkDaemonClient();
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  let active:
    | {
        sessionId: string;
        handle: SparkDaemonSessionHeartbeatHandle;
      }
    | undefined;

  return {
    lease() {
      const lease = active?.handle.lease;
      if (!lease) return undefined;
      return {
        workspaceId: lease.workspaceId,
        clientId: lease.clientId,
        leaseFence: lease.leaseFence,
        sessionId: lease.sessionId,
      };
    },
    async start(ctx) {
      if (!isPiCompatibilityPersistentSession(ctx)) return;
      const sessionId = sparkSessionKey(ctx);
      if (active?.sessionId === sessionId) return;
      await stopActive(ctx, active);
      active = undefined;
      try {
        const workspace = await client.request("workspace.ensure-local", { localPath: ctx.cwd });
        const handle = await startSparkDaemonSessionHeartbeat({
          client,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          attach: {
            workspaceId: workspace.id,
            kind: "interactive",
            displayName: "Pi session",
            leaseTtlMs,
            sessionId,
            metadata: { surface: "pi" },
          },
          onEvent: (event) => reportHeartbeatEvent(ctx, event),
        });
        active = { sessionId, handle };
      } catch (error) {
        notifyHeartbeatFailure(ctx, "attach", error);
      }
    },
    async stop(ctx) {
      const current = active;
      active = undefined;
      await stopActive(ctx, current);
    },
  };
}

function isPiCompatibilityPersistentSession(ctx: SparkToolContext): boolean {
  if (ctx.sessionSource) return false;
  if (ctx.sessionManager?.isPersisted) return ctx.sessionManager.isPersisted();
  return Boolean(ctx.sessionManager?.getSessionFile?.());
}

async function stopActive(
  ctx: SparkToolContext,
  active: { handle: SparkDaemonSessionHeartbeatHandle } | undefined,
): Promise<void> {
  if (!active) return;
  try {
    await active.handle.stop();
  } catch (error) {
    notifyHeartbeatFailure(ctx, "release", error);
  }
}

function reportHeartbeatEvent(
  ctx: SparkToolContext,
  event: SparkDaemonSessionHeartbeatEvent,
): void {
  if (event.type === "retry" && event.attempt === 1) {
    notifyHeartbeatFailure(ctx, "heartbeat", event.error);
  }
}

function notifyHeartbeatFailure(
  ctx: SparkToolContext,
  operation: "attach" | "heartbeat" | "release",
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  ctx.ui?.notify?.(`Spark daemon session ${operation} failed: ${detail}`, "warning");
}
