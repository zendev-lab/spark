import {
  DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  SPARK_HEADLESS_EXECUTOR_MODULE_ENV,
  resolveSparkHeadlessExecutorSpecifier,
} from "@zendev-lab/spark-system/headless-module";
import type {
  ExtensionInteractionCapabilities,
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionRoleRunner,
  SparkHostLoopContext,
  SparkSessionLeaseIdentity,
  ToolEffect,
} from "@zendev-lab/spark-core";
import type { SparkTurnResumeCheckpoint } from "@zendev-lab/spark-turn";
import type {
  SparkReproUsageScope,
  SparkUsageExecutionKind,
  SparkUsageExecutionPersistence,
  SparkUsageExecutionStatus,
} from "@zendev-lab/spark-protocol/token-usage";

export type SparkHeadlessRoleRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started";

export type SparkHeadlessUserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;

export interface SparkHeadlessTokenUsageObservation {
  event: unknown;
  scope?: SparkReproUsageScope;
  executionId?: string;
  parentExecutionId?: string;
  kind?: SparkUsageExecutionKind;
  detailKind?: string;
  persistence?: SparkUsageExecutionPersistence;
  sessionId?: string;
  runRef?: string;
}

export interface SparkHeadlessTokenUsageContext extends Omit<
  SparkHeadlessTokenUsageObservation,
  "event"
> {
  /**
   * Repro scope may be resolved after the first provider response when the
   * current turn creates the Repro. The daemon buffers those observations and
   * binds them only if the same session owns an active Repro by turn end.
   */
  scope?: SparkReproUsageScope;
  executionId: string;
  kind: SparkUsageExecutionKind;
  persistence: SparkUsageExecutionPersistence;
  register?(execution: Omit<SparkHeadlessTokenUsageObservation, "event">): void;
  settle?(input: {
    executionId: string;
    status: Exclude<SparkUsageExecutionStatus, "running">;
    observedAt?: string;
  }): void;
  record(observation: SparkHeadlessTokenUsageObservation): void;
}

export interface SparkHeadlessSessionRunInput {
  cwd: string;
  workspaceId?: string;
  /** Trusted workspace-owned state root; execution cwd may be a subdir/worktree. */
  sparkStateRoot?: string;
  sessionId: string;
  /** Daemon-authoritative native transcript path for this session generation. */
  sessionPath?: string;
  prompt: SparkHeadlessUserContent;
  model?: string;
  thinkingLevel?: string;
  reset?: boolean;
  /** Internal transcript metadata for daemon-owned hidden execution. */
  sessionVisibility?: "internal";
  sessionPurpose?: "loop_tick";
  /** Continue a turn after daemon/process interrupt using persisted session state. */
  resumeFromInterrupt?: boolean;
  /** Exact pending tool-call continuation captured by a planned daemon restart. */
  restartCheckpoint?: SparkTurnResumeCheckpoint;
  /** Persist and yield when a restart is pending; otherwise return normally. */
  yieldForRestartIfRequested?: (checkpoint: SparkTurnResumeCheckpoint) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  sparkHome?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  /** Daemon-issued lease for the exact persistent session running this turn. */
  sessionLease?: SparkSessionLeaseIdentity;
  channelBinding?: {
    adapter: "feishu" | "infoflow" | "qqbot";
    externalKey: string;
    workspaceId?: string;
    recipient?: string;
    adapterId?: string;
    adapterAccountIdentity?: string;
  };
  invocationId?: string;
  stateBindingSessionId?: string;
  /** @deprecated Compatibility input; normalized before host construction. */
  taskExecutionScope?: import("@zendev-lab/spark-core").SparkTaskExecutionScope;
  stateOwnerSessionId?: string;
  loop?: SparkHostLoopContext;
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  /** Daemon Supervisor-backed nested Role execution port. */
  roleRunner?: ExtensionRoleRunner;
  roleRunRef?: string;
  requireStructuredOutcome?: boolean;
  /** Host-enforced effect allowlist; unknown tool effects are denied. */
  allowedToolEffects?: readonly ToolEffect[];
  mode?: "plan" | "execute" | "fleet";
  /** Optional base identity/surface prompt; defaults to Spark host identity. */
  systemPrompt?: string;
  /** Display-safe metadata persisted on the submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /** Tool approval method inherited by the headless host. */
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
  /** Daemon-owned UI bridge used by blocking and async structured asks. */
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  /** Exact capabilities of the daemon-owned interaction bridge. */
  interactionCapabilities?: ExtensionInteractionCapabilities;
  /** Internal daemon accounting context; never serialized onto the session transcript. */
  tokenUsage?: SparkHeadlessTokenUsageContext;
  onEvent?: (event: unknown) => void | Promise<void>;
}

export interface SparkHeadlessSessionCompactInput {
  cwd: string;
  workspaceId?: string;
  /** Trusted workspace-owned state root; execution cwd may be a worktree. */
  sparkStateRoot?: string;
  sessionId: string;
  /** Daemon-authoritative transcript path for this exact Session generation. */
  sessionPath: string;
  operationId: string;
  customInstructions?: string;
  model?: string;
  thinkingLevel?: string;
  sparkHome?: string;
  sessionLease?: SparkSessionLeaseIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Daemon-private cancellation fence. Once this synchronous hook returns,
   * transcript replacement has entered its irreversible commit phase.
   */
  beforeTranscriptCommit?: () => void;
  /** Run the atomic transcript replacement inside the daemon owner's commit boundary. */
  commitTranscriptReplacement?: (replace: () => Promise<void>) => Promise<void>;
}

export interface SparkHeadlessSessionCompactResult {
  sessionId: string;
  sessionPath: string;
  succeeded: boolean;
  replayed: boolean;
  compactionEntryId?: string;
  tokensBefore?: number;
  tokensAfter: number;
  assistantText: string;
}

export type SparkHeadlessSessionExecutor = (
  input: SparkHeadlessSessionRunInput,
) => Promise<unknown>;

export type CreateSparkHeadlessSessionExecutorFn = (options?: {
  /** Session/runtime state root. */
  sparkHome?: string;
  /** Provider config and auth root, independent from daemon session storage. */
  controlSparkHome?: string;
}) => SparkHeadlessSessionExecutor;

export type SparkHeadlessSessionCompactor = (
  input: SparkHeadlessSessionCompactInput,
) => Promise<SparkHeadlessSessionCompactResult>;

export type CreateSparkHeadlessSessionCompactorFn = (options?: {
  sparkHome?: string;
  controlSparkHome?: string;
}) => SparkHeadlessSessionCompactor;

export type CreateSparkHeadlessRoleExecutorFn = (options?: {
  sparkHome?: string;
  controlSparkHome?: string;
  tokenUsage?: SparkHeadlessTokenUsageContext;
}) => ExtensionRoleRunner;

export interface SparkHeadlessSessionModule {
  createSparkHeadlessSessionExecutor: CreateSparkHeadlessSessionExecutorFn;
  createSparkHeadlessSessionCompactor?: CreateSparkHeadlessSessionCompactorFn;
  createSparkHeadlessRoleExecutor?: CreateSparkHeadlessRoleExecutorFn;
  /** Load the runtime graph before daemon admission opens. */
  preloadSparkHeadlessSessionRuntime?: () => Promise<void>;
  runSparkHeadlessSession?: unknown;
}

export {
  DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  SPARK_HEADLESS_EXECUTOR_MODULE_ENV,
  resolveSparkHeadlessExecutorSpecifier,
} from "@zendev-lab/spark-system/headless-module";
export type { SparkHeadlessExecutorModuleSpecifier } from "@zendev-lab/spark-system/headless-module";

export async function loadSparkHeadlessSessionModule(
  options: {
    moduleSpecifier?: string;
    importModule?: (specifier: string) => Promise<SparkHeadlessSessionModule>;
  } = {},
): Promise<SparkHeadlessSessionModule> {
  const specifier = resolveSparkHeadlessExecutorSpecifier(
    options.moduleSpecifier ??
      process.env[SPARK_HEADLESS_EXECUTOR_MODULE_ENV] ??
      DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  );
  if (options.importModule) return await options.importModule(specifier);

  return (await import(specifier)) as SparkHeadlessSessionModule;
}
