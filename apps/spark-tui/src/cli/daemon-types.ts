/** Shared `spark daemon ...` command, client, and workspace-attachment types. */

import type { SparkSessionMailMessage } from "../host/session-mail-store.ts";
import type { SparkSessionExportFormat } from "../host/session-navigation.ts";
import type { SparkNativeResponder, SparkNativeResponderContext } from "../native-tui.ts";
import type { ChannelStatusSnapshot } from "./channel-status.ts";
import type {
  DaemonSessionForkResult,
  DaemonSessionListResult,
  DaemonSessionShowResult,
  DaemonSessionTreeResult,
} from "./daemon-session.ts";
import type { SparkDaemonManagedSessionsClient } from "./session-registry.ts";
import type { SparkDaemonWorkspace, SparkWorkspaceClientKind } from "./daemon-contracts.ts";
import type { ChannelNotifySendResult } from "@zendev-lab/spark-channels";
import type { RoleRef } from "@zendev-lab/spark-core";
import type { SparkSessionInfo } from "@zendev-lab/spark-host/session-store";
import type {
  SparkAssignment,
  SparkDaemonEvent,
  SparkInteractionRequest,
  SparkInvocationListResult,
  SparkInvocationRetentionApplyResult,
  SparkInvocationRetentionPreviewResult,
  SparkInvocationRetryResult,
  SparkInvocationStatus,
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkModelControlSnapshot,
  SparkModelRef,
  SparkTurnCancelResult,
  SparkTurnResult,
  SparkTurnStatusResult,
  SparkTurnStreamPage,
  SparkTurnSubmitResult,
  SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

export type SparkDaemonCliAction =
  | "help"
  | "status"
  | "submit"
  | "invocation"
  | "start"
  | "sessions"
  | "ask"
  | "channel"
  | "runs"
  | "events"
  | "model"
  | "service";

export type SparkDaemonRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "all";

export interface SparkDaemonClientPaths {
  runtimeDir: string;
  socketPath: string;
  pidFile: string;
  lockPath: string;
}

export type SparkDaemonControlRequest = <M extends SparkLocalRpcMethod>(
  method: M,
  params: SparkLocalRpcInput<M>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export interface SparkDaemonTurnTransportRetryEvent {
  operation: "submit" | "read" | "retry";
  failureCount: number;
  error: string;
  nextRetryMs: number;
  recoveryAttempted: boolean;
  recoveryError?: string;
}

export interface SparkDaemonClientOptions {
  paths?: SparkDaemonClientPaths;
  startService?: (paths: SparkDaemonClientPaths) => unknown;
  daemonStatus?: (paths: SparkDaemonClientPaths) => Promise<SparkDaemonLocalStatus>;
  channelStatus?: (paths: SparkDaemonClientPaths) => Promise<ChannelStatusSnapshot>;
  channelReload?: (
    paths: SparkDaemonClientPaths,
    workspaceId: string,
  ) => Promise<ChannelStatusSnapshot>;
  turnSubmit?: (
    paths: SparkDaemonClientPaths,
    input: SparkDaemonTurnSubmitInput,
  ) => Promise<LocalTurnSubmitResult>;
  turnStatus?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string },
  ) => Promise<LocalTurnStatusResult>;
  turnCancel?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string; reason?: string },
  ) => Promise<LocalTurnCancelResult>;
  turnStream?: (
    paths: SparkDaemonClientPaths,
    input: { invocationId: string; after?: number; limit?: number },
  ) => Promise<LocalTurnStreamResult>;
  controlRequest?: SparkDaemonControlRequest;
  workspaceEnsureLocal?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceEnsureLocalInput,
  ) => Promise<SparkDaemonWorkspace>;
  workspaceResolveSessionCwd?: (
    paths: SparkDaemonClientPaths,
    input: SparkLocalRpcInput<"workspace.resolve-session-cwd">,
  ) => Promise<SparkSessionCwdResolution>;
  workspaceClientAttach?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientAttachInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceClientHeartbeat?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientHeartbeatInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceClientRelease?: (
    paths: SparkDaemonClientPaths,
    input: LocalWorkspaceClientReleaseInput,
  ) => Promise<LocalWorkspaceClientResult>;
  workspaceList?: (paths: SparkDaemonClientPaths) => Promise<LocalDaemonWorkspaceListResult>;
  sessionList?: (
    paths: SparkDaemonClientPaths,
    params?: { allWorkspaces?: boolean; history?: boolean },
  ) => Promise<LocalDaemonSessionListResult>;
  sessionExport?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; format: SparkSessionExportFormat; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  sessionReplay?: (
    paths: SparkDaemonClientPaths,
    params: { sessionId: string; leafId?: string | null },
  ) => Promise<LocalDaemonSessionTextResult>;
  runList?: (
    paths: SparkDaemonClientPaths,
    params?: { state?: SparkDaemonRunState; limit?: number },
  ) => Promise<LocalDaemonRunListResult>;
  runShow?: (
    paths: SparkDaemonClientPaths,
    params: { runId: string },
  ) => Promise<LocalDaemonRunShowResult>;
  eventsWatch?: (
    paths: SparkDaemonClientPaths,
    params?: { limit?: number },
  ) => Promise<LocalDaemonEventsWatchResult>;
  serviceCommand?: (argv: string[]) => Promise<number>;
  managedSessions?: SparkDaemonManagedSessionsClient;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Periodically re-run daemon service recovery after this many transport failures. */
  turnTransportRecoveryInterval?: number;
  /** Retry visibility hook; recurring failures otherwise fall back to stderr. */
  onTurnTransportRetry?: (event: SparkDaemonTurnTransportRetryEvent) => void;
  /** Called after a transport operation succeeds, allowing transient UI status to clear. */
  onTurnTransportReady?: () => void;
  sparkHome?: string;
}

export interface SparkDaemonLocalStatus {
  observedAt: string;
  servers: Array<{
    url: string;
    workspaceCount: number;
    wsConnected: boolean;
    lastHeartbeatAt?: string;
    lastDisconnectReason?: string;
  }>;
  invocations: Record<"queued" | "running" | "succeeded" | "failed" | "cancelled", number>;
  invocationHealth?: { oldestQueuedAt?: string; oldestRunningAt?: string };
  channelDeliveries?: {
    pending: number;
    retrying: number;
    inFlight: number;
    delivered: number;
    uncertain: number;
    oldestPendingAt?: string;
    lastError?: string;
    lastErrorAt?: string;
  };
  lifecycle?: {
    state: "starting" | "running" | "draining" | "stopping";
    phase?:
      | "initializing"
      | "serving"
      | "draining-active-work"
      | "draining-channel-ingress"
      | "stopping";
    restartRequestedAt?: string;
    stopRequestedAt?: string;
    stopReason?: string;
    drain?: {
      observedAt: string;
      stage: "active-work" | "channel-ingress";
      scheduler: Array<{ invocationId: string }>;
      direct: Array<{ invocationId: string }>;
    };
  };
}

export interface SparkDaemonTurnSubmitInput {
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  model?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
  messageMetadata?: Record<string, unknown>;
}

export interface SparkDaemonTurnSubmitTask extends SparkDaemonTurnSubmitInput {
  type: "session.run";
  actor?: string;
  note?: string;
  input?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
}

export interface SparkDaemonClientStatus {
  running: boolean;
  [key: string]: unknown;
}

export type LocalTurnSubmitResult = SparkTurnSubmitResult;

export type LocalTurnStatusResult = SparkTurnStatusResult;

export type LocalTurnStreamResult = SparkTurnStreamPage;

export type LocalTurnCancelResult = SparkTurnCancelResult;

export type LocalTurnResult = SparkTurnResult;

export type LocalInvocationListResult = SparkInvocationListResult;

export type LocalInvocationRetryResult = SparkInvocationRetryResult;

export type LocalInvocationRetentionPreviewResult = SparkInvocationRetentionPreviewResult;

export type LocalInvocationRetentionApplyResult = SparkInvocationRetentionApplyResult;

export interface LocalDaemonSessionListResult {
  sessions: SparkSessionInfo[];
  text: string;
  observedAt: string;
  allWorkspaces?: boolean;
  history?: boolean;
}

export interface LocalDaemonWorkspaceListResult {
  workspaces: SparkDaemonWorkspace[];
  observedAt: string;
}

export interface LocalDaemonSessionTextResult {
  sessionId: string;
  text: string;
  observedAt: string;
}

export interface LocalDaemonRunSummary {
  runKey: string;
  id: string;
  state: SparkDaemonRunState;
  sessionKey?: string;
  prompt?: string;
  enqueuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface LocalDaemonRunListResult {
  plane: "daemon";
  resource: "run";
  runs: LocalDaemonRunSummary[];
  text: string;
  observedAt: string;
}

export interface LocalDaemonRunShowResult {
  plane: "daemon";
  resource: "run";
  runKey: string;
  run?: LocalDaemonRunSummary;
  text: string;
  observedAt: string;
}

export interface LocalDaemonEventsWatchResult {
  plane: "daemon";
  resource: "events";
  events: SparkDaemonEvent[];
  text: string;
  observedAt: string;
}

export interface LocalWorkspaceEnsureLocalInput {
  localPath: string;
  displayName?: string;
  localWorkspaceKey?: string;
}

export interface LocalWorkspaceClientAttachInput {
  workspaceId: string;
  clientId?: string;
  kind: SparkWorkspaceClientKind;
  displayName?: string;
  leaseTtlMs?: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientHeartbeatInput {
  clientId: string;
  leaseTtlMs?: number;
  leaseFence?: string;
}

export interface LocalWorkspaceClientReleaseInput {
  clientId: string;
  leaseFence?: string;
}

export interface SparkWorkspaceClientLease {
  id: string;
  workspaceId: string;
  kind: SparkWorkspaceClientKind;
  displayName?: string;
  status: "connected" | "disconnected";
  attachedAt: string;
  lastSeenAt: string;
  leaseExpiresAt?: string;
  releasedAt?: string;
  sessionId?: string;
  leaseFence?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalWorkspaceClientResult {
  client: SparkWorkspaceClientLease;
  workspace: SparkDaemonWorkspace;
  observedAt: string;
}

export interface SparkWorkspaceClientHandle {
  client: SparkWorkspaceClientLease;
  workspace: SparkDaemonWorkspace;
  cwd: string;
  cwdArtifactRef?: string;
  heartbeat(): Promise<LocalWorkspaceClientResult>;
  release(): Promise<LocalWorkspaceClientResult | null>;
}

export interface SparkSessionCwdResolution {
  workspace: SparkDaemonWorkspace;
  cwd: string;
  cwdArtifactRef?: string;
}

export interface AttachSparkWorkspaceClientOptions {
  kind: SparkWorkspaceClientKind;
  clientId?: string;
  displayName?: string;
  /** Attach an already-registered workspace without ensuring the launch cwd. */
  workspaceId?: string;
  /** Explicitly selected local path to ensure before attach. Mutually exclusive with workspaceId. */
  localPath?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number | false;
  metadata?: Record<string, unknown>;
  /** Called when a lease-transfer consent request appears for this workspace. */
  onLeaseTransferPrompt?: (transfer: {
    transferId: string;
    workspaceDisplayName: string;
    targetServerUrl: string;
    previousServerUrl: string;
    expiresAt: string;
  }) => void | Promise<"accept" | "reject" | void>;
}

export interface SparkDaemonCliCommandBase {
  action: SparkDaemonCliAction;
  json?: boolean;
}

export interface SparkDaemonHelpCommand extends SparkDaemonCliCommandBase {
  action: "help";
}

export interface SparkDaemonStatusCommand extends SparkDaemonCliCommandBase {
  action: "status";
}

export interface SparkDaemonSubmitCommand extends SparkDaemonCliCommandBase {
  action: "submit";
  sessionId: string;
  prompt: string;
  idempotencyKey?: string;
  model?: string;
  reset?: boolean;
  assignment?: SparkAssignment;
}

export interface SparkDaemonInvocationCommand extends SparkDaemonCliCommandBase {
  action: "invocation";
  subcommand: "list" | "status" | "result" | "stream" | "cancel" | "retry" | "retention";
  invocationId?: string;
  status?: SparkInvocationStatus;
  sessionId?: string;
  since?: string;
  before?: string;
  offset?: number;
  after?: number;
  limit?: number;
  eventLimit?: number;
  retentionAction?: "preview" | "apply";
  confirm?: boolean;
  reason?: string;
}

export interface SparkDaemonSessionsCommand extends SparkDaemonCliCommandBase {
  action: "sessions";
  subcommand:
    | "list"
    | "show"
    | "tree"
    | "fork"
    | "clone"
    | "export"
    | "replay"
    | "inbox"
    | "create"
    | "bind"
    | "unbind"
    | "archive"
    | "restore"
    | "close";
  sessionId?: string;
  format?: SparkSessionExportFormat;
  leafId?: string | null;
  allWorkspaces?: boolean;
  history?: boolean;
  registry?: boolean;
  includeArchived?: boolean;
  query?: string;
  tags?: string[];
  newSessionId?: string;
  inboxAction?: "list" | "read" | "ack";
  messageId?: string;
  all?: boolean;
  workspaceId?: string;
  name?: string;
  roleRef?: RoleRef;
  inheritRole?: boolean;
  placement?: "child" | "sibling";
  supervisorSessionId?: string;
  externalKey?: string;
}

export interface SparkDaemonAskCommand extends SparkDaemonCliCommandBase {
  action: "ask";
  subcommand: "list" | "answer" | "cancel";
  interactionRequestId?: string;
  sessionId?: string;
  invocationId?: string;
  answers?: Record<string, unknown>;
}

export interface SparkDaemonChannelCommand extends SparkDaemonCliCommandBase {
  action: "channel";
  subcommand: "list" | "status" | "reload" | "notify";
  workspaceId: string;
  notifyAction?: "test" | "send";
  route?: string;
  adapter?: string;
  recipient?: string;
  text?: string;
  imageUrl?: string;
  imageType?: string;
}

export interface SparkDaemonRunsCommand extends SparkDaemonCliCommandBase {
  action: "runs";
  subcommand: "list" | "show" | "cancel";
  runId?: string;
  state?: SparkDaemonRunState;
  limit?: number;
}

export interface SparkDaemonEventsCommand extends SparkDaemonCliCommandBase {
  action: "events";
  subcommand: "watch";
  limit?: number;
}

export interface SparkDaemonModelCommand extends SparkDaemonCliCommandBase {
  action: "model";
  subcommand: "list" | "status" | "set";
  all?: boolean;
  sessionId?: string;
  model?: SparkModelRef;
  target?: "session" | "default";
}

export interface SparkDaemonStartCommand extends SparkDaemonCliCommandBase {
  action: "start";
}

export interface SparkDaemonServiceCommand extends SparkDaemonCliCommandBase {
  action: "service";
  argv: string[];
}

export type SparkDaemonCliCommand =
  | SparkDaemonHelpCommand
  | SparkDaemonStatusCommand
  | SparkDaemonSubmitCommand
  | SparkDaemonInvocationCommand
  | SparkDaemonSessionsCommand
  | SparkDaemonAskCommand
  | SparkDaemonChannelCommand
  | SparkDaemonRunsCommand
  | SparkDaemonEventsCommand
  | SparkDaemonModelCommand
  | SparkDaemonStartCommand
  | SparkDaemonServiceCommand;

export type SparkDaemonCliResult =
  | { action: "help"; text: string }
  | SparkDaemonStatusResult
  | SparkDaemonSubmitResult
  | SparkDaemonInvocationResult
  | SparkDaemonSessionsResult
  | SparkDaemonAskResult
  | SparkDaemonChannelResult
  | SparkDaemonRunsResult
  | SparkDaemonEventsResult
  | SparkDaemonModelResult
  | SparkDaemonStartResult;

export interface SparkDaemonStatusResult {
  action: "status";
  daemon: SparkDaemonClientStatus;
}

export interface SparkDaemonSubmitResult {
  action: "submit";
  result: LocalTurnSubmitResult;
}

export interface SparkDaemonInvocationResult {
  action: "invocation";
  result:
    | LocalInvocationListResult
    | LocalTurnStatusResult
    | LocalTurnResult
    | LocalTurnStreamResult
    | LocalTurnCancelResult
    | LocalInvocationRetryResult
    | LocalInvocationRetentionPreviewResult
    | LocalInvocationRetentionApplyResult;
}

export interface SparkDaemonSessionsResult {
  action: "sessions";
  result:
    | LocalDaemonSessionListResult
    | LocalDaemonSessionTextResult
    | LocalDaemonSessionInboxListResult
    | LocalDaemonSessionMailMessageResult
    | DaemonSessionListResult
    | DaemonSessionShowResult
    | DaemonSessionTreeResult
    | DaemonSessionForkResult
    | ManagedSessionRegistryResult;
}

export interface ManagedSessionRegistryResult {
  plane: "daemon";
  resource: "session";
  subcommand: "create" | "bind" | "unbind" | "archive" | "restore" | "close" | "list";
  sessions?: Array<Record<string, unknown>>;
  session?: Record<string, unknown>;
  text: string;
  observedAt: string;
}

export interface SparkDaemonPendingHumanInteraction {
  humanRequestId: string;
  interactionRequestId: string;
  sessionId: string;
  invocationId: string;
  title: string;
  prompt: string;
  questions: Array<{
    id: string;
    prompt: string;
    options?: Array<{ value: string; label: string }>;
  }>;
  createdAt: string;
}

export type SparkDaemonAskCommandResult =
  | {
      subcommand: "list";
      waits: SparkDaemonPendingHumanInteraction[];
      text: string;
      observedAt: string;
    }
  | {
      subcommand: "answer" | "cancel";
      result: SparkDaemonHumanInteractionRespondResult;
      text: string;
      observedAt: string;
    };

export interface SparkDaemonAskResult {
  action: "ask";
  result: SparkDaemonAskCommandResult;
}

export interface SparkDaemonChannelResult {
  action: "channel";
  result: ChannelStatusSnapshot | ChannelNotifySendResult;
}

export interface LocalDaemonSessionInboxListResult {
  subcommand: "inbox";
  sessionId: string;
  messages: Array<
    SparkSessionMailMessage & { status: "pending" | "read" | "acked"; preview: string }
  >;
  text: string;
  observedAt: string;
}

export interface LocalDaemonSessionMailMessageResult {
  subcommand: "inbox";
  inboxAction: "read" | "ack";
  sessionId: string;
  message: SparkSessionMailMessage & { status: "pending" | "read" | "acked" };
  text: string;
  observedAt: string;
}

export interface SparkDaemonRunsResult {
  action: "runs";
  result: LocalDaemonRunListResult | LocalDaemonRunShowResult | LocalTurnCancelResult;
}

export interface SparkDaemonEventsResult {
  action: "events";
  result: LocalDaemonEventsWatchResult;
}

export interface SparkDaemonModelCommandResult {
  subcommand: "list" | "status" | "set";
  snapshot: SparkModelControlSnapshot;
  models?: SparkModelControlSnapshot["providers"][number]["models"];
  selected?: SparkModelRef;
  text: string;
}

export interface SparkDaemonModelResult {
  action: "model";
  result: SparkDaemonModelCommandResult;
}

export interface SparkDaemonStartResult {
  action: "start";
  daemon: SparkDaemonClientStatus;
}

export interface SparkDaemonNativeResponderOptions {
  /** Daemon registry session identifier used for session/turn RPCs. */
  sessionId?: string;
  /** Canonical host/claim owner identity exposed by the responder. */
  identitySessionId?: string;
  workspaceId?: string;
  cwd?: string;
  ensureSession?: () => Promise<void>;
  waitForCompletion?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Let protocol view events own conversation rendering instead of text-only chunks. */
  conversationProjection?: "assistant-chunks" | "view-events";
  onViewEvent?: (event: SparkViewModelEvent) => void;
  onInteractionRequest?: (
    request: SparkInteractionRequest,
    event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
    context: { signal?: AbortSignal },
  ) => void | Promise<void>;
}

export type SparkDaemonNativeResponderContext = Omit<SparkNativeResponderContext, "messages"> & {
  messages?: SparkNativeResponderContext["messages"];
};

export type SparkDaemonNativeResponder = SparkNativeResponder &
  Required<
    Pick<
      SparkNativeResponder,
      "admit" | "observe" | "cancel" | "retry" | "latestRetryableFailure" | "status"
    >
  > & {
    sessionId: string;
  } & ((input: string, context?: SparkDaemonNativeResponderContext) => Promise<string>);

export interface SparkDaemonNativeCommandOptions {
  /** Preferred session whose pending Ask requests `/ask` opens first. */
  sessionId?: string;
  /** Same-workspace fallback when the current session has no pending Ask. */
  workspaceId?: string;
}

export interface SparkDaemonHumanInteractionRespondInput {
  interactionRequestId: string;
  sessionId?: string;
  invocationId?: string;
  humanResponseId?: string;
  status: "answered" | "cancelled";
  answers?: Record<string, unknown>;
  responseArtifactRefs?: string[];
}

export interface SparkDaemonHumanInteractionRespondResult {
  outcome:
    | "accepted"
    | "replayed"
    | "already_resolved"
    | "orphaned"
    | "unknown_request"
    | "transient";
  retryable: boolean;
  returnedToTool: boolean;
  message: string;
  winnerResponseId?: string;
}

export interface SparkDaemonPendingHumanInteractionIdentity {
  interactionRequestId: string;
  sessionId: string;
  invocationId?: string;
}

/** Read daemon-owned pending Ask state without inferring lifecycle from event history. */

export interface SparkDaemonHumanInteractionRequestHandlerOptions {
  currentSessionId: string;
  client?: SparkDaemonClientOptions;
  signal?: AbortSignal;
  reopenDelayMs?: number;
  interaction(request: SparkInteractionRequest): Promise<unknown>;
  notify(message: string, level: "success" | "warning"): void;
}

/** Keep a daemon-owned Ask visible until its answer reaches the owning wait. */

export interface SparkDaemonServiceCommandOptions {
  daemonAppDir?: string;
  env?: NodeJS.ProcessEnv;
  buildSource?: (daemonAppDir: string, env: NodeJS.ProcessEnv) => number | null;
}
