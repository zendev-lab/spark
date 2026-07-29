import {
  startSparkDaemonSessionHeartbeat,
  type SparkDaemonClient,
  type SparkDaemonSessionHeartbeatHandle,
} from "@zendev-lab/spark-daemon-client";
import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol";

export interface AttachSparkWorkspaceSessionClientOptions {
  workspaceId: string;
  sessionId: string;
  heartbeatIntervalMs?: number;
  leaseTtlMs?: number;
}

export interface SparkWorkspaceSessionHeartbeatTransport {
  ensureRunning: () => Promise<void>;
  attach: (input: SparkLocalRpcInput<"workspace.client.attach">) => Promise<unknown>;
  heartbeat: (input: SparkLocalRpcInput<"workspace.client.heartbeat">) => Promise<unknown>;
  release: (input: SparkLocalRpcInput<"workspace.client.release">) => Promise<unknown>;
}

export async function attachSparkWorkspaceSessionHeartbeat(
  transport: SparkWorkspaceSessionHeartbeatTransport,
  options: AttachSparkWorkspaceSessionClientOptions,
): Promise<SparkDaemonSessionHeartbeatHandle> {
  await transport.ensureRunning();
  const client: SparkDaemonClient = {
    async request<M extends SparkLocalRpcMethod>(
      method: M,
      input: SparkLocalRpcInput<M>,
    ): Promise<SparkLocalRpcOutput<M>> {
      switch (method) {
        case "workspace.client.attach":
          return (await transport.attach(
            input as SparkLocalRpcInput<"workspace.client.attach">,
          )) as SparkLocalRpcOutput<M>;
        case "workspace.client.heartbeat":
          return (await transport.heartbeat(
            input as SparkLocalRpcInput<"workspace.client.heartbeat">,
          )) as SparkLocalRpcOutput<M>;
        case "workspace.client.release":
          return (await transport.release(
            input as SparkLocalRpcInput<"workspace.client.release">,
          )) as SparkLocalRpcOutput<M>;
        default:
          throw new Error(`Unsupported Spark session heartbeat method: ${method}`);
      }
    },
  };
  return await startSparkDaemonSessionHeartbeat({
    client,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    attach: {
      workspaceId: options.workspaceId,
      kind: "interactive",
      displayName: "Spark TUI session",
      leaseTtlMs: options.leaseTtlMs ?? 60_000,
      sessionId: options.sessionId,
      metadata: { surface: "native-tui" },
    },
  });
}
