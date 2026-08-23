/** Host/tool registration types and policies for spark-cue. */

import type {
  SparkTaskExecutionScope,
  ToolEffect,
  ToolExecutionMode,
  ToolPolicy,
} from "@zendev-lab/spark-core";
import { ToolCallText } from "@zendev-lab/spark-text-rendering";
import type { CueClient, CueResolvedTransport, SpawnAdapterHandle } from "../client/cue-client.ts";

export interface SparkCueHostApi {
  registerTool(config: SparkCueToolConfig): void;
  on?(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
}

export type SparkCueNotifyLevel = "info" | "warning" | "error" | "success";

export interface SparkCueToolContext {
  cwd?: string;
  sessionId?: string;
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  env?: Record<string, string | undefined>;
  cueClient?: CueClient;
  /** Internal resolved transport used to keep SSH cwd selection explicit. */
  cueResolvedTransport?: CueResolvedTransport;
  /** Explicit remote cwd; local session paths are never mapped onto SSH hosts. */
  cueRemoteCwd?: string;
  /** Whether an unreachable local daemon may be auto-started. Defaults to true. */
  cueAutoStartLocal?: boolean;
  /** Explicit per-host override for forwarding sensitive environment variables. */
  cueForwardSensitiveEnv?: boolean;
  /** Opaque per-execution launch lease; policy remains owned by the host adapter. */
  cueSpawnAdapter?: SpawnAdapterHandle;
  taskExecutionScope?: SparkTaskExecutionScope;
  ui?: { notify?: (msg: string, level: SparkCueNotifyLevel) => void };
}

export interface SparkCueToolRegistration {
  releaseSession(ctx?: SparkCueToolContext): void;
  dispose(): void;
}

export interface SparkCueToolConfig {
  name: string;
  label?: string;
  description: string;
  policy?: ToolPolicy;
  resolvePolicy?: (args: Readonly<Record<string, unknown>>) => ToolPolicy;
  /** Legacy mirrors populated from policy for Pi/current Spark turn hosts. */
  effect?: ToolEffect;
  executionMode?: ToolExecutionMode;
  /** Cue exec family tools require host approval gated by session approvalMethod. */
  requiresApproval?: boolean;
  parameters: unknown;
  renderCall?: (
    args: Record<string, unknown>,
    theme: ToolCallRenderTheme,
    context: unknown,
  ) => ToolCallComponent;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkCueToolContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

export const CUE_EXECUTION_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "execution"],
  // Temporary: skip host approve/ask gates for cue exec while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_JOBS_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "jobs"],
  // Temporary: skip host approve/ask gates for cue jobs while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_RESOURCES_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "resources"],
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_SCHEDULE_TOOL_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "schedules"],
  // Temporary: skip host approve/ask gates for cue schedule while iterating locally.
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_SCOPE_TOOL_POLICY = {
  // cue_scope combines inspection with cwd/env mutation, so the whole action
  // surface is conservatively stateful until actions gain parameter policies.
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "scope"],
  approval: "none",
} as const satisfies ToolPolicy;

export const CUE_HISTORY_TOOL_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "history"],
  approval: "none",
} as const satisfies ToolPolicy;

export function registerCueTool(pi: SparkCueHostApi, config: SparkCueToolConfig): void {
  const effect = config.effect ?? config.policy?.effect;
  const executionMode = config.executionMode ?? config.policy?.executionMode;
  const requiresApproval =
    config.requiresApproval ?? (config.policy?.approval === "required" ? true : undefined);
  pi.registerTool({
    ...config,
    ...(effect ? { effect } : {}),
    ...(executionMode ? { executionMode } : {}),
    ...(requiresApproval === true ? { requiresApproval } : {}),
  });
}

export interface ToolCallRenderTheme {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface ToolCallComponent {
  render(width: number): string[];
}

export { ToolCallText };
