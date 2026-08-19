import { join } from "node:path";
import { sparkLocalRpcProcedureSchemas } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type {
  SparkAssignment,
  SparkDaemonEvent,
  SparkInvocationListResult,
  SparkInvocationRetentionPreviewResult,
  SparkInvocationRetryResult,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
  SparkLocalRpcParsedInput,
  SparkTurnCancelResult,
  SparkTurnResult,
  SparkTurnStatusResult,
  SparkTurnStreamPage,
  SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import type { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";
import type { DaemonChannelIngressRuntime } from "../channels/ingress.ts";
import type {
  SparkDaemonHumanInteractionResponder,
  SparkDaemonLifecycleSnapshot,
  SparkDaemonRestartRequestResult,
} from "../core/index.ts";
import type { SparkDaemonHumanWaitRegistry } from "../core/human-waits.ts";
import type { SparkDaemonLeaseTransferBroker } from "../core/lease-transfer.ts";
import type { SparkDaemonModelControl } from "../model-control.ts";
import type { SparkDaemonRelocationRequest, SparkDaemonRelocationResult } from "../relocation.ts";
import type { DaemonSessionRegistry } from "../session-registry.ts";
import type { SessionSupervisor } from "../session-supervisor.ts";
import type { SessionNotificationDeliveryQueue } from "../session-notification-delivery.ts";
import type { SparkChannelDeliverySummary } from "../store/channel-deliveries.ts";
import type {
  RegisterWorkspaceOptions,
  SparkDaemonWorkspace,
  SparkDaemonWorkspaceClient,
  WorkspacePathConflictError,
} from "../store/workspaces.js";

type EnsureSparkDaemonRegistrationForWorkspace =
  typeof import("../registration.js").ensureSparkDaemonRegistrationForWorkspace;
type VerifySparkDaemonWorkspaceConnection =
  typeof import("../registration.js").verifySparkDaemonWorkspaceConnection;
type UnbindSparkDaemonWorkspaceFromHub =
  typeof import("../registration.js").unbindSparkDaemonWorkspaceFromHub;
type RelocateSparkDaemonHub = typeof import("../relocation.ts").relocateSparkDaemonHub;

export interface LocalRpcServer {
  socketPath: string;
  close(): Promise<void>;
}

export interface SparkDaemonLocalEventBus {
  publish(event: SparkDaemonEvent): void;
  subscribe(listener: (event: SparkDaemonEvent) => void): () => void;
}

export function createSparkDaemonLocalEventBus(): SparkDaemonLocalEventBus {
  const listeners = new Set<(event: SparkDaemonEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface WorkspaceListResult {
  workspaces: SparkDaemonWorkspace[];
  observedAt: string;
}

export interface LocalDaemonStatusResult {
  servers: Array<{
    url: string;
    workspaceCount: number;
    wsConnected: boolean;
    lastHeartbeatAt?: string;
    lastDisconnectReason?: string;
  }>;
  invocations: Record<"queued" | "running" | "succeeded" | "failed" | "cancelled", number>;
  invocationHealth: { oldestQueuedAt?: string; oldestRunningAt?: string };
  execution?: {
    backend: "in_process";
    rootConcurrency: number;
    questionOverflow: 1;
  };
  channelDeliveries?: SparkChannelDeliverySummary;
  lifecycle: SparkDaemonLifecycleSnapshot;
  buildFingerprint?: string;
  observedAt: string;
}

export type LocalInvocationListResult = SparkInvocationListResult;
export type LocalInvocationRetryResult = SparkInvocationRetryResult;
export type LocalInvocationRetentionPreviewResult = SparkInvocationRetentionPreviewResult;
export type LocalTurnResult = SparkTurnResult;
export type LocalTurnSubmitResult = SparkTurnSubmitResult;
export type LocalTurnStatusResult = SparkTurnStatusResult;
export type LocalTurnStreamResult = SparkTurnStreamPage;

export type LocalTurnCancelResult = SparkTurnCancelResult;

export interface LocalDaemonStopResult {
  stopping: true;
  observedAt: string;
}

export type LocalDaemonRestartResult = SparkDaemonRestartRequestResult;

export interface LocalWorkspaceRegisterRequest extends RegisterWorkspaceOptions {
  registrationToken?: string;
}

export type LocalWorkspaceRelocateRequest = SparkDaemonRelocationRequest;
export type LocalWorkspaceRelocateResult = SparkDaemonRelocationResult;
export type LocalWorkspaceLifecycleMutation = SparkLocalRpcParsedInput<"workspace.lifecycle">;
export type LocalWorkspaceLifecycleMutationResult = SparkLocalRpcOutput<"workspace.lifecycle">;

export interface LocalWorkspaceEnsureLocalRequest {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
}

export interface LocalWorkspaceClientAttachRequest {
  workspaceId: string;
  clientId?: string;
  kind: SparkDaemonWorkspaceClient["kind"];
  displayName?: string;
  leaseTtlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientHeartbeatRequest {
  clientId: string;
  leaseTtlMs?: number;
}

export interface LocalWorkspaceExecutorEnsureRequest {
  workspaceId: string;
  clientId?: string;
  displayName?: string;
  leaseTtlMs?: number;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientResult {
  client: SparkDaemonWorkspaceClient;
  workspace: SparkDaemonWorkspace;
  observedAt: string;
}

export type LocalRpcMailStore = Pick<SparkSessionMailStore, "list"> &
  Partial<
    Pick<
      SparkSessionMailStore,
      | "ack"
      | "get"
      | "read"
      | "recordChannelDelivery"
      | "recordRequestAdmission"
      | "send"
      | "pendingRequestsForSession"
    >
  >;

export interface LocalRpcHandlerOptions {
  ensureSparkDaemonRegistrationForWorkspace?: EnsureSparkDaemonRegistrationForWorkspace;
  verifySparkDaemonWorkspaceConnection?: VerifySparkDaemonWorkspaceConnection;
  unbindSparkDaemonWorkspaceFromHub?: UnbindSparkDaemonWorkspaceFromHub;
  channelIngress?: Pick<DaemonChannelIngressRuntime, "status" | "configure" | "reload" | "notify">;
  sessionRegistry?: DaemonSessionRegistry;
  sessionSupervisor?: SessionSupervisor;
  modelControl?: SparkDaemonModelControl;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  respondHumanInteraction?: SparkDaemonHumanInteractionResponder;
  leaseTransfers?: SparkDaemonLeaseTransferBroker;
  onHumanRequestOutboxReady?: () => void;
  /** Wake the daemon scheduler after local turn admission instead of waiting for its poll interval. */
  onInvocationQueued?: () => void;
  getRuntimeIdForServer?: (serverUrl: string) => string | undefined;
  mailStore?: LocalRpcMailStore;
  notificationDeliveryQueue?: SessionNotificationDeliveryQueue;
  onStopRequested?: () => void;
  onRestart?: () => LocalDaemonRestartResult | Promise<LocalDaemonRestartResult>;
  relocateSparkDaemonHub?: RelocateSparkDaemonHub;
  onUplinkReconfigure?: (serverUrl?: string) => void;
  getLifecycle?: () => SparkDaemonLifecycleSnapshot;
  getBuildFingerprint?: () => string;
  getExecutionStatus?: () => NonNullable<LocalDaemonStatusResult["execution"]>;
  /** Startup fence: before this opens, only readiness/status and stop are admitted. */
  isReady?: () => boolean;
  eventBus?: SparkDaemonLocalEventBus;
}

export type LocalRpcServiceRequest = {
  [M in SparkLocalRpcMethod]: {
    method: M;
    params: SparkLocalRpcParsedInput<M>;
  };
}[SparkLocalRpcMethod];

/** Output union correlated to one request or request-family method union. */
export type LocalRpcServiceOutput<Request extends LocalRpcServiceRequest> = Request extends {
  method: infer Method extends SparkLocalRpcMethod;
}
  ? SparkLocalRpcOutput<Method>
  : never;

/**
 * The protocol catalog is the one runtime narrowing boundary for domain values
 * whose owning subsystem exposes a deliberately broader persistence/projection
 * type. The cast only restores the method/schema correlation lost by indexed
 * access through a generic method.
 */
export function parseLocalRpcServiceOutput<Method extends SparkLocalRpcMethod>(
  method: Method,
  value: unknown,
): SparkLocalRpcOutput<Method> {
  return sparkLocalRpcProcedureSchemas[method].output.parse(value) as SparkLocalRpcOutput<Method>;
}

/** Temporary 0.1.x NDJSON envelope; method/input correlation remains protocol-owned. */
export type LocalRpcRequest = { id: string } & LocalRpcServiceRequest;

export type LocalHumanInteractionListParams = SparkLocalRpcParsedInput<"human.interaction.list">;
export type LocalHumanInteractionListResult = SparkLocalRpcOutput<"human.interaction.list">;

export type LocalHumanInteractionRespondParams =
  SparkLocalRpcParsedInput<"human.interaction.respond">;

export type LocalHumanInteractionRespondResult = SparkLocalRpcOutput<"human.interaction.respond">;

export type LocalRpcErrorPayload = {
  message: string;
  code?: string;
  kind?: WorkspacePathConflictError["kind"];
  certainty?: "not-sent" | "unknown";
};

export type LocalRpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: LocalRpcErrorPayload };

export type LocalTurnSubmitParams = SparkLocalRpcParsedInput<"turn.submit">;

export type LocalWorkspaceRegisterParams = SparkLocalRpcParsedInput<"workspace.register">;

export type LocalWorkspaceEnsureLocalParams = LocalWorkspaceEnsureLocalRequest;
export type LocalWorkspaceClientAttachParams = LocalWorkspaceClientAttachRequest;
export type LocalWorkspaceClientHeartbeatParams = LocalWorkspaceClientHeartbeatRequest;
export type LocalWorkspaceExecutorEnsureParams = LocalWorkspaceExecutorEnsureRequest;

export class LocalRpcUnavailableError extends Error {}

export class SparkDaemonStillStartingError extends Error {}

export function localRpcSocketPath(paths: SparkPaths): string {
  return join(paths.runtimeDir, "daemon.sock");
}
