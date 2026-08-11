import type {
  ExtensionInteractionRequest,
  ExtensionInteractionResponse,
  ExtensionRoleRunner,
  SparkHostLoopContext,
  SparkHostContext,
  SparkSessionLeaseIdentity,
  ToolPolicy,
} from "@zendev-lab/spark-core";
import type { ToolCallComponent, ToolCallRenderTheme } from "./tool-rendering.ts";

export interface SparkRegisteredToolConfig {
  name: string;
  label?: string;
  description: string;
  promptGuidelines?: string[];
  policy?: ToolPolicy;
  resolvePolicy?: (args: Readonly<Record<string, unknown>>) => ToolPolicy;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkToolContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export type SparkToolRegistrar = (config: SparkRegisteredToolConfig) => void;

export interface SparkSessionModelRef {
  provider?: unknown;
  id?: unknown;
}

export interface SparkToolContext {
  cwd: string;
  workspaceId?: string;
  sparkStateRoot?: string;
  sessionId?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  sessionLease?: () => SparkSessionLeaseIdentity | undefined;
  invocationId?: string;
  loop?: SparkHostLoopContext;
  /** Command-host bridge for dispatching a turn through an externally owned session runtime. */
  sendUserMessage?: (content: string) => Promise<void>;
  model?: SparkSessionModelRef;
  /** Daemon-backed model catalog projection supplied by the native host. */
  modelRegistry?: unknown;
  runRole?: ExtensionRoleRunner;
  roleNativeCompatibilityRecovery?: {
    sparkHome?: string;
    controlSparkHome?: string;
  };
  sparkActiveMode?: {
    mode: "plan" | "execute" | "fleet";
  };
  isIdle?: () => boolean;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
    isPersisted?: () => boolean;
  };
  hasUI?: boolean;
  askAutoAnswer?: boolean;
  askAutoAnswerResolver?: (request: unknown, ctx: any) => Promise<unknown>;
  /** Internal host policy; models cannot set the human-wait deadline. */
  askWaitTimeoutMs?: number;
  /** @deprecated Compatibility alias for askWaitTimeoutMs. */
  askReviewerFallbackAfterMs?: number;

  sparkAutonomousGoalTurn?: { goalId: string };
  sparkAutonomousAsk?: SparkHostContext["sparkAutonomousAsk"];
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error" | "success") => void;
    confirm?: (title: string, message: string) => Promise<boolean>;
    input?: (title: string, defaultValue?: string) => Promise<string | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    selectWithCustom?: (
      title: string,
      input: { options: string[]; customLabel: string },
    ) => Promise<{ value?: string; customText?: string } | string | undefined>;
    setWidget?: (key: string, cb: unknown, opts?: { placement?: string }) => void;
    setStatus?: (key: string, text: string | undefined) => void;
    setEditorText?: (text: string) => void;
    custom?: (...args: unknown[]) => unknown;
    interaction?: (request: ExtensionInteractionRequest) => Promise<ExtensionInteractionResponse>;
  };
}
