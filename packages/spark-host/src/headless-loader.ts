import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type {
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
  stateOwnerSessionId?: string;
  loop?: SparkHostLoopContext;
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  /** Host-enforced effect allowlist; unknown tool effects are denied. */
  allowedToolEffects?: readonly ToolEffect[];
  /** Optional base identity/surface prompt; defaults to Spark host identity. */
  systemPrompt?: string;
  /** Display-safe metadata persisted on the submitted user message only. */
  messageMetadata?: Record<string, unknown>;
  /** Tool approval method inherited by the headless host. */
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
  /** Daemon-owned UI bridge used by blocking and async structured asks. */
  interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  /** Internal daemon accounting context; never serialized onto the session transcript. */
  tokenUsage?: SparkHeadlessTokenUsageContext;
  onEvent?: (event: unknown) => void | Promise<void>;
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

export type CreateSparkHeadlessRoleExecutorFn = (options?: {
  sparkHome?: string;
  controlSparkHome?: string;
  tokenUsage?: SparkHeadlessTokenUsageContext;
}) => ExtensionRoleRunner;

export interface SparkHeadlessSessionModule {
  createSparkHeadlessSessionExecutor: CreateSparkHeadlessSessionExecutorFn;
  createSparkHeadlessRoleExecutor?: CreateSparkHeadlessRoleExecutorFn;
  runSparkHeadlessSession?: unknown;
}

export const DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE =
  "@zendev-lab/spark-tui/headless-role-executor" as const;

/** Set by the single-package npm launcher to its compiled executor artifact. */
export const SPARK_HEADLESS_EXECUTOR_MODULE_ENV = "SPARK_HEADLESS_EXECUTOR_MODULE" as const;

export type SparkHeadlessExecutorModuleSpecifier = typeof DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE;

/**
 * Resolve the headless executor to a real filesystem path.
 * Node refuses `--experimental-strip-types` under `node_modules/`; pnpm links the
 * workspace package there, so we import via the realpath file URL instead.
 */
export function resolveSparkHeadlessExecutorSpecifier(
  moduleSpecifier: string = DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
): string {
  if (moduleSpecifier.startsWith("file:") || moduleSpecifier.startsWith("/")) {
    return moduleSpecifier;
  }
  try {
    const resolved = import.meta.resolve(moduleSpecifier);
    const real = realpathSync(new URL(resolved));
    return pathToFileURL(real).href;
  } catch {
    return moduleSpecifier;
  }
}

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
