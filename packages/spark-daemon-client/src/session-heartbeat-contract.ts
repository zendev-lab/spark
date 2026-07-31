import type {
  SparkLocalRpcInput,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkDaemonClient, SparkDaemonClientOptions } from "./daemon-client.js";

export type SparkDaemonSessionAttachInput = SparkLocalRpcInput<"workspace.client.attach"> & {
  sessionId: string;
};
export type SparkDaemonSessionLeaseResult = SparkLocalRpcOutput<"workspace.client.attach">;
export type SparkDaemonSessionTimerHandle = ReturnType<typeof setTimeout> | number;

export interface SparkDaemonSessionLease {
  workspaceId: string;
  clientId: string;
  sessionId: string;
  leaseFence: string;
  leaseExpiresAt?: string;
}

export type SparkDaemonSessionHeartbeatEvent =
  | { type: "attached" | "reattached"; lease: SparkDaemonSessionLease }
  | { type: "heartbeat"; lease: SparkDaemonSessionLease }
  | { type: "retry"; attempt: number; delayMs: number; error: unknown }
  | { type: "released"; lease: SparkDaemonSessionLease }
  | { type: "release_failed"; lease: SparkDaemonSessionLease; error: unknown };

export interface SparkDaemonSessionHeartbeatOptions {
  attach: SparkDaemonSessionAttachInput;
  client?: SparkDaemonClient;
  clientOptions?: SparkDaemonClientOptions;
  heartbeatIntervalMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => SparkDaemonSessionTimerHandle;
  cancelSchedule?: (handle: SparkDaemonSessionTimerHandle) => void;
  onEvent?: (event: SparkDaemonSessionHeartbeatEvent) => void;
}

export interface SparkDaemonSessionHeartbeatHandle {
  readonly lease: SparkDaemonSessionLease | undefined;
  heartbeat(): Promise<void>;
  stop(): Promise<SparkDaemonSessionLeaseResult | null>;
}

export function normalizeSessionAttachInput(
  input: SparkDaemonSessionAttachInput,
): SparkDaemonSessionAttachInput {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("sessionId is required for a durable daemon session lease");
  return { ...input, sessionId };
}

export function sessionLeaseFromResult(
  result: SparkDaemonSessionLeaseResult,
  attach: SparkDaemonSessionAttachInput,
  expectedClientId?: string,
): SparkDaemonSessionLease {
  const { client } = result;
  if (client.sessionId !== attach.sessionId) {
    throw new Error("Daemon workspace client returned a different sessionId");
  }
  if (!client.leaseFence) {
    throw new Error("Daemon workspace client returned an unfenced session lease");
  }
  if (client.workspaceId !== attach.workspaceId) {
    throw new Error("Daemon workspace client returned a different workspaceId");
  }
  if (expectedClientId && client.id !== expectedClientId) {
    throw new Error("Daemon workspace client heartbeat returned a different clientId");
  }
  return {
    workspaceId: client.workspaceId,
    clientId: client.id,
    sessionId: client.sessionId,
    leaseFence: client.leaseFence,
    ...(client.leaseExpiresAt ? { leaseExpiresAt: client.leaseExpiresAt } : {}),
  };
}

export function positiveSessionDelay(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return resolved;
}
