/** Shared types for the Spark native TUI surface. */

import type { CommandMetadata, SparkHostCommandContext } from "@zendev-lab/spark-core";
import type {
  SparkInteractionRequest,
  SparkInteractionResponse,
  SparkConversationProjection,
  SparkMessageView,
  SparkTurnCancelResult,
  SparkTurnStatusResult,
  SparkTurnSubmitResult,
  SparkToolCallView,
} from "@zendev-lab/spark-protocol";
import type { SparkKeybindingContext, SparkKeybindings } from "../host/keybindings.ts";
import type { SparkHostMessageRenderer, RegisteredCommand } from "../host/types.ts";
import type { SparkTheme } from "../host/theme.ts";
import type { SparkNativeAppContract, SparkNativeSessionContract } from "./session-contracts.ts";
import type { SparkNativeHubPanel } from "./hub-types.ts";

export type {
  SparkNativeHubPanel,
  SparkNativeHubSnapshot,
  SparkNativeHubState,
  SparkNativeFooterMetrics,
  SparkNativeWorkflowOption,
} from "./hub-types.ts";

export type SparkNativeMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "custom"
  | "tool"
  | "thinking";

/** Canonical Spark tool states. Legacy local callers may still submit success/error. */
export type SparkNativeToolStatus = SparkToolCallView["status"];
export type SparkNativeToolStatusInput = SparkNativeToolStatus | "success" | "error";
export type SparkNativeQueueMode = "steer" | "followUp";

export interface SparkNativeMessage {
  role: SparkNativeMessageRole;
  text: string;
  viewId?: string;
  queued?: boolean;
  streaming?: boolean;
  viewStatus?: SparkMessageView["status"];
  customType?: string;
  display?: boolean;
  details?: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: SparkNativeToolStatusInput;
  createdAt?: string;
  updatedAt?: string;
  nativeOrder?: number;
  /** One wire message projected as ordered semantic parts; terminal rendering remains TUI-owned. */
  conversation?: SparkConversationProjection;
}

export interface SparkNativeToolMessageInput {
  toolName: string;
  text: string;
  toolCallId?: string;
  status?: SparkNativeToolStatusInput;
  details?: Record<string, unknown>;
}

export interface SparkNativeCustomMessageInput {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface SparkNativeResponderContext {
  readonly messages: readonly SparkNativeMessage[];
  /** Stable identity for one user submit, retained when `/retry` resubmits it. */
  readonly submissionId?: string;
  readonly signal?: AbortSignal;
  readonly appendAssistantChunk?: (chunk: string) => void;
  readonly finishAssistantMessage?: () => void;
}

export interface SparkNativeAdmissionContext {
  /** Stable daemon admission identity. */
  readonly submissionId?: string;
  /** Used by the compatibility callable; durable busy admission omits it. */
  readonly signal?: AbortSignal;
}

export class SparkNativeAdmissionError extends Error {
  override readonly name = "SparkNativeAdmissionError";
  readonly outcome: "rejected" | "unknown";

  constructor(message: string, outcome: "rejected" | "unknown", options?: ErrorOptions) {
    super(message, options);
    this.outcome = outcome;
  }
}

export interface SparkNativeInvocationStatusContext {
  readonly signal?: AbortSignal;
}

type SparkNativeResponderFunction = (
  input: string,
  context: SparkNativeResponderContext,
) => string | Promise<string>;

/**
 * A plain responder remains valid for local/tests. Daemon-backed responders
 * expose two-phase admission/observation so the TUI never owns durable queueing.
 */
export type SparkNativeResponder = SparkNativeResponderFunction & {
  admit?: (input: string, context: SparkNativeAdmissionContext) => Promise<SparkTurnSubmitResult>;
  observe?: (
    admission: SparkTurnSubmitResult,
    context: SparkNativeResponderContext,
  ) => Promise<string>;
  cancel?: (invocationId: string, reason: string) => Promise<SparkTurnCancelResult>;
  status?: (
    invocationId: string,
    context?: SparkNativeInvocationStatusContext,
  ) => Promise<SparkTurnStatusResult>;
};

export interface SparkNativeQueuedInput {
  readonly text: string;
  readonly mode: SparkNativeQueueMode;
  readonly submissionId: string;
}

export interface SparkNativeSubmitOptions {
  mode?: SparkNativeQueueMode;
  submissionId?: string;
}

export interface SparkNativeQueueSummary {
  total: number;
  steer: number;
  followUp: number;
  /** Daemon-admitted turns still queued or running (durable truth). */
  daemonPending: number;
}

export interface SparkNativeAbortResult {
  aborted: boolean;
  clearedQueued: number;
  restoredText?: string;
}

export interface SparkNativeSlashCommandContext {
  readonly app: SparkNativeAppContract;
  readonly session: SparkNativeSessionContract;
  exit(): void;
}

export interface SparkNativeInteractionContext {
  readonly app: SparkNativeAppContract;
  readonly session: SparkNativeSessionContract;
}

export type SparkNativeInteractionHandler = (
  request: SparkInteractionRequest,
  context: SparkNativeInteractionContext,
) => SparkInteractionResponse | Promise<SparkInteractionResponse>;

export type SparkNativeSlashCommandHandler = (
  args: string,
  context: SparkNativeSlashCommandContext,
) => string | void | Promise<string | void>;

export interface SparkNativeSlashCommand {
  description: string;
  argumentHint?: string;
  metadata?: CommandMetadata;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) =>
    | Array<{ value: string; label: string; description?: string }>
    | null
    | Promise<Array<{ value: string; label: string; description?: string }> | null>;
  handler: SparkNativeSlashCommandHandler;
}

export type SparkNativeSlashCommandMap = Record<string, SparkNativeSlashCommand>;

export interface SparkNativeRuntimeCommandHost {
  listCommands(): Array<{
    name: string;
    command: Pick<
      RegisteredCommand,
      "description" | "argumentHint" | "metadata" | "getArgumentCompletions" | "handler"
    >;
  }>;
  makeContext(
    extra?: Partial<SparkHostCommandContext> & { setEditorText?: (text: string) => void },
  ): SparkHostCommandContext & { setEditorText?: (text: string) => void };
}

export interface SparkNativeRuntimeSlashCommandOptions {
  exclude?: Iterable<string>;
  waitForIdle?: () => Promise<void>;
  sendUserMessage?: (
    content: string,
    context: SparkNativeSlashCommandContext,
  ) => void | Promise<void>;
  setEditorText?: (text: string) => void;
}

export const SPARK_NATIVE_KERNEL_SLASH_COMMANDS = [
  "help",
  "exit",
  "quit",
  "clear",
  "reload",
] as const;

export type SparkNativeWorkspaceSessionMode = "select" | "attached" | "mismatch";

export interface SparkNativeWorkspaceSessionState {
  mode: SparkNativeWorkspaceSessionMode;
  workspaceDir: string;
  workspaceHash: string;
  /** Canonical host/claim owner identity for the attached persistent session. */
  sessionId?: string;
  controlPlaneSessionId?: string;
  attachTarget?: string;
  mismatchDiagnostic?: string;
}

export interface SparkNativeStatusContext {
  activeProvider?: () => string | undefined;
  activeModel?: () => string | undefined;
  thinkingLevel?: () => string | undefined;
  contextWindow?: () => number | undefined;
  autoCompactionEnabled?: () => boolean;
}

export interface SparkNativeTuiAppOptions {
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  slashCommands?: SparkNativeSlashCommandMap;
  theme?: SparkTheme;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  statusContext?: SparkNativeStatusContext;
}

export interface SparkNativeWidgetComponent {
  render(width?: number): string[];
  invalidate?(): void;
}

export interface SparkNativeWidget {
  key: string;
  placement: "aboveEditor" | "belowEditor";
  lines?: string[];
  component?: SparkNativeWidgetComponent;
}

export const SPARK_HUB_PANELS: readonly SparkNativeHubPanel[] = [
  "overview",
  "workflows",
  "runs",
  "tasks",
  "artifacts",
  "reviews",
  "graft",
];

export const MAX_TRANSCRIPT_MESSAGES = 80;
export const MAX_NATIVE_WIDGET_LINES = 12;
export const MAX_HUB_PANEL_ROWS = 6;
export const MAX_NATIVE_QUEUE_ITEMS = 4;
export const SPARK_NATIVE_LOCAL_CONTROL_EXTENSION_ID = "spark-tui-local-control";
