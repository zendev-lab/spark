/** `spark daemon ...` command parsing and Spark daemon IPC client operations. */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { ChannelNotifySendResult } from "@zendev-lab/spark-channels";
import type { RoleRef } from "@zendev-lab/spark-core";
import {
  createId,
  hasNonEmptySparkHumanAnswer,
  isTerminalSparkHumanInteractionDelivery,
  parseSparkModelValue,
  parseSparkDaemonEvent,
  parseSparkInteractionResponse,
  parseSparkSessionPromptHistory,
  parseSparkSessionView,
  SPARK_SESSION_PROMPT_HISTORY_MAX,
  sparkLocalRpcProcedureSchemas,
  sparkModelValue,
  sparkSessionSubmittedInputSchema,
  type SparkAssignment,
  type SparkDaemonEvent,
  type SparkInvocationListResult,
  type SparkInvocationRetentionApplyResult,
  type SparkInvocationRetentionPreviewResult,
  type SparkInvocationRetryResult,
  type SparkInvocationStatus,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkLocalRpcInput,
  type SparkLocalRpcMethod,
  type SparkLocalRpcOutput,
  type SparkModelControlSnapshot,
  type SparkModelRef,
  type SparkSessionCreateRequest,
  type SparkSessionListRequest,
  type SparkSessionPromptHistory,
  type SparkSessionProjection,
  type SparkSessionView,
  type SparkViewModelEvent,
  type SparkTurnCancelResult,
  type SparkTurnResult,
  type SparkTurnStatusResult,
  type SparkTurnStreamPage,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import { sparkDaemonCliStrings } from "@zendev-lab/spark-i18n/cli";
import { cappedExponentialCeiling, equalJitter } from "@zendev-lab/spark-retry";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  requestSparkDaemon,
  SparkDaemonRemoteError,
  SparkDaemonRpcError,
  SparkDaemonUnavailableError,
  type SparkDaemonSessionHeartbeatHandle,
} from "@zendev-lab/spark-daemon-client";
import { SparkSessionStore, type SparkSessionInfo } from "@zendev-lab/spark-host/session-store";

import {
  exportSparkSessionRecord,
  formatSessionReplay,
  readSparkSessionExportFormat,
  type SparkSessionExportFormat,
} from "../host/session-navigation.ts";
import { sessionMailStatus, type SparkSessionMailMessage } from "../host/session-mail-store.ts";
import {
  forkDaemonSession,
  listDaemonSessions,
  listLiveDaemonSessions,
  showDaemonSession,
  treeDaemonSession,
  type DaemonSessionForkResult,
  type DaemonSessionListResult,
  type DaemonSessionShowResult,
  type DaemonSessionTreeResult,
} from "./daemon-session.ts";
import {
  createDaemonManagedSessionsClient,
  renderManagedSession,
  type SparkDaemonManagedSessionsClient,
} from "./session-registry.ts";
import type { ChannelStatusSnapshot } from "./channel-status.ts";
import {
  attachSparkWorkspaceSessionHeartbeat,
  type AttachSparkWorkspaceSessionClientOptions,
} from "./daemon-session-heartbeat.ts";
import {
  SparkNativeAdmissionError,
  type SparkNativeAdmissionContext,
  type SparkNativeInvocationStatusContext,
  type SparkNativeResponder,
  type SparkNativeResponderContext,
  type SparkNativeSlashCommandMap,
} from "../native-tui.ts";
import {
  consoleSparkCliOutput,
  helpFlagRequested,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";

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

const STRINGS = sparkDaemonCliStrings();
// Accepted invocations are durable and scheduler execution time pauses during
// human interaction. Keep reads unbounded by default; callers own cancellation
// through AbortSignal and may still provide an explicit timeout.
const DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS = Number.POSITIVE_INFINITY;
const TURN_TRANSPORT_RETRY_BASE_MS = 100;
const TURN_TRANSPORT_RETRY_MAX_MS = 5_000;
const TURN_TRANSPORT_RECOVERY_INTERVAL = 4;
const HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS = 4;
const HUMAN_INTERACTION_RESPONSE_RETRY_BASE_MS = 50;
const DAEMON_PROCESS_STARTUP_GRACE_MS = 10 * 60_000;

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

import type { SparkDaemonWorkspace, SparkWorkspaceClientKind } from "./daemon-contracts.ts";
export type {
  SparkDaemonWorkspace,
  SparkWorkspaceClientKind,
  SparkWorkspaceClientProjection,
} from "./daemon-contracts.ts";

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

export type { AttachSparkWorkspaceSessionClientOptions } from "./daemon-session-heartbeat.ts";

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

export function parseSparkDaemonCliArgs(argv: string[]): SparkDaemonCliCommand {
  if (argv.length === 0) {
    return { action: "service", argv: [] };
  }

  const [action, ...rest] = argv;
  if (action === "help" || action === "--help" || action === "-h") {
    return { action: "help" };
  }
  if (helpFlagRequested(argv)) {
    return { action: "help" };
  }

  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");

  switch (action) {
    case "status":
      return { action: "status", json };
    case "submit": {
      const sessionId = readStringOption(parsed.options, "session")?.trim();
      const prompt = readPrompt(parsed);
      const idempotencyKey = readStringOption(parsed.options, "idempotency-key")?.trim();
      if (!sessionId) throw new Error(STRINGS.submitRequiresSession);
      if (!prompt) throw new Error(STRINGS.submitRequiresPrompt);
      return {
        action: "submit",
        json,
        sessionId,
        prompt,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        reset: readBooleanOption(parsed.options, "reset"),
      };
    }
    case "invocation":
      return parseSparkDaemonInvocationCommand(parsed, json);
    case "queue":
      throw new Error(STRINGS.unknownCommand("queue"));
    case "session":
    case "sessions":
      return parseSparkDaemonSessionsCommand(parsed, json);
    case "ask":
    case "human":
      return parseSparkDaemonAskCommand(parsed, json);
    case "channel":
    case "channels":
      return parseSparkDaemonChannelCommand(parsed, json);
    case "run":
    case "runs":
      return parseSparkDaemonRunsCommand(parsed, json);
    case "events":
      return parseSparkDaemonEventsCommand(parsed, json);
    case "model":
      return parseSparkDaemonModelCommand(parsed, json);
    case "start":
      return { action: "start", json };
    case "stop":
    case "install":
    case "doctor":
    case "login":
    case "auth":
    case "workspace":
    case "ws":
    case "uplink":
      return { action: "service", argv };
    case "restart":
    case "logs":
      return { action: "service", argv: ["daemon", ...argv] };
    default:
      throw new Error(STRINGS.unknownCommand(String(action)));
  }
}

function parseSparkDaemonModelCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonModelCommand {
  const [subcommand = "list", modelValue, ...extraPositionals] = parsed.positionals;
  const sessionId = readStringOption(parsed.options, "session")?.trim();
  if (subcommand === "list") {
    assertOnlyModelOptions(parsed.options, ["all", "json"]);
    if (modelValue || extraPositionals.length > 0 || sessionId) {
      throw new Error("Usage: spark daemon model list [--all] [--json]");
    }
    assertBooleanModelOption(parsed.options, "all");
    return {
      action: "model",
      subcommand,
      json,
      all: readBooleanOption(parsed.options, "all"),
    };
  }
  if (subcommand === "status") {
    assertOnlyModelOptions(parsed.options, ["session", "json"]);
    if (modelValue || extraPositionals.length > 0) {
      throw new Error("Usage: spark daemon model status [--session <id>] [--json]");
    }
    return { action: "model", subcommand, json, ...(sessionId ? { sessionId } : {}) };
  }
  if (subcommand === "set") {
    assertOnlyModelOptions(parsed.options, ["session", "default", "json"]);
    assertBooleanModelOption(parsed.options, "default");
    if (!modelValue || extraPositionals.length > 0) {
      throw new Error(
        "Usage: spark daemon model set <provider/model> (--session <id>|--default) [--json]",
      );
    }
    const useDefault = readBooleanOption(parsed.options, "default");
    if (Boolean(sessionId) === useDefault) {
      throw new Error("spark daemon model set requires exactly one of --session <id> or --default");
    }
    return {
      action: "model",
      subcommand,
      json,
      model: parseSparkModelValue(modelValue),
      target: useDefault ? "default" : "session",
      ...(sessionId ? { sessionId } : {}),
    };
  }
  throw new Error(`unknown spark daemon model command: ${subcommand}`);
}

function assertOnlyModelOptions(
  options: Record<string, string | boolean>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(options).find((name) => !allowed.includes(name));
  if (unknown) throw new Error(`unknown spark daemon model option: --${unknown}`);
}

function assertBooleanModelOption(options: Record<string, string | boolean>, name: string): void {
  if (typeof options[name] === "string") {
    throw new Error(`--${name} does not accept a value`);
  }
}

function parseSparkDaemonInvocationCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonInvocationCommand {
  const [subcommand = "list", positionalInvocationId] = parsed.positionals;
  if (subcommand === "list") {
    return {
      action: "invocation",
      subcommand,
      json,
      status: readInvocationStatus(readStringOption(parsed.options, "status")),
      sessionId: readStringOption(parsed.options, "session")?.trim(),
      since: readInvocationSinceOption(parsed.options),
      limit: readNumberOption(parsed.options, "limit"),
      offset: readNumberOption(parsed.options, "offset"),
    };
  }
  if (subcommand === "retention") {
    const retentionAction = positionalInvocationId ?? "preview";
    if (retentionAction !== "preview" && retentionAction !== "apply") {
      throw new Error(`unknown spark daemon invocation retention command: ${retentionAction}`);
    }
    const before = readIsoDateTimeOption(parsed.options, "before");
    if (!before) throw new Error("spark daemon invocation retention requires --before <iso>");
    if (retentionAction === "apply" && !readBooleanOption(parsed.options, "confirm")) {
      throw new Error("spark daemon invocation retention apply requires --confirm");
    }
    return {
      action: "invocation",
      subcommand,
      before,
      limit: readNumberOption(parsed.options, "limit"),
      json,
      ...(retentionAction === "apply"
        ? {
            retentionAction,
            eventLimit: readNumberOption(parsed.options, "event-limit"),
            confirm: true,
          }
        : {}),
    };
  }
  if (
    subcommand !== "status" &&
    subcommand !== "result" &&
    subcommand !== "stream" &&
    subcommand !== "cancel" &&
    subcommand !== "retry"
  ) {
    throw new Error(`unknown spark daemon invocation command: ${subcommand}`);
  }
  const invocationId =
    readStringOption(parsed.options, "invocation")?.trim() || positionalInvocationId?.trim();
  if (!invocationId) {
    throw new Error(`spark daemon invocation ${subcommand} requires <invocation-id>`);
  }
  return {
    action: "invocation",
    subcommand,
    invocationId,
    json,
    ...(subcommand === "stream"
      ? {
          after: readNumberOption(parsed.options, "after"),
          limit: readNumberOption(parsed.options, "limit"),
        }
      : {}),
    ...(subcommand === "cancel"
      ? { reason: readStringOption(parsed.options, "reason")?.trim() }
      : {}),
  };
}

function parseSparkDaemonChannelCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonChannelCommand {
  const [subcommand = "status"] = parsed.positionals;
  if (subcommand === "list" || subcommand === "status" || subcommand === "reload") {
    const workspaceId = readStringOption(parsed.options, "workspace")?.trim();
    if (!workspaceId) {
      throw new Error(`spark daemon channel ${subcommand} requires --workspace <workspaceId>`);
    }
    return { action: "channel", subcommand, json, workspaceId };
  }
  if (subcommand !== "notify") {
    throw new Error(`unknown spark daemon channel command: ${subcommand}`);
  }
  const notifyAction = readStringOption(parsed.options, "action") ?? "test";
  if (notifyAction !== "test" && notifyAction !== "send") {
    throw new Error("spark daemon channel notify --action must be test or send");
  }
  const workspaceId = readStringOption(parsed.options, "workspace")?.trim();
  if (!workspaceId) {
    throw new Error("spark daemon channel notify requires --workspace <workspaceId>");
  }
  const optional = (name: string, key: string) => {
    const value = readStringOption(parsed.options, name);
    return value ? { [key]: value } : {};
  };
  return {
    action: "channel",
    subcommand: "notify",
    json,
    workspaceId,
    notifyAction,
    ...optional("route", "route"),
    ...optional("adapter", "adapter"),
    ...optional("recipient", "recipient"),
    ...optional("text", "text"),
    ...optional("image-url", "imageUrl"),
    ...optional("image-type", "imageType"),
  };
}

function readInvocationStatus(value: string | undefined): SparkInvocationStatus | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "succeeded" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  throw new Error(
    "spark daemon invocation --status must be queued, running, succeeded, failed, or cancelled",
  );
}

function readInvocationSinceOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
): string | undefined {
  const value = readStringOption(options, "since")?.trim();
  if (!value) return undefined;
  const relative = value.match(/^(\d+)(s|m|h|d)$/iu);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      relative[2]!.toLowerCase() as "s" | "m" | "h" | "d"
    ];
    const durationMs = amount * unitMs;
    if (amount < 1 || !Number.isSafeInteger(durationMs) || durationMs > 365 * 86_400_000) {
      throw new Error("spark daemon invocation --since duration must be between 1s and 365d");
    }
    return new Date(Date.now() - durationMs).toISOString();
  }
  return readIsoDateTimeOption(options, "since");
}

function readIsoDateTimeOption(
  options: ReturnType<typeof parseSparkCliOptions>["options"],
  name: string,
): string | undefined {
  const value = readStringOption(options, name)?.trim();
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`spark daemon invocation --${name} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function parseSparkDaemonSessionsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonSessionsCommand {
  const [subcommand = "list", maybeLeaf] = parsed.positionals;
  if (subcommand === "list") {
    const allWorkspaces = readBooleanOption(parsed.options, "all-workspaces");
    const query = readStringOption(parsed.options, "query")?.trim();
    const tagList = readStringOption(parsed.options, "tags")
      ?.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    return {
      action: "sessions",
      subcommand,
      json,
      allWorkspaces,
      history: readBooleanOption(parsed.options, "history") || allWorkspaces,
      registry: readBooleanOption(parsed.options, "registry"),
      includeArchived: readBooleanOption(parsed.options, "include-archived"),
      ...(query ? { query } : {}),
      ...(tagList?.length ? { tags: tagList } : {}),
      workspaceId: readStringOption(parsed.options, "workspace")?.trim(),
    };
  }
  if (subcommand === "create") {
    const workspaceId = readStringOption(parsed.options, "workspace")?.trim() || maybeLeaf?.trim();
    if (!workspaceId) throw new Error("spark daemon session create requires --workspace <id>");
    const supervisorSessionId = readStringOption(parsed.options, "supervisor")?.trim();
    if (!supervisorSessionId) {
      throw new Error("spark daemon session create requires --supervisor <session-id>");
    }
    const rawRoleRef = readStringOption(parsed.options, "role-ref")?.trim();
    if (rawRoleRef && !rawRoleRef.startsWith("role:")) {
      throw new Error("spark daemon session create --role-ref must start with role:");
    }
    const inheritRole = readBooleanOption(parsed.options, "inherit-role");
    if (rawRoleRef && inheritRole) {
      throw new Error(
        "spark daemon session create accepts only one of --role-ref and --inherit-role",
      );
    }
    const rawPlacement = readStringOption(parsed.options, "placement")?.trim() ?? "child";
    if (rawPlacement !== "child" && rawPlacement !== "sibling") {
      throw new Error("spark daemon session create --placement must be child or sibling");
    }
    return {
      action: "sessions",
      subcommand,
      json,
      workspaceId,
      name: readStringOption(parsed.options, "name")?.trim(),
      ...(rawRoleRef ? { roleRef: rawRoleRef as RoleRef } : {}),
      inheritRole,
      placement: rawPlacement,
      supervisorSessionId,
      sessionId: readStringOption(parsed.options, "id")?.trim(),
    };
  }
  if (subcommand === "bind" || subcommand === "unbind") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    const externalKey = readStringOption(parsed.options, "external-key")?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    if (!externalKey)
      throw new Error(`spark daemon session ${subcommand} requires --external-key <key>`);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      externalKey,
    };
  }
  if (subcommand === "archive" || subcommand === "restore" || subcommand === "close") {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(`spark daemon session ${subcommand} requires <session-id>`);
    return { action: "sessions", subcommand, json, sessionId };
  }
  if (subcommand === "inbox") {
    const [inboxActionOrMessageId, maybeMessageId] = parsed.positionals.slice(1);
    const inboxAction =
      inboxActionOrMessageId === "read" || inboxActionOrMessageId === "ack"
        ? inboxActionOrMessageId
        : "list";
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error("spark daemon session inbox requires --session <session-id>");
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      inboxAction,
      all: readBooleanOption(parsed.options, "all"),
      ...(inboxAction === "list"
        ? {}
        : {
            messageId:
              maybeMessageId?.trim() || readStringOption(parsed.options, "message")?.trim(),
          }),
    };
  }
  if (
    subcommand === "show" ||
    subcommand === "tree" ||
    subcommand === "fork" ||
    subcommand === "clone"
  ) {
    const sessionId = readStringOption(parsed.options, "session")?.trim() || maybeLeaf?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const newSessionId = readStringOption(parsed.options, "id")?.trim();
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(newSessionId ? { newSessionId } : {}),
    };
  }
  if (subcommand === "export") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsExportRequiresSession);
    const format = readSparkSessionExportFormat(
      readStringOption(parsed.options, "format") ?? "jsonl",
    );
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      format,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  if (subcommand === "replay") {
    const sessionId = readStringOption(parsed.options, "session")?.trim();
    if (!sessionId) throw new Error(STRINGS.sessionsReplayRequiresSession);
    const leafId = readDaemonLeafArg(readStringOption(parsed.options, "leaf") ?? maybeLeaf);
    return {
      action: "sessions",
      subcommand,
      json,
      sessionId,
      ...(leafId !== undefined ? { leafId } : {}),
    };
  }
  throw new Error(STRINGS.unknownSessionsCommand(subcommand));
}

function parseSparkDaemonRunsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonRunsCommand {
  const [subcommand = "list", maybeRunId] = parsed.positionals;
  if (subcommand === "list") {
    const state = readRunState(readStringOption(parsed.options, "state") ?? "all");
    const limit = readNumberOption(parsed.options, "limit");
    return { action: "runs", subcommand, json, state, limit };
  }
  if (subcommand === "show" || subcommand === "cancel") {
    const runId = readStringOption(parsed.options, "run")?.trim() || maybeRunId?.trim();
    if (!runId) throw new Error(`${subcommand} requires --run <id> or a run id argument`);
    return { action: "runs", subcommand, json, runId };
  }
  throw new Error(`unknown daemon run command: ${subcommand}`);
}

function parseSparkDaemonAskCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonAskCommand {
  const [subcommand = "list", positionalInteractionRequestId] = parsed.positionals;
  if (subcommand === "list") {
    return {
      action: "ask",
      subcommand,
      json,
      sessionId: readStringOption(parsed.options, "session")?.trim(),
    };
  }
  if (subcommand !== "answer" && subcommand !== "cancel") {
    throw new Error(`unknown spark daemon ask command: ${subcommand}`);
  }
  const interactionRequestId =
    readStringOption(parsed.options, "interaction")?.trim() ||
    positionalInteractionRequestId?.trim();
  if (!interactionRequestId) {
    throw new Error(`spark daemon ask ${subcommand} requires <interaction-request-id>`);
  }
  if (subcommand === "cancel") {
    return {
      action: "ask",
      subcommand,
      json,
      interactionRequestId,
      sessionId: readStringOption(parsed.options, "session")?.trim(),
      invocationId: readStringOption(parsed.options, "invocation")?.trim(),
    };
  }
  const rawAnswers =
    readStringOption(parsed.options, "answers") ?? readStringOption(parsed.options, "answer");
  if (!rawAnswers) throw new Error("spark daemon ask answer requires --answers <json>");
  let parsedAnswers: unknown;
  try {
    parsedAnswers = JSON.parse(rawAnswers);
  } catch (error) {
    throw new Error("spark daemon ask answer requires valid JSON in --answers", { cause: error });
  }
  if (!isRecord(parsedAnswers)) {
    throw new Error("spark daemon ask answer requires a JSON object in --answers");
  }
  return {
    action: "ask",
    subcommand,
    json,
    interactionRequestId,
    sessionId: readStringOption(parsed.options, "session")?.trim(),
    invocationId: readStringOption(parsed.options, "invocation")?.trim(),
    answers: parsedAnswers,
  };
}

function parseSparkDaemonEventsCommand(
  parsed: ReturnType<typeof parseSparkCliOptions>,
  json: boolean,
): SparkDaemonEventsCommand {
  const [subcommand = "watch"] = parsed.positionals;
  if (subcommand !== "watch") throw new Error(`unknown daemon events command: ${subcommand}`);
  return { action: "events", subcommand, json, limit: readNumberOption(parsed.options, "limit") };
}

export async function handleSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  client: SparkDaemonClientOptions = {},
): Promise<SparkDaemonCliResult> {
  switch (command.action) {
    case "help":
      return { action: "help", text: sparkDaemonHelpText() };
    case "status":
      return { action: "status", daemon: await clientStatus(client) };
    case "submit":
      return {
        action: "submit",
        result: await clientSubmit(
          {
            sessionId: command.sessionId,
            prompt: command.prompt,
            idempotencyKey: command.idempotencyKey,
            model: command.model,
            reset: command.reset,
            ...(command.assignment ? { assignment: command.assignment } : {}),
          },
          client,
        ),
      };
    case "invocation":
      return { action: "invocation", result: await clientInvocation(command, client) };
    case "sessions":
      return { action: "sessions", result: await clientSessions(command, client) };
    case "ask":
      return { action: "ask", result: await clientAsk(command, client) };
    case "channel":
      if (command.subcommand === "notify") {
        return {
          action: "channel",
          result: await clientChannelNotify(command, client),
        };
      }
      if (command.subcommand === "reload") {
        return { action: "channel", result: await clientChannelReload(command, client) };
      }
      return { action: "channel", result: await clientChannelStatus(command, client) };
    case "runs":
      return { action: "runs", result: await clientRuns(command, client) };
    case "events":
      return { action: "events", result: await clientEvents(command, client) };
    case "model":
      return { action: "model", result: await clientModel(command, client) };
    case "start":
      await ensureSparkDaemonClientRunning(client);
      return { action: "start", daemon: await clientStatus(client) };
    case "service":
      throw new Error(STRINGS.serviceCommandMustUseServiceRunner);
  }
}

export async function runSparkDaemonCliCommand(
  command: SparkDaemonCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  client: SparkDaemonClientOptions = {},
): Promise<number> {
  if (command.action === "service") {
    return await runSparkDaemonServiceCommand(command.argv, client);
  }

  const result = await handleSparkDaemonCliCommand(command, client);
  if (result.action === "help") {
    output.write(result.text);
    return 0;
  }
  if (result.action === "events" && command.json) {
    for (const event of result.result.events) output.write(`${JSON.stringify(event)}\n`);
    return 0;
  }
  if (
    (result.action === "sessions" ||
      result.action === "ask" ||
      result.action === "events" ||
      result.action === "channel" ||
      result.action === "model") &&
    !command.json
  ) {
    output.write(result.result.text);
    return 0;
  }
  if (result.action === "runs" && !command.json && "text" in result.result) {
    output.write(result.result.text);
    return 0;
  }
  if (result.action === "invocation" && !command.json) {
    output.write(renderInvocationResult(result.result));
    return 0;
  }
  printSparkCliResult(output, result, { json: command.json });
  return 0;
}

async function clientModel(
  command: SparkDaemonModelCommand,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonModelCommandResult> {
  if (command.subcommand === "set") {
    if (!command.model || !command.target) {
      throw new Error("Invalid spark daemon model set command.");
    }
    if (command.target === "default") {
      await requestSparkDaemonControl("model.default.set", { model: command.model }, client);
    } else {
      await requestSparkDaemonControl(
        "session.model.set",
        { sessionId: command.sessionId!, model: command.model },
        client,
      );
    }
  }

  const snapshot = await requestSparkDaemonControl(
    "model.catalog",
    command.sessionId ? { sessionId: command.sessionId } : {},
    client,
  );
  if (command.subcommand === "list") {
    const models = snapshot.providers
      .flatMap((provider) => provider.models)
      .filter((entry) => command.all || entry.available);
    const text =
      models.length === 0
        ? "No matching Spark models.\n"
        : `${models
            .map((entry) => {
              const marker = modelRefEquals(
                entry.model,
                snapshot.session?.model ?? snapshot.defaultModel,
              )
                ? "*"
                : " ";
              const availability = entry.available
                ? "available"
                : `unavailable: ${entry.unavailableReason ?? "authentication required"}`;
              return `${marker} ${sparkModelValue(entry.model)}  ${availability}`;
            })
            .join("\n")}\n`;
    return { subcommand: command.subcommand, snapshot, models, text };
  }

  const selected = snapshot.session?.model ?? snapshot.defaultModel;
  const scope = snapshot.session ? `session ${snapshot.session.sessionId}` : "default";
  const text = selected
    ? `${scope}: ${sparkModelValue(selected)}\n`
    : `${scope}: no model selected\n`;
  return {
    subcommand: command.subcommand,
    snapshot,
    ...(selected ? { selected } : {}),
    text,
  };
}

function modelRefEquals(left: SparkModelRef, right: SparkModelRef | undefined): boolean {
  return Boolean(
    right && left.providerName === right.providerName && left.modelId === right.modelId,
  );
}

function renderInvocationResult(result: SparkDaemonInvocationResult["result"]): string {
  if ("invocations" in result) {
    if (result.invocations.length === 0) return "No matching invocations.\n";
    return `${result.invocations
      .map(
        (invocation) =>
          `${invocation.invocationId} ${invocation.status} session=${invocation.sessionId ?? "-"} attempts=${invocation.attemptCount}${invocation.errorCode ? ` error=${invocation.errorCode}` : ""}`,
      )
      .join("\n")}\n`;
  }
  if ("retryOfInvocationId" in result) {
    return `${result.invocationId} queued retry-of=${result.retryOfInvocationId}\n`;
  }
  if ("dryRun" in result) {
    return `retention dry-run before=${result.before} invocations=${result.invocationIds.length} events=${result.eventCount} blocked=${result.blockedByDeliveryCount}\n`;
  }
  if ("assistantText" in result && result.assistantText) return `${result.assistantText}\n`;
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function sparkDaemonHelpText(): string {
  return STRINGS.helpText;
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

export function createSparkDaemonNativeResponder(
  client: SparkDaemonClientOptions = {},
  options: SparkDaemonNativeResponderOptions = {},
): SparkDaemonNativeResponder {
  const targetSessionId = options.sessionId ?? `spark-cli-${Date.now().toString(36)}`;
  const sessionId = options.identitySessionId?.trim() || targetSessionId;
  let sessionReady: Promise<void> | undefined;

  const ensureReady = async () => {
    if (options.ensureSession || options.workspaceId) {
      sessionReady ??= (
        options.ensureSession
          ? options.ensureSession()
          : ensureSparkDaemonWorkspaceSession(
              {
                sessionId: targetSessionId,
                workspaceId: options.workspaceId!,
                cwd: options.cwd ?? process.cwd(),
              },
              client,
            )
      ).catch((error) => {
        sessionReady = undefined;
        throw error;
      });
      await sessionReady;
    }
  };

  const admit = async (
    input: string,
    context: SparkNativeAdmissionContext = {},
  ): Promise<LocalTurnSubmitResult> => {
    const prompt = input.trim();
    if (!prompt) throw new Error(STRINGS.ignoredEmptyPrompt);
    const submittedInput = sparkSessionSubmittedInputSchema.safeParse({
      text: context.submittedInput,
    });
    let submissionStarted = false;
    try {
      await ensureReady();
      submissionStarted = true;
      return await clientSubmit(
        {
          sessionId: targetSessionId,
          prompt,
          idempotencyKey: context.submissionId,
          messageMetadata: {
            origin: { kind: "user", host: "tui", surface: "local" },
            ...(submittedInput.success ? { submittedInput: submittedInput.data } : {}),
          },
        },
        client,
        { signal: context.signal },
      );
    } catch (error) {
      if (context.signal?.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error("daemon admission aborted");
      }
      if (error instanceof SparkNativeAdmissionError) throw error;
      const remoteCause =
        error instanceof SparkDaemonRemoteError ||
        (error instanceof Error && error.cause instanceof SparkDaemonRemoteError);
      throw new SparkNativeAdmissionError(
        error instanceof Error ? error.message : String(error),
        !submissionStarted || remoteCause ? "rejected" : "unknown",
        { cause: error },
      );
    }
  };

  const observe = async (
    admission: LocalTurnSubmitResult,
    context: SparkNativeResponderContext,
  ): Promise<string> => {
    const live = createDaemonLiveAssistantRenderer(
      context,
      options.onViewEvent,
      options.onInteractionRequest,
      options.conversationProjection ?? "assistant-chunks",
    );
    if (live.onEvent) {
      await pollInvocationEvents(admission.invocationId, client, {
        signal: context?.signal,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        onEvent: live.onEvent,
      });
    }
    if (options.waitForCompletion === false) {
      return STRINGS.queuedSession(targetSessionId, admission.invocationId);
    }
    const finalText = await waitForSubmittedTurn(targetSessionId, admission, client, {
      signal: context?.signal,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
    });
    if (live.streamed) {
      context?.finishAssistantMessage?.();
      return "";
    }
    return finalText;
  };

  const responder = async (
    input: string,
    context?: SparkDaemonNativeResponderContext,
  ): Promise<string> => {
    const prompt = input.trim();
    if (!prompt) return STRINGS.ignoredEmptyPrompt;
    const responderContext: SparkNativeResponderContext = {
      ...context,
      messages: context?.messages ?? [],
    };
    const admission = await admit(prompt, {
      submissionId: responderContext.submissionId,
      signal: responderContext.signal,
    });
    return await observe(admission, responderContext);
  };

  return Object.assign(responder, {
    sessionId,
    admit,
    observe,
    cancel: async (invocationId: string, reason: string) =>
      await clientCancelTurn({ invocationId, reason }, client),
    retry: async (invocationId: string, context = {}) =>
      await retrySparkDaemonInvocation(invocationId, client, context),
    latestRetryableFailure: async (context = {}) => {
      await ensureReady();
      const result = await requestSparkDaemonControl(
        "session.retry-target",
        { sessionId: targetSessionId },
        client,
        context,
      );
      return result.target;
    },
    status: async (invocationId: string, context: SparkNativeInvocationStatusContext = {}) =>
      await clientTurnStatus({ invocationId }, client, {
        signal: context.signal,
      }),
  }) as SparkDaemonNativeResponder;
}

function createDaemonLiveAssistantRenderer(
  context: SparkNativeResponderContext | undefined,
  onViewEvent: ((event: SparkViewModelEvent) => void) | undefined,
  onInteractionRequest:
    | ((
        request: SparkInteractionRequest,
        event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
        context: { signal?: AbortSignal },
      ) => void | Promise<void>)
    | undefined,
  conversationProjection: "assistant-chunks" | "view-events",
): {
  streamed: boolean;
  onEvent?: (event: SparkDaemonEvent) => void | Promise<void>;
} {
  if (!context?.appendAssistantChunk && !onViewEvent && !onInteractionRequest) {
    return { streamed: false };
  }
  let streamed = false;
  let lastText = "";
  return {
    get streamed() {
      return streamed;
    },
    async onEvent(event) {
      if (event.type === "daemon.view_event") {
        onViewEvent?.(event.view);
        if (
          conversationProjection === "view-events" &&
          event.view.type === "session.message" &&
          event.view.message.role === "assistant"
        ) {
          streamed = true;
        }
      }
      if (event.type === "daemon.interaction.request") {
        await onInteractionRequest?.(
          event.request,
          event,
          context?.signal ? { signal: context.signal } : {},
        );
      }
      const text = assistantTextFromDaemonViewEvent(event);
      if (text === undefined) return;
      if (conversationProjection === "view-events") return;
      const chunk = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (!chunk) return;
      streamed = true;
      context?.appendAssistantChunk?.(chunk);
    },
  };
}

function assistantTextFromDaemonViewEvent(event: SparkDaemonEvent): string | undefined {
  if (event.type !== "daemon.view_event") return undefined;
  const view = event.view;
  if (!isRecord(view) || view.type !== "session.message" || !isRecord(view.message)) {
    return undefined;
  }
  const message = view.message;
  if (message.role !== "assistant" || message.status !== "streaming") return undefined;
  return typeof message.text === "string" ? message.text : undefined;
}

interface SubmittedTurnWaitOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

async function waitForSubmittedTurn(
  sessionId: string,
  submitted: LocalTurnSubmitResult,
  client: SparkDaemonClientOptions,
  options: SubmittedTurnWaitOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const now = client.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const deadlineError = new TurnReadDeadlineError();
  while (now() < deadline) {
    throwIfAborted(options.signal);
    let status: LocalTurnStatusResult;
    try {
      status = await retryTurnTransportRead(
        () =>
          clientTurnStatus({ invocationId: submitted.invocationId }, client, {
            signal: options.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        {
          signal: options.signal,
          deadline,
          deadlineError,
        },
      );
    } catch (error) {
      if (error === deadlineError) break;
      throw error;
    }
    if (status.status === "failed") {
      throw new Error(status.error?.message ?? `Invocation ${submitted.invocationId} failed`);
    }
    if (status.status === "cancelled") {
      throw new Error(status.cancelReason ?? `Invocation ${submitted.invocationId} was cancelled`);
    }
    if (status.status === "succeeded") {
      return STRINGS.completedSession(sessionId, submitted.invocationId);
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await delay(Math.min(pollIntervalMs, remainingMs), undefined, { signal: options.signal });
  }
  return STRINGS.queuedSession(sessionId, submitted.invocationId);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSparkDaemonNativeCommands(
  client: SparkDaemonClientOptions = {},
): SparkNativeSlashCommandMap {
  return {
    status: {
      description: STRINGS.nativeCommandDescriptions.status,
      metadata: {
        source: "extension",
        extensionId: "spark-daemon-native",
        plane: "daemon",
        resource: "status",
        verbs: ["show"],
        canonicalCliTarget: "spark daemon status",
      },
      handler: async () => formatNativeDaemonStatus(await clientStatus(client)),
    },
    start: {
      description: STRINGS.nativeCommandDescriptions.start,
      metadata: {
        source: "extension",
        extensionId: "spark-daemon-native",
        plane: "daemon",
        resource: "process",
        verbs: ["start"],
        canonicalCliTarget: "spark daemon start",
      },
      handler: async () => {
        await ensureSparkDaemonClientRunning(client);
        return formatNativeDaemonStatus(await clientStatus(client));
      },
    },
  };
}

export async function attachSparkWorkspaceClient(
  client: SparkDaemonClientOptions = {},
  options: AttachSparkWorkspaceClientOptions,
): Promise<SparkWorkspaceClientHandle> {
  await ensureSparkDaemonClientRunning(client);
  const workspaceId = options.workspaceId?.trim();
  if (workspaceId && options.localPath) {
    throw new Error("Spark workspace client attach accepts workspaceId or localPath, not both.");
  }
  const requestedCwd = options.localPath ?? process.cwd();
  const resolvedCwd = workspaceId
    ? undefined
    : client.workspaceEnsureLocal && !client.workspaceResolveSessionCwd
      ? {
          workspace: await clientEnsureLocalWorkspace({ localPath: requestedCwd }, client),
          cwd: requestedCwd,
        }
      : await clientResolveSessionCwd(requestedCwd, client);
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  const metadata =
    options.kind === "interactive" ? { surface: "tui", ...options.metadata } : options.metadata;
  const attached = await clientWorkspaceClientAttach(
    {
      workspaceId: workspaceId ?? resolvedCwd!.workspace.id,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      kind: options.kind,
      displayName: options.displayName ?? defaultWorkspaceClientDisplayName(options.kind),
      leaseTtlMs,
      ...(metadata ? { metadata } : {}),
    },
    client,
  );
  const workspace = attached.workspace;
  let released = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let transferPollTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = async () =>
    await clientWorkspaceClientHeartbeat({ clientId: attached.client.id, leaseTtlMs }, client);
  const release = async () => {
    if (released) return null;
    released = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (transferPollTimer) clearInterval(transferPollTimer);
    return await clientWorkspaceClientRelease({ clientId: attached.client.id }, client);
  };

  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  if (heartbeatIntervalMs !== false && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  const promptedTransfers = new Set<string>();
  if (options.kind === "interactive" && options.onLeaseTransferPrompt) {
    const paths = resolveSparkDaemonClientPaths(client);
    const pollTransfer = async () => {
      try {
        const result = await localRpcRequest(paths, "workspace.transfer.pending", {
          workspaceId: workspace.id,
        });
        for (const item of result.pending ?? []) {
          const transferId = typeof item.transferId === "string" ? item.transferId : null;
          if (!transferId || promptedTransfers.has(transferId)) continue;
          promptedTransfers.add(transferId);
          const decision = await options.onLeaseTransferPrompt?.({
            transferId,
            workspaceDisplayName:
              typeof item.workspaceDisplayName === "string"
                ? item.workspaceDisplayName
                : workspace.displayName,
            targetServerUrl: typeof item.targetServerUrl === "string" ? item.targetServerUrl : "",
            previousServerUrl:
              typeof item.previousServerUrl === "string" ? item.previousServerUrl : "",
            expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : "",
          });
          if (decision === "accept" || decision === "reject") {
            await localRpcRequest(paths, "workspace.transfer.respond", {
              transferId,
              decision,
              source: "tui",
            });
          }
        }
      } catch {
        // Transfer polling is best-effort; lease TTL still protects occupancy.
      }
    };
    transferPollTimer = setInterval(() => {
      void pollTransfer();
    }, 2_000);
    transferPollTimer.unref?.();
    void pollTransfer();
  }

  return {
    client: attached.client,
    workspace: attached.workspace,
    cwd: resolvedCwd?.cwd ?? attached.workspace.localPath,
    ...(resolvedCwd?.cwdArtifactRef ? { cwdArtifactRef: resolvedCwd.cwdArtifactRef } : {}),
    heartbeat,
    release,
  };
}

export async function attachSparkWorkspaceSessionClient(
  client: SparkDaemonClientOptions = {},
  options: AttachSparkWorkspaceSessionClientOptions,
): Promise<SparkDaemonSessionHeartbeatHandle> {
  return await attachSparkWorkspaceSessionHeartbeat(
    {
      ensureRunning: async () => await ensureSparkDaemonClientRunning(client),
      attach: async (input) =>
        (await clientWorkspaceClientAttach(
          input,
          client,
        )) as SparkLocalRpcOutput<"workspace.client.attach">,
      heartbeat: async (input) =>
        (await clientWorkspaceClientHeartbeat(
          input,
          client,
        )) as SparkLocalRpcOutput<"workspace.client.heartbeat">,
      release: async (input) =>
        (await clientWorkspaceClientRelease(
          input,
          client,
        )) as SparkLocalRpcOutput<"workspace.client.release">,
    },
    options,
  );
}

async function clientSessions(
  command: SparkDaemonSessionsCommand,
  client: SparkDaemonClientOptions,
): Promise<
  | LocalDaemonSessionListResult
  | LocalDaemonSessionTextResult
  | LocalDaemonSessionInboxListResult
  | LocalDaemonSessionMailMessageResult
  | DaemonSessionListResult
  | DaemonSessionShowResult
  | DaemonSessionTreeResult
  | DaemonSessionForkResult
  | ManagedSessionRegistryResult
> {
  const paths = resolveSparkDaemonClientPaths(client);
  const managedSessions = clientManagedSessions(client);
  if (command.subcommand === "create") {
    const workspaceId = command.workspaceId!;
    const supervisorSessionId =
      command.supervisorSessionId ??
      (
        await managedSessions.list({
          scope: { kind: "workspace", workspaceId },
          includeArchived: true,
        })
      ).find((session) => session.owner.kind === "workspace")?.sessionId;
    if (!supervisorSessionId) {
      throw new Error(`workspace ${workspaceId} has no reconciled Administrator Session`);
    }
    const session = await managedSessions.create({
      scope: { kind: "workspace", workspaceId },
      supervisorSessionId,
      placement: command.placement ?? "child",
      roleBinding: command.inheritRole
        ? { kind: "inherit" }
        : command.roleRef
          ? { kind: "explicit", roleRef: command.roleRef }
          : { kind: "none" },
      ...(command.name ? { name: command.name } : {}),
      sessionId: command.sessionId,
      cwd: process.cwd(),
    });
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "create",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "close") {
    if (!managedSessions.close) throw new Error("Spark daemon Session close is not available.");
    const session = await managedSessions.close(command.sessionId!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "close",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "bind") {
    const session = await managedSessions.bind(command.sessionId!, command.externalKey!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "bind",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "unbind") {
    const session = await managedSessions.unbind(command.sessionId!, command.externalKey!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: "unbind",
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "archive" || command.subcommand === "restore") {
    const session =
      command.subcommand === "archive"
        ? await managedSessions.archive(command.sessionId!)
        : await restoreManagedSession(managedSessions, command.sessionId!);
    return {
      plane: "daemon",
      resource: "session",
      subcommand: command.subcommand,
      session,
      text: renderManagedSession(session),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "inbox") {
    const sessionId = command.sessionId!;
    if (command.inboxAction === "read" || command.inboxAction === "ack") {
      const messageId = command.messageId?.trim();
      if (!messageId)
        throw new Error(`spark daemon session inbox ${command.inboxAction} requires <message-id>`);
      const result =
        command.inboxAction === "read"
          ? await requestSparkDaemonControl("session.mail.read", { sessionId, messageId }, client)
          : await requestSparkDaemonControl("session.mail.ack", { sessionId, messageId }, client);
      const message = result.message;
      const withStatus = { ...message, status: sessionMailStatus(message) };
      return {
        subcommand: "inbox",
        inboxAction: command.inboxAction,
        sessionId,
        message: withStatus,
        text: renderInboxMessage(command.inboxAction, withStatus),
        observedAt: observedAt(client),
      };
    }
    const inbox = await requestSparkDaemonControl(
      "session.inbox",
      { sessionId, includeAcked: command.all },
      client,
    );
    const messages = inbox.messages.map((message) => ({
      ...message,
      status: sessionMailStatus(message),
      preview: previewMailBody(message.body),
    }));
    return {
      subcommand: "inbox",
      sessionId,
      messages,
      text: renderInboxList(sessionId, messages),
      observedAt: observedAt(client),
    };
  }
  if (command.subcommand === "list") {
    if (command.registry) {
      const sessions = await managedSessions.list({
        includeArchived: command.includeArchived,
        query: command.query,
        tags: command.tags,
        ...(command.workspaceId
          ? { scope: { kind: "workspace" as const, workspaceId: command.workspaceId } }
          : {}),
      });
      return {
        plane: "daemon",
        resource: "session",
        subcommand: "list",
        sessions,
        text:
          sessions.length === 0
            ? "No managed Spark sessions in registry.\n"
            : sessions.map(renderManagedSession).join(""),
        observedAt: observedAt(client),
      };
    }
    if (command.history || command.allWorkspaces) {
      if (client.sessionList)
        return await client.sessionList(paths, {
          allWorkspaces: command.allWorkspaces,
          history: true,
        });
      return await listDaemonSessions(createLocalSessionStore(client), {
        allWorkspaces: command.allWorkspaces,
        history: true,
        observedAt: observedAt(client),
      });
    }
    const workspaces = await clientWorkspaceList(client);
    return listLiveDaemonSessions(workspaces.workspaces, { observedAt: workspaces.observedAt });
  }
  if (command.subcommand === "show") {
    return await showDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "tree") {
    return await treeDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "fork" || command.subcommand === "clone") {
    return await forkDaemonSession(createLocalSessionStore(client), command.sessionId!, {
      id: command.newSessionId,
      observedAt: observedAt(client),
    });
  }
  if (command.subcommand === "export") {
    const sessionId = command.sessionId!;
    const format = command.format ?? "jsonl";
    const leafId = command.leafId;
    const leafParams = leafId !== undefined ? { leafId } : {};
    if (client.sessionExport)
      return await client.sessionExport(paths, { sessionId, format, ...leafParams });
    const record = await createLocalSessionStore(client).loadByRef(sessionId);
    return {
      sessionId: record.header.id,
      text: exportSparkSessionRecord(record, { format, ...leafParams }),
      observedAt: observedAt(client),
    };
  }

  const sessionId = command.sessionId!;
  const leafId = command.leafId;
  const leafParams = leafId !== undefined ? { leafId } : {};
  if (client.sessionReplay) return await client.sessionReplay(paths, { sessionId, ...leafParams });
  const record = await createLocalSessionStore(client).loadByRef(sessionId);
  return {
    sessionId: record.header.id,
    text: formatSessionReplay(record, leafId),
    observedAt: observedAt(client),
  };
}

export async function clientGetManagedSession(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionProjection> {
  return await clientManagedSessions(client).get(sessionId);
}

export async function clientListManagedSessions(
  options: SparkSessionListRequest = {},
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionProjection[]> {
  return await clientManagedSessions(client).list(options);
}

export async function clientCreateManagedSession(
  input: SparkSessionCreateRequest,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionProjection> {
  return await clientManagedSessions(client).create(input);
}

export async function clientRestoreManagedSession(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionProjection> {
  return await restoreManagedSession(clientManagedSessions(client), sessionId);
}

async function restoreManagedSession(
  managedSessions: SparkDaemonManagedSessionsClient,
  sessionId: string,
): Promise<SparkSessionProjection> {
  if (!managedSessions.restore) throw new Error("Spark daemon Session restore is not available.");
  return await managedSessions.restore(sessionId);
}

export async function clientGetManagedSessionSnapshot(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionView> {
  return parseSparkSessionView(
    await requestSparkDaemonControl("session.snapshot", { sessionId }, client),
  );
}

export async function clientGetManagedSessionPromptHistory(
  sessionId: string,
  client: SparkDaemonClientOptions = {},
  limit = SPARK_SESSION_PROMPT_HISTORY_MAX,
): Promise<SparkSessionPromptHistory> {
  return parseSparkSessionPromptHistory(
    await requestSparkDaemonControl("session.prompt-history", { sessionId, limit }, client),
  );
}

export async function ensureSparkDaemonWorkspaceSession(
  input: { sessionId: string; workspaceId: string; cwd: string },
  client: SparkDaemonClientOptions = {},
): Promise<void> {
  const managedSessions = clientManagedSessions(client);
  const sessions = await managedSessions.list({ includeArchived: true });
  const existing = sessions.find((session) => session.sessionId === input.sessionId);
  if (existing?.placement === "archived") {
    throw new Error(`cannot submit to archived session: ${input.sessionId}`);
  }
  if (existing && existing.lifecycle !== "open") {
    throw new Error(`cannot submit to ${existing.lifecycle} session: ${input.sessionId}`);
  }
  if (
    existing &&
    (existing.scope.kind === "daemon" || existing.scope.workspaceId !== input.workspaceId)
  ) {
    throw new Error(
      `session ${input.sessionId} belongs to ${
        existing?.scope.kind === "daemon"
          ? "the daemon scope"
          : `workspace ${existing?.scope.workspaceId}`
      }, not workspace ${input.workspaceId}`,
    );
  }
  if (existing) return;
  const administrator = sessions.find(
    (session) =>
      session.scope.kind === "workspace" &&
      session.scope.workspaceId === input.workspaceId &&
      session.owner.kind === "workspace",
  );
  if (!administrator) {
    throw new Error(`workspace ${input.workspaceId} has no reconciled Administrator Session`);
  }
  await managedSessions.create({
    sessionId: input.sessionId,
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    supervisorSessionId: administrator.sessionId,
    roleBinding: { kind: "none" },
    cwd: input.cwd,
  });
}

function clientManagedSessions(client: SparkDaemonClientOptions): SparkDaemonManagedSessionsClient {
  if (client.managedSessions) return client.managedSessions;
  const paths = resolveSparkDaemonClientPaths(client);
  return createDaemonManagedSessionsClient({ paths: { runtimeDir: paths.runtimeDir } });
}

async function clientRuns(
  command: SparkDaemonRunsCommand,
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonRunListResult | LocalDaemonRunShowResult | LocalTurnCancelResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (command.subcommand === "cancel") {
    return await clientCancelTurn(
      { invocationId: command.runId!, reason: "spark daemon run cancel" },
      client,
    );
  }
  if (command.subcommand === "show") {
    if (client.runShow) return await client.runShow(paths, { runId: command.runId! });
    const runs = await clientRuns(
      { action: "runs", subcommand: "list", json: true, state: "all", limit: 100 },
      client,
    );
    const runList = runs as LocalDaemonRunListResult;
    const run = runList.runs.find(
      (item) => item.id === command.runId || item.runKey === command.runId,
    );
    return {
      plane: "daemon",
      resource: "run",
      runKey: runKey(command.runId!),
      ...(run ? { run } : {}),
      text: run ? renderRunSummary(run) : `${runKey(command.runId!)} not found\n`,
      observedAt: observedAt(client),
    };
  }
  if (client.runList) {
    return await client.runList(paths, { state: command.state, limit: command.limit });
  }
  return {
    plane: "daemon",
    resource: "run",
    runs: [],
    text: "No Spark daemon run list provider is configured.\n",
    observedAt: observedAt(client),
  };
}

async function clientAsk(
  command: SparkDaemonAskCommand,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonAskCommandResult> {
  if (command.subcommand === "list") {
    const response = await requestSparkDaemonControl(
      "human.interaction.list",
      command.sessionId ? { sessionId: command.sessionId } : {},
      client,
    );
    const waits = (response.waits as unknown[]).filter(isPendingHumanInteraction);
    return {
      subcommand: "list",
      waits,
      text: renderPendingHumanInteractions(waits),
      observedAt: observedAt(client),
    };
  }
  const response = await clientRespondHumanInteraction(
    {
      interactionRequestId: command.interactionRequestId!,
      ...(command.sessionId ? { sessionId: command.sessionId } : {}),
      ...(command.invocationId ? { invocationId: command.invocationId } : {}),
      status: command.subcommand === "cancel" ? "cancelled" : "answered",
      answers: command.answers ?? {},
    },
    client,
  );
  return {
    subcommand: command.subcommand,
    result: response,
    text: `${response.message}\n`,
    observedAt: observedAt(client),
  };
}

function isPendingHumanInteraction(value: unknown): value is SparkDaemonPendingHumanInteraction {
  if (!isRecord(value)) return false;
  return (
    typeof value.humanRequestId === "string" &&
    typeof value.interactionRequestId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.title === "string" &&
    typeof value.prompt === "string" &&
    Array.isArray(value.questions) &&
    typeof value.createdAt === "string"
  );
}

function renderPendingHumanInteractions(waits: SparkDaemonPendingHumanInteraction[]): string {
  if (waits.length === 0) return "No pending Spark daemon human interactions.\n";
  return `${waits
    .map((wait) =>
      [
        `${wait.interactionRequestId} human=${wait.humanRequestId} session=${wait.sessionId}`,
        `title=${wait.title}`,
        `prompt=${wait.prompt}`,
        `questions=${JSON.stringify(wait.questions)}`,
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

async function clientEvents(
  command: SparkDaemonEventsCommand,
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonEventsWatchResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.eventsWatch) return await client.eventsWatch(paths, { limit: command.limit });
  return {
    plane: "daemon",
    resource: "events",
    events: [],
    text: "No Spark daemon events are available without a live daemon event stream.\n",
    observedAt: observedAt(client),
  };
}

function runKey(id: string): string {
  return id.startsWith("run:") ? id : `run:${id}`;
}

function renderRunSummary(run: LocalDaemonRunSummary): string {
  const session = run.sessionKey ? ` ${run.sessionKey}` : "";
  const prompt = run.prompt ? ` ${run.prompt}` : "";
  return `${run.runKey} ${run.state}${session}${prompt}\n`;
}

function createLocalSessionStore(client: SparkDaemonClientOptions): SparkSessionStore {
  return new SparkSessionStore({
    cwd: process.cwd(),
    ...(client.sparkHome ? { sparkHome: client.sparkHome } : {}),
  });
}

function renderInboxList(
  sessionId: string,
  messages: Array<
    SparkSessionMailMessage & { status: "pending" | "read" | "acked"; preview: string }
  >,
): string {
  if (messages.length === 0) return `No pending Spark session mail for ${sessionId}.\n`;
  return (
    messages
      .map(
        (message) =>
          `${message.id} ${message.status} from=${message.fromSessionId} ${message.createdAt} ${message.preview}`,
      )
      .join("\n") + "\n"
  );
}

function renderInboxMessage(
  action: "read" | "ack",
  message: SparkSessionMailMessage & { status: "pending" | "read" | "acked" },
): string {
  return (
    [
      `${action === "ack" ? "acknowledged" : "read"} ${message.id}`,
      `to=${message.toSessionId}`,
      `from=${message.fromSessionId}`,
      `status=${message.status}`,
      `subject=${message.subject ?? ""}`,
      "",
      message.body,
    ].join("\n") + "\n"
  );
}

function previewMailBody(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 77)}...`;
}

function observedAt(client: SparkDaemonClientOptions): string {
  return new Date(client.now?.() ?? Date.now()).toISOString();
}

async function clientStatus(client: SparkDaemonClientOptions): Promise<SparkDaemonClientStatus> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.daemonStatus) {
    const status = await client.daemonStatus(paths);
    return { running: true, ...status, socketPath: paths.socketPath, pidFile: paths.pidFile };
  }
  const pid = readPidFile(paths.pidFile);
  const lock = readJsonFile(paths.lockPath);
  if (!pid || !isProcessAlive(pid)) {
    return { running: false, socketPath: paths.socketPath, pidFile: paths.pidFile, lock };
  }
  try {
    const status = await localRpcRequest(paths, "daemon.status", {});
    return {
      running: true,
      pid,
      socketPath: paths.socketPath,
      pidFile: paths.pidFile,
      lock,
      startedAt: fileMtime(paths.pidFile),
      ...status,
    };
  } catch (error) {
    return {
      running: false,
      unreachable: true,
      pid,
      socketPath: paths.socketPath,
      pidFile: paths.pidFile,
      lock,
      startedAt: fileMtime(paths.pidFile),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function clientChannelStatus(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelStatusSnapshot> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.channelStatus) return await client.channelStatus(paths);
  return await localRpcRequest(paths, "channel.status", {
    workspaceId: command.workspaceId,
  });
}

async function clientChannelReload(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelStatusSnapshot> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.channelReload) return await client.channelReload(paths, command.workspaceId);
  await ensureSparkDaemonClientRunning(client);
  return await localRpcRequest(paths, "channel.reload", {
    workspaceId: command.workspaceId,
  });
}

async function clientChannelNotify(
  command: SparkDaemonChannelCommand,
  client: SparkDaemonClientOptions,
): Promise<ChannelNotifySendResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  const params = {
    workspaceId: command.workspaceId,
    action: command.notifyAction ?? "test",
    ...(command.route ? { route: command.route } : {}),
    ...(command.adapter ? { adapter: command.adapter } : {}),
    ...(command.recipient ? { recipient: command.recipient } : {}),
    ...(command.text ? { text: command.text } : {}),
    ...(command.imageUrl
      ? {
          image: {
            url: command.imageUrl,
            ...(command.imageType ? { mediaType: command.imageType } : {}),
          },
        }
      : {}),
  };
  const result = await localRpcRequest(paths, "channel.notify", params);
  if (result.action === "list") {
    throw new Error("Spark daemon returned a list result for a channel send request.");
  }
  return result;
}

async function clientInvocation(
  command: SparkDaemonInvocationCommand,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonInvocationResult["result"]> {
  if (command.subcommand === "list") {
    return await requestSparkDaemonControl(
      "invocation.list",
      {
        ...(command.status ? { status: command.status } : {}),
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.since ? { since: command.since } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
        ...(command.offset !== undefined ? { offset: command.offset } : {}),
      },
      client,
    );
  }
  if (command.subcommand === "retention") {
    if (!command.before) {
      throw new Error("Spark invocation retention requires --before.");
    }
    if (command.retentionAction === "apply") {
      if (!command.confirm) {
        throw new Error("Spark invocation retention apply requires --confirm.");
      }
      return await requestSparkDaemonControl(
        "invocation.retention.apply",
        {
          before: command.before,
          ...(command.limit !== undefined ? { invocationLimit: command.limit } : {}),
          ...(command.eventLimit !== undefined ? { eventLimit: command.eventLimit } : {}),
          confirm: true,
        },
        client,
      );
    }
    return await requestSparkDaemonControl(
      "invocation.retention.preview",
      {
        before: command.before,
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      },
      client,
    );
  }
  const invocationId = command.invocationId!;
  if (command.subcommand === "status") {
    return await clientTurnStatus({ invocationId }, client);
  }
  if (command.subcommand === "result") {
    return await requestSparkDaemonControl("turn.result", { invocationId }, client);
  }
  if (command.subcommand === "retry") {
    return await requestSparkDaemonControl("invocation.retry", { invocationId }, client);
  }
  if (command.subcommand === "stream") {
    return await clientTurnStreamPage(
      {
        invocationId,
        after: command.after,
        limit: command.limit,
      },
      client,
    );
  }
  return await clientCancelTurn({ invocationId, reason: command.reason }, client);
}

async function clientSubmit(
  input: SparkDaemonTurnSubmitInput,
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal } = {},
): Promise<LocalTurnSubmitResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  throwIfAborted(options.signal);
  await ensureSparkDaemonClientRunning(client);
  const admissionId = localRequestId();
  const admissionInput = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? `turn.submit:${admissionId}`,
  };
  let failureCount = 0;
  while (true) {
    throwIfAborted(options.signal);
    try {
      return client.turnSubmit
        ? await client.turnSubmit(paths, admissionInput)
        : await localRpcRequest(paths, "turn.submit", admissionInput, {
            signal: options.signal,
          });
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (!isRetryableTurnTransportError(error)) throw error;
      failureCount += 1;
      const delayMs = turnTransportRetryDelayMs(failureCount, client.random ?? Math.random);
      const recovery = await recoverTurnTransportIfDue(error, failureCount, client, options.signal);
      reportTurnTransportRetry(client, {
        operation: "submit",
        failureCount,
        error: turnTransportErrorMessage(error),
        nextRetryMs: delayMs,
        ...recovery,
      });
      await waitBeforeTurnTransportRetry(delayMs, client, options.signal);
    }
  }
}

function isRetryableTurnTransportError(error: unknown): boolean {
  if (error instanceof SparkDaemonRemoteError) {
    return isDaemonStartingRemoteError(error);
  }
  if (error instanceof SparkDaemonUnavailableError) {
    return !/does not support|unknown local RPC method/iu.test(error.message);
  }
  return (
    error instanceof SparkDaemonRpcError &&
    /connection closed before a response|timed out waiting for daemon|oRPC transport failed/iu.test(
      error.message,
    )
  );
}

function isDaemonStartingRemoteError(error: SparkDaemonRemoteError): boolean {
  const payload = isRecord(error.payload) ? error.payload : undefined;
  return (
    payload?.code === "daemon_starting" ||
    /daemon is still starting; retry after readiness/iu.test(
      typeof payload?.message === "string" ? payload.message : error.message,
    )
  );
}

function turnTransportRetryDelayMs(failureCount: number, random: () => number): number {
  const ceiling = cappedExponentialCeiling(
    failureCount,
    TURN_TRANSPORT_RETRY_BASE_MS,
    TURN_TRANSPORT_RETRY_MAX_MS,
    { exponentCap: 16 },
  );
  return equalJitter(ceiling, random);
}

async function recoverTurnTransportIfDue(
  error: unknown,
  failureCount: number,
  client: SparkDaemonClientOptions,
  signal: AbortSignal | undefined,
): Promise<{ recoveryAttempted: boolean; recoveryError?: string }> {
  const configuredInterval = client.turnTransportRecoveryInterval;
  const interval =
    typeof configuredInterval === "number" && Number.isFinite(configuredInterval)
      ? Math.max(1, Math.floor(configuredInterval))
      : TURN_TRANSPORT_RECOVERY_INTERVAL;
  if (!isDaemonUnavailableTransportError(error) || failureCount % interval !== 0) {
    return { recoveryAttempted: false };
  }

  throwIfAborted(signal);
  try {
    await ensureSparkDaemonClientRunning(client);
    throwIfAborted(signal);
    return { recoveryAttempted: true };
  } catch (recoveryError) {
    if (signal?.aborted) throwIfAborted(signal);
    return {
      recoveryAttempted: true,
      recoveryError: turnTransportErrorMessage(recoveryError),
    };
  }
}

function isDaemonUnavailableTransportError(error: unknown): boolean {
  return (
    error instanceof SparkDaemonUnavailableError ||
    (error instanceof SparkDaemonRpcError &&
      !(error instanceof SparkDaemonRemoteError) &&
      /connection closed before a response|timed out waiting for daemon|oRPC transport failed/iu.test(
        error.message,
      ))
  );
}

function reportTurnTransportRetry(
  client: SparkDaemonClientOptions,
  event: SparkDaemonTurnTransportRetryEvent,
): void {
  if (client.onTurnTransportRetry) {
    try {
      client.onTurnTransportRetry(event);
      return;
    } catch (error) {
      console.error("[spark] turn transport retry observer failed", error);
    }
  }
  // A one-off transient close need not be noisy. Recurring failures are
  // surfaced at powers of two and every service recovery attempt.
  if (
    !event.recoveryAttempted &&
    event.failureCount !== 1 &&
    (event.failureCount & (event.failureCount - 1)) !== 0
  ) {
    return;
  }
  console.error(
    `[spark] ${event.operation} transport retry ${event.failureCount}; retrying in ${event.nextRetryMs}ms: ${event.error}${event.recoveryError ? `; recovery failed: ${event.recoveryError}` : ""}`,
  );
}

function turnTransportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitBeforeTurnTransportRetry(
  ms: number,
  client: SparkDaemonClientOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  if (!client.sleep) {
    await delay(ms, undefined, { signal });
    return;
  }
  if (!signal) {
    await client.sleep(ms);
    return;
  }

  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    await Promise.race([client.sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

class TurnReadDeadlineError extends Error {}

async function retryTurnTransportRead<T>(
  read: () => Promise<T>,
  client: SparkDaemonClientOptions,
  options: {
    signal?: AbortSignal;
    deadline: number;
    deadlineError: TurnReadDeadlineError;
  },
): Promise<T> {
  const now = client.now ?? Date.now;
  let failureCount = 0;
  while (true) {
    throwIfAborted(options.signal);
    if (now() >= options.deadline) throw options.deadlineError;
    try {
      return await read();
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (!isRetryableTurnTransportError(error)) throw error;
      failureCount += 1;
      const remainingMs = options.deadline - now();
      if (remainingMs <= 0) throw options.deadlineError;
      const delayMs = Math.min(
        turnTransportRetryDelayMs(failureCount, client.random ?? Math.random),
        remainingMs,
      );
      const recovery = await recoverTurnTransportIfDue(error, failureCount, client, options.signal);
      reportTurnTransportRetry(client, {
        operation: "read",
        failureCount,
        error: turnTransportErrorMessage(error),
        nextRetryMs: delayMs,
        ...recovery,
      });
      await waitBeforeTurnTransportRetry(delayMs, client, options.signal);
    }
  }
}

/** Shared daemon-owned model/auth control request used by native TUI adapters. */
export async function requestSparkDaemonControl<M extends SparkLocalRpcMethod>(
  method: M,
  params: SparkLocalRpcInput<M>,
  client: SparkDaemonClientOptions = {},
  options: { signal?: AbortSignal } = {},
): Promise<SparkLocalRpcOutput<M>> {
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  if (client.controlRequest) {
    const injected = options.signal
      ? await client.controlRequest(method, params, options)
      : await client.controlRequest(method, params);
    return sparkLocalRpcProcedureSchemas[method].output.parse(injected) as SparkLocalRpcOutput<M>;
  }
  return await requestSparkDaemon(method, params, daemonRequestOptions(paths, options));
}

async function retrySparkDaemonInvocation(
  invocationId: string,
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal } = {},
): Promise<SparkInvocationRetryResult> {
  let failureCount = 0;
  while (true) {
    try {
      return await requestSparkDaemonControl("invocation.retry", { invocationId }, client, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!isRetryableTurnTransportError(error)) throw error;
      failureCount += 1;
      const delayMs = turnTransportRetryDelayMs(failureCount, client.random ?? Math.random);
      const recovery = await recoverTurnTransportIfDue(error, failureCount, client, undefined);
      reportTurnTransportRetry(client, {
        operation: "retry",
        failureCount,
        error: turnTransportErrorMessage(error),
        nextRetryMs: delayMs,
        ...recovery,
      });
      await waitBeforeTurnTransportRetry(delayMs, client, options.signal);
    }
  }
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
export async function clientHasPendingHumanInteraction(
  input: SparkDaemonPendingHumanInteractionIdentity,
  client: SparkDaemonClientOptions = {},
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const result = await requestSparkDaemonControl(
    "human.interaction.list",
    { sessionId: input.sessionId },
    client,
    options,
  );
  return result.waits.some(
    (wait) =>
      wait.status === "pending" &&
      wait.interactionRequestId === input.interactionRequestId &&
      wait.sessionId === input.sessionId &&
      (input.invocationId === undefined || wait.invocationId === input.invocationId),
  );
}

/** Deliver a native TUI answer to the daemon-owned interaction continuation. */
export async function clientRespondHumanInteraction(
  input: SparkDaemonHumanInteractionRespondInput,
  client: SparkDaemonClientOptions = {},
  options: { signal?: AbortSignal } = {},
): Promise<SparkDaemonHumanInteractionRespondResult> {
  const humanResponseId = input.humanResponseId ?? createId("hres");
  const params = {
    interactionRequestId: input.interactionRequestId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    humanResponseId,
    status: input.status,
    answers: input.answers ?? {},
    responseArtifactRefs: input.responseArtifactRefs ?? [],
  };
  for (let attempt = 1; attempt <= HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      const result = await requestSparkDaemonControl("human.interaction.respond", params, client);
      if (result.outcome !== "transient" || attempt === HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS) {
        return result;
      }
    } catch (error) {
      if (
        options.signal?.aborted ||
        attempt === HUMAN_INTERACTION_RESPONSE_MAX_ATTEMPTS ||
        !isRetryableHumanInteractionResponseError(error)
      ) {
        if (options.signal?.aborted) throwIfAborted(options.signal);
        throw error;
      }
    }
    await waitBeforeTurnTransportRetry(
      HUMAN_INTERACTION_RESPONSE_RETRY_BASE_MS * 2 ** (attempt - 1),
      client,
      options.signal,
    );
  }
  throw new Error("Spark daemon human interaction response retry exhausted unexpectedly.");
}

export interface SparkDaemonHumanInteractionRequestHandlerOptions {
  currentSessionId: string;
  client?: SparkDaemonClientOptions;
  signal?: AbortSignal;
  reopenDelayMs?: number;
  interaction(request: SparkInteractionRequest): Promise<unknown>;
  notify(message: string, level: "success" | "warning"): void;
}

/** Keep a daemon-owned Ask visible until its answer reaches the owning wait. */
export async function handleSparkDaemonHumanInteractionRequest(
  request: SparkInteractionRequest,
  event: Extract<SparkDaemonEvent, { type: "daemon.interaction.request" }>,
  options: SparkDaemonHumanInteractionRequestHandlerOptions,
): Promise<void> {
  const client = options.client ?? {};
  const sessionId = event.sessionId ?? options.currentSessionId;
  let ownerUnavailableReported = false;
  while (!options.signal?.aborted) {
    try {
      const pending = await clientHasPendingHumanInteraction(
        {
          interactionRequestId: request.requestId,
          sessionId,
          ...(event.invocationId ? { invocationId: event.invocationId } : {}),
        },
        client,
        { signal: options.signal },
      );
      if (!pending) return;
      break;
    } catch (error) {
      if (options.signal?.aborted) return;
      if (!ownerUnavailableReported) {
        ownerUnavailableReported = true;
        options.notify(
          `Ask state is temporarily unavailable; waiting for daemon ownership before presenting it: ${turnTransportErrorMessage(error)}`,
          "warning",
        );
      }
      try {
        await waitBeforeTurnTransportRetry(options.reopenDelayMs ?? 250, client, options.signal);
      } catch (waitError) {
        if (options.signal?.aborted) return;
        throw waitError;
      }
    }
  }
  if (options.signal?.aborted) return;
  const humanResponseId = createId("hres");
  while (!options.signal?.aborted) {
    const response = parseSparkInteractionResponse(await options.interaction(request));
    if (
      response.status === "pending" ||
      response.status === "blocked" ||
      response.status === "error"
    ) {
      return;
    }

    const answers = daemonHumanInteractionAnswers(response);
    let delivered: SparkDaemonHumanInteractionRespondResult | undefined;
    let failure: unknown;
    try {
      delivered = await clientRespondHumanInteraction(
        {
          interactionRequestId: request.requestId,
          sessionId,
          ...(event.invocationId ? { invocationId: event.invocationId } : {}),
          humanResponseId,
          status:
            response.status === "answered" && hasNonEmptySparkHumanAnswer(answers)
              ? "answered"
              : "cancelled",
          answers,
        },
        client,
        { signal: options.signal },
      );
    } catch (error) {
      failure = error;
    }

    if (options.signal?.aborted) return;
    if (delivered && isTerminalSparkHumanInteractionDelivery(delivered.outcome)) {
      options.notify(
        delivered.message || `Ask response: ${delivered.outcome}`,
        delivered.outcome === "accepted" || delivered.outcome === "replayed"
          ? "success"
          : "warning",
      );
      return;
    }

    const reason =
      delivered?.message ?? (failure === undefined ? "" : turnTransportErrorMessage(failure));
    options.notify(
      `Ask response was not delivered; keeping it open for retry${reason ? `: ${reason}` : "."}`,
      "warning",
    );
    try {
      await waitBeforeTurnTransportRetry(options.reopenDelayMs ?? 250, client, options.signal);
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    }
  }
}

function daemonHumanInteractionAnswers(
  response: SparkInteractionResponse,
): Record<string, unknown> {
  if (response.kind === "askFlow") return response.answers;
  if (response.kind === "toolApproval") {
    return {
      approval: {
        values: [response.approved ? "approve" : "reject"],
        labels: [response.approved ? "Approve" : "Reject"],
      },
    };
  }
  if (response.kind === "confirmation" || response.kind === "diffApproval") {
    return { approved: response.approved === true };
  }
  if (response.kind === "modelSelect") {
    return response.selection ? { selection: response.selection } : {};
  }
  if (response.kind === "workflowPicker") {
    return response.selector ? { selector: response.selector } : {};
  }
  return {};
}

function isRetryableHumanInteractionResponseError(error: unknown): boolean {
  if (isRetryableTurnTransportError(error)) return true;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "human_interaction_not_found" ||
    /No pending daemon-owned human interaction matched/iu.test(message)
  );
}

export async function clientTurnStatus(
  input: { invocationId: string },
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal; ensureRunning?: boolean; timeoutMs?: number } = {},
): Promise<LocalTurnStatusResult> {
  throwIfAborted(options.signal);
  const paths = resolveSparkDaemonClientPaths(client);
  if (options.ensureRunning !== false) await ensureSparkDaemonClientRunning(client);
  throwIfAborted(options.signal);
  if (client.turnStatus) return await client.turnStatus(paths, input);
  return await localRpcRequest(paths, "turn.status", input, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export async function clientTurnStreamPage(
  input: { invocationId: string; after?: number; limit?: number },
  client: SparkDaemonClientOptions,
  options: { signal?: AbortSignal; ensureRunning?: boolean; timeoutMs?: number } = {},
): Promise<LocalTurnStreamResult> {
  throwIfAborted(options.signal);
  const paths = resolveSparkDaemonClientPaths(client);
  if (options.ensureRunning !== false) await ensureSparkDaemonClientRunning(client);
  throwIfAborted(options.signal);
  if (client.turnStream) return await client.turnStream(paths, input);
  return await localRpcRequest(paths, "turn.stream", input, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

export async function clientCancelTurn(
  input: { invocationId: string; reason?: string },
  client: SparkDaemonClientOptions,
): Promise<LocalTurnCancelResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  if (client.turnCancel) return await client.turnCancel(paths, input);
  return await localRpcRequest(paths, "turn.cancel", input);
}

async function pollInvocationEvents(
  invocationId: string,
  client: SparkDaemonClientOptions,
  handlers: {
    onEvent?: (event: SparkDaemonEvent) => void | Promise<void>;
    signal?: AbortSignal;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
): Promise<void> {
  let cursor = 0;
  const now = client.now ?? Date.now;
  const deadline = now() + (handlers.timeoutMs ?? DEFAULT_NATIVE_TURN_WAIT_TIMEOUT_MS);
  const deadlineError = new TurnReadDeadlineError();
  const streamTimeoutError = () =>
    new Error(`Timed out while streaming invocation ${invocationId}`);
  const pollIntervalMs = Math.max(25, handlers.pollIntervalMs ?? 100);
  let idleDelayMs = pollIntervalMs;
  while (true) {
    throwIfAborted(handlers.signal);
    try {
      if (now() >= deadline) throw deadlineError;
      const page = await retryTurnTransportRead(
        () =>
          clientTurnStreamPage({ invocationId, after: cursor, limit: 100 }, client, {
            signal: handlers.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        { signal: handlers.signal, deadline, deadlineError },
      );
      for (const event of page.events) {
        let parsed: SparkDaemonEvent;
        try {
          parsed = parseSparkDaemonEvent(event.payload);
        } catch {
          // Invocation event storage can also contain non-daemon diagnostic payloads.
          continue;
        }
        await handlers.onEvent?.(parsed);
      }
      if (page.events.length > 0) idleDelayMs = pollIntervalMs;
      cursor = page.nextCursor;
      if (now() >= deadline) throw deadlineError;
      const status = await retryTurnTransportRead(
        () =>
          clientTurnStatus({ invocationId }, client, {
            signal: handlers.signal,
            ensureRunning: false,
            timeoutMs: Math.max(1, deadline - now()),
          }),
        client,
        { signal: handlers.signal, deadline, deadlineError },
      );
      if (
        (status.status === "succeeded" ||
          status.status === "failed" ||
          status.status === "cancelled") &&
        !page.hasMore &&
        cursor >= status.eventCursor
      ) {
        return;
      }
      if (!page.hasMore) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw deadlineError;
        await delay(Math.min(idleDelayMs, remainingMs), undefined, { signal: handlers.signal });
        idleDelayMs = Math.min(pollIntervalMs * 4, idleDelayMs * 2);
      }
    } catch (error) {
      if (handlers.signal?.aborted) throwIfAborted(handlers.signal);
      if (error === deadlineError) throw streamTimeoutError();
      throw error;
    }
  }
}

export async function clientListDaemonWorkspaces(
  client: SparkDaemonClientOptions = {},
): Promise<LocalDaemonWorkspaceListResult> {
  return await clientWorkspaceList(client);
}

async function clientWorkspaceList(
  client: SparkDaemonClientOptions,
): Promise<LocalDaemonWorkspaceListResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  if (client.workspaceList) return await client.workspaceList(paths);
  return await localRpcRequest(paths, "workspace.list", {});
}

async function clientEnsureLocalWorkspace(
  input: LocalWorkspaceEnsureLocalInput,
  client: SparkDaemonClientOptions,
): Promise<SparkDaemonWorkspace> {
  // Compatibility name: the daemon resolves an explicit registration and
  // fails closed for unknown paths; this call must not mint a workspace.
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  if (client.workspaceEnsureLocal) return await client.workspaceEnsureLocal(paths, input);
  return await localRpcRequest(paths, "workspace.ensure-local", input);
}

export async function clientResolveSessionCwd(
  cwd: string,
  client: SparkDaemonClientOptions = {},
): Promise<SparkSessionCwdResolution> {
  const paths = resolveSparkDaemonClientPaths(client);
  await ensureSparkDaemonClientRunning(client);
  if (client.workspaceResolveSessionCwd) {
    return await client.workspaceResolveSessionCwd(paths, { cwd });
  }
  return await localRpcRequest(paths, "workspace.resolve-session-cwd", { cwd });
}

async function clientWorkspaceClientAttach(
  input: LocalWorkspaceClientAttachInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientAttach) return await client.workspaceClientAttach(paths, input);
  return await localRpcRequest(paths, "workspace.client.attach", input);
}

async function clientWorkspaceClientHeartbeat(
  input: LocalWorkspaceClientHeartbeatInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientHeartbeat) return await client.workspaceClientHeartbeat(paths, input);
  return await localRpcRequest(paths, "workspace.client.heartbeat", input);
}

async function clientWorkspaceClientRelease(
  input: LocalWorkspaceClientReleaseInput,
  client: SparkDaemonClientOptions,
): Promise<LocalWorkspaceClientResult> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (client.workspaceClientRelease) return await client.workspaceClientRelease(paths, input);
  return await localRpcRequest(paths, "workspace.client.release", input);
}

function defaultWorkspaceClientDisplayName(kind: SparkWorkspaceClientKind): string {
  switch (kind) {
    case "interactive":
      return STRINGS.displayName.interactive;
    case "headless":
      return STRINGS.displayName.headless;
    case "executor":
      return STRINGS.displayName.executor;
  }
}

export async function ensureSparkDaemonClientRunning(
  client: SparkDaemonClientOptions,
): Promise<void> {
  const paths = resolveSparkDaemonClientPaths(client);
  if (
    client.controlRequest ||
    client.startService ||
    client.daemonStatus ||
    client.turnSubmit ||
    client.turnCancel ||
    client.workspaceList ||
    client.workspaceEnsureLocal ||
    client.workspaceResolveSessionCwd ||
    client.workspaceClientAttach
  ) {
    client.startService?.(paths);
    await client.daemonStatus?.(paths);
    return;
  }
  const pid = readPidFile(paths.pidFile);
  if (pid && isProcessAlive(pid)) {
    try {
      await waitForDaemonRpc(paths, client);
      return;
    } catch (error) {
      if (!isDaemonUnavailableTransportError(error)) throw error;
      if (hasRecentDaemonProcessIdentity(paths, pid, client.now ?? Date.now)) throw error;
      await repairUnreachableSparkDaemon(client, error);
      await waitForDaemonRpc(paths, client, { startupTimeoutMs: 120_000 });
      return;
    }
  }
  // A live daemon.lock means bootstrap already owns the exclusive start path
  // (before the pidfile exists). Wait for that owner instead of thrashing
  // additional `spark daemon start` children from every TUI ensure-running call.
  const startingPid = readLiveDaemonLockPid(paths.runtimeDir);
  if (startingPid && isProcessAlive(startingPid)) {
    await waitForDaemonRpc(paths, client, { startupTimeoutMs: 120_000 });
    return;
  }
  const service = sparkDaemonServiceCliCommand();
  // Keep channel/SDK diagnostics: stdio:"ignore" sent everything to /dev/null and
  // made Infoflow autoRegister / inbound frames impossible to observe.
  const logDir = join(dirname(paths.runtimeDir), "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const stdout = openSync(join(logDir, "service.stdout.log"), "a", 0o600);
  const stderr = openSync(join(logDir, "service.stderr.log"), "a", 0o600);
  try {
    const child = spawn(service.command, [...service.args, "start"], {
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env: process.env,
    });
    child.unref();
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  await waitForDaemonRpc(paths, client, { startupTimeoutMs: 120_000 });
}

async function repairUnreachableSparkDaemon(
  client: SparkDaemonClientOptions,
  cause: unknown,
): Promise<void> {
  const stopped = await runSparkDaemonServiceCommand(["stop", "--yes", "--wait"], client);
  if (stopped !== 0) {
    throw new Error(
      `Spark daemon repair could not stop the unreachable service (exit ${stopped}).`,
      {
        cause,
      },
    );
  }
  const started = await runSparkDaemonServiceCommand(["start", "--wait"], client);
  if (started !== 0) {
    throw new Error(
      `Spark daemon repair could not start the replacement service (exit ${started}).`,
      {
        cause,
      },
    );
  }
}

async function runSparkDaemonServiceCommand(
  argv: string[],
  client: SparkDaemonClientOptions,
): Promise<number> {
  if (client.serviceCommand) return await client.serviceCommand(argv);
  const service = sparkDaemonServiceCliCommand();
  return await runForeground(service.command, [...service.args, ...argv]);
}

async function runForeground(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export interface SparkDaemonServiceCommandOptions {
  daemonAppDir?: string;
  env?: NodeJS.ProcessEnv;
  buildSource?: (daemonAppDir: string, env: NodeJS.ProcessEnv) => number | null;
}

export function sparkDaemonServiceCliCommand(options: SparkDaemonServiceCommandOptions = {}): {
  command: string;
  args: string[];
} {
  const env = options.env ?? process.env;
  const packagedEntrypoint = env.SPARK_DAEMON_ENTRYPOINT;
  if (packagedEntrypoint && existsSync(packagedEntrypoint)) {
    return { command: process.execPath, args: [packagedEntrypoint] };
  }

  const daemonAppDir =
    options.daemonAppDir ?? fileURLToPath(new URL("../../../spark-daemon", import.meta.url));
  const distCli = join(daemonAppDir, "dist", "cli.js");
  if (existsSync(join(daemonAppDir, "package.json"))) {
    const status = (options.buildSource ?? buildSourceDaemonApp)(daemonAppDir, env);
    if (status !== 0 || !existsSync(distCli)) {
      throw new Error(STRINGS.buildServiceFailed);
    }
    return { command: process.execPath, args: [distCli] };
  }

  if (existsSync(distCli)) {
    return { command: process.execPath, args: [distCli] };
  }
  return { command: "spark", args: ["daemon"] };
}

function buildSourceDaemonApp(daemonAppDir: string, env: NodeJS.ProcessEnv): number | null {
  return spawnSync(process.execPath, [join(daemonAppDir, "scripts", "build-cli.mjs")], {
    cwd: daemonAppDir,
    env,
    stdio: "inherit",
  }).status;
}

async function waitForDaemonRpc(
  paths: SparkDaemonClientPaths,
  client: SparkDaemonClientOptions,
  options: { startupTimeoutMs?: number } = {},
): Promise<void> {
  const now = client.now ?? Date.now;
  const sleep =
    client.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Existing pid/RPC probes stay short so healthy daemons remain snappy. Cold
  // starts and repair paths pass a longer budget because large local state can
  // take tens of seconds before daemon.sock appears.
  const deadline = now() + (options.startupTimeoutMs ?? 2_000);
  let lastError: unknown;
  let startingError: SparkDaemonRemoteError | undefined;
  while (now() <= deadline) {
    try {
      await localRpcRequest(paths, "daemon.status", {});
      return;
    } catch (error) {
      if (error instanceof SparkDaemonRemoteError && isDaemonStartingRemoteError(error)) {
        startingError ??= error;
      } else if (!isDaemonUnavailableTransportError(error)) {
        throw error;
      }
      lastError = error;
      await sleep(50);
    }
  }
  if (startingError) throw startingError;
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new SparkDaemonUnavailableError(STRINGS.notReachable(detail), { cause: lastError });
}

async function localRpcRequest<M extends SparkLocalRpcMethod>(
  paths: SparkDaemonClientPaths,
  method: M,
  params: SparkLocalRpcInput<M>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SparkLocalRpcOutput<M>> {
  try {
    return await requestSparkDaemon(method, params, daemonRequestOptions(paths, options));
  } catch (error) {
    if (error instanceof SparkDaemonRemoteError) {
      if (isDaemonStartingRemoteError(error)) throw error;
      const message =
        isRecord(error.payload) && typeof error.payload.message === "string"
          ? error.payload.message
          : STRINGS.localRpcFailed;
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}

function daemonRequestOptions(
  paths: SparkDaemonClientPaths,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const timeoutMs =
    options.timeoutMs === undefined ? undefined : Math.max(1, Math.floor(options.timeoutMs));
  return {
    paths: { runtimeDir: paths.runtimeDir },
    legacySocketPath: paths.socketPath,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(timeoutMs === undefined
      ? {}
      : {
          connectTimeoutMs: Math.min(1_000, timeoutMs),
          responseTimeoutMs: Math.min(30_000, timeoutMs),
        }),
  };
}

function resolveSparkDaemonClientPaths(
  client: SparkDaemonClientOptions = {},
): SparkDaemonClientPaths {
  if (client.paths) return client.paths;
  const runtimeDir = resolveSparkPaths({ app: "daemon" }).runtimeDir;
  return {
    runtimeDir,
    socketPath: join(runtimeDir, "daemon.sock"),
    pidFile: join(runtimeDir, "daemon.pid"),
    lockPath: join(runtimeDir, "daemon.lock"),
  };
}

function readPrompt(parsed: ReturnType<typeof parseSparkCliOptions>): string | undefined {
  const fromOption = readStringOption(parsed.options, "prompt");
  const text = fromOption ?? parsed.positionals.join(" ");
  return text.trim() || undefined;
}

function readDaemonLeafArg(raw: string | undefined): string | null | undefined {
  if (raw === undefined || raw === "all") return undefined;
  return raw === "root" ? null : raw;
}

function readRunState(raw: string): SparkDaemonRunState {
  if (
    raw === "queued" ||
    raw === "running" ||
    raw === "succeeded" ||
    raw === "failed" ||
    raw === "cancelled" ||
    raw === "all"
  ) {
    return raw;
  }
  throw new Error(`invalid daemon run state: ${raw}`);
}

function formatNativeDaemonStatus(status: SparkDaemonClientStatus): string {
  const lifecycle = status.lifecycle;
  const lifecycleStatus =
    typeof lifecycle === "object" && lifecycle !== null
      ? (lifecycle as NonNullable<SparkDaemonLocalStatus["lifecycle"]>)
      : undefined;
  const daemonState =
    status.running &&
    (lifecycleStatus?.state === "draining" || lifecycleStatus?.state === "stopping")
      ? lifecycleStatus.state
      : status.running
        ? "running"
        : "stopped";
  const lines = [`daemon: ${daemonState}`];
  if (typeof status.pid === "number") lines.push(`pid: ${status.pid}`);
  if (typeof status.socketPath === "string") lines.push(`socket: ${status.socketPath}`);
  if (typeof status.error === "string") lines.push(`error: ${status.error}`);
  if (lifecycleStatus?.drain) {
    lines.push(`drain-stage: ${lifecycleStatus.drain.stage}`);
    lines.push(
      `drain-blockers: scheduler=${lifecycleStatus.drain.scheduler.length} direct=${lifecycleStatus.drain.direct.length}`,
    );
  }
  if (lifecycleStatus?.stopReason) lines.push(`stop-reason: ${lifecycleStatus.stopReason}`);
  const invocations = status.invocations;
  if (isInvocationCounts(invocations)) {
    lines.push(
      `invocations: queued=${invocations.queued} running=${invocations.running} succeeded=${invocations.succeeded} failed=${invocations.failed} cancelled=${invocations.cancelled}`,
    );
  }
  const channelDeliveries = status.channelDeliveries;
  if (isChannelDeliveryCounts(channelDeliveries)) {
    lines.push(
      `channel-deliveries: pending=${channelDeliveries.pending} retrying=${channelDeliveries.retrying} in-flight=${channelDeliveries.inFlight} delivered=${channelDeliveries.delivered} uncertain=${channelDeliveries.uncertain}`,
    );
    if (typeof channelDeliveries.lastError === "string") {
      lines.push(`channel-delivery-error: ${channelDeliveries.lastError}`);
    }
  }
  const servers = Array.isArray(status.servers) ? status.servers : [];
  for (const server of servers) {
    if (!isNativeDaemonServer(server)) continue;
    const connected = server.wsConnected ? "connected" : "disconnected";
    lines.push(`server: ${server.url} workspaces=${server.workspaceCount} ws=${connected}`);
  }
  return lines.join("\n");
}

function isChannelDeliveryCounts(
  value: unknown,
): value is NonNullable<SparkDaemonLocalStatus["channelDeliveries"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { pending?: unknown }).pending === "number" &&
    typeof (value as { retrying?: unknown }).retrying === "number" &&
    typeof (value as { inFlight?: unknown }).inFlight === "number" &&
    typeof (value as { delivered?: unknown }).delivered === "number" &&
    typeof (value as { uncertain?: unknown }).uncertain === "number"
  );
}

function isInvocationCounts(value: unknown): value is SparkDaemonLocalStatus["invocations"] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { queued?: unknown }).queued === "number" &&
    typeof (value as { running?: unknown }).running === "number" &&
    typeof (value as { succeeded?: unknown }).succeeded === "number" &&
    typeof (value as { failed?: unknown }).failed === "number" &&
    typeof (value as { cancelled?: unknown }).cancelled === "number"
  );
}

function isNativeDaemonServer(value: unknown): value is {
  url: string;
  workspaceCount: number;
  wsConnected: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { workspaceCount?: unknown }).workspaceCount === "number" &&
    typeof (value as { wsConnected?: unknown }).wsConnected === "boolean"
  );
}

function readLiveDaemonLockPid(runtimeDir: string): number | null {
  const lockPath = join(runtimeDir, "daemon.lock");
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function hasRecentDaemonProcessIdentity(
  paths: SparkDaemonClientPaths,
  expectedPid: number,
  now: () => number,
): boolean {
  const identityPath = join(paths.runtimeDir, "daemon.identity.json");
  const identity = readJsonFile(identityPath);
  if (
    !isRecord(identity) ||
    identity.pid !== expectedPid ||
    typeof identity.processStartToken !== "string" ||
    identity.processStartToken.length === 0 ||
    typeof identity.instanceId !== "string" ||
    identity.instanceId.length === 0 ||
    typeof identity.generation !== "string" ||
    identity.generation.length === 0
  ) {
    return false;
  }
  try {
    const ageMs = now() - statSync(identityPath).mtimeMs;
    return ageMs >= 0 && ageMs <= DAEMON_PROCESS_STARTUP_GRACE_MS;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function fileMtime(path: string): string | undefined {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function localRequestId(): string {
  return `spark_cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
