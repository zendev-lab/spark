import type { SparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-memory/direct-intent";
import type { SparkHeadlessTokenUsageContext } from "@zendev-lab/spark-host/headless-loader";
import type {
  ExtensionRoleRunner,
  SparkSessionLeaseIdentity,
  ToolEffect,
} from "@zendev-lab/spark-core";
import type { SparkConfig } from "./config.ts";
import type { SparkKeybindings } from "@zendev-lab/spark-host/keybindings";
import type { SparkModelSelector, SparkModelPicker } from "./model-selector.ts";
import type { SparkHostModelRegistry } from "./model-registry.ts";
import type { ProviderPluginLoadResult } from "./provider-plugin-loader.ts";
import type { SparkPromptTemplateResolveResult } from "./prompt-templates.ts";
import type { SparkProviderRegistry } from "./provider-registry.ts";
import type { SparkHostRuntime, SparkHostRuntimeOptions } from "@zendev-lab/spark-host";
import type { SparkSessionStore } from "@zendev-lab/spark-session/transcript";
import type { SparkSkillResolver } from "@zendev-lab/spark-roles/skill-resolver";
import type { SparkTheme, SparkThemeCatalog } from "./theme.ts";
import type { SparkAgentLoop } from "./agent-loop.ts";
import type { SparkDshTurnRuntime } from "@zendev-lab/spark-turn";
import type { SparkAuthStore, SparkProviderAuthResolver } from "./auth.ts";
export interface SparkCliHostDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface SparkCompactionModelRunnerRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export type SparkCompactionModelRunner = (
  request: SparkCompactionModelRunnerRequest,
) => Promise<unknown>;

export interface SparkCliHostServices {
  cwd: string;
  config: SparkConfig;
  saveConfig?: (
    config: SparkConfig,
    options?: import("./config.ts").SparkConfigSaveOptions,
  ) => Promise<void>;
  runtime: SparkHostRuntime;
  memoryDirectIntentAuthority?: SparkMemoryDirectIntentTurnAuthority;
  keybindings: SparkKeybindings;
  providerRegistry: SparkProviderRegistry;
  authStore?: SparkAuthStore;
  authResolver?: SparkProviderAuthResolver;
  modelRegistry?: SparkHostModelRegistry;
  modelSelector: SparkModelSelector;
  sessionStore: SparkSessionStore;
  runCompactionModel?: SparkCompactionModelRunner;
  skillResolver: SparkSkillResolver;
  promptTemplates?: SparkPromptTemplateResolveResult;
  agentLoop: SparkAgentLoop;
  disposeLlm?: () => Promise<void>;
  providerLoadResult: ProviderPluginLoadResult;
  diagnostics: SparkCliHostDiagnostic[];
  themeCatalog?: SparkThemeCatalog;
  theme?: SparkTheme;
}

export interface SparkCliHostServicesOptions {
  cwd?: string;
  workspaceId?: string;
  sparkHome?: string;
  /** Control-plane Spark root retained across nested daemon-native role runs. */
  controlSparkHome?: string;
  sparkStateRoot?: string;
  /** Daemon-owned shared DSH composition root; hosts never construct their own root. */
  dshContext?: SparkDshTurnRuntime["ctx"];
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  sessionLease?: SparkSessionLeaseIdentity;
  channelBinding?: SparkHostRuntimeOptions["channelBinding"];
  invocationId?: string;
  invocationAttempt?: SparkHostRuntimeOptions["invocationAttempt"];
  invocationRole?: SparkHostRuntimeOptions["invocationRole"];
  driverAuthority?: SparkHostRuntimeOptions["driverAuthority"];
  taskExecutionScope?: SparkHostRuntimeOptions["taskExecutionScope"];
  /** Host-private test/bootstrap seam; never exposed to product capabilities or model tools. */
  memoryDirectIntentAuthority?: SparkMemoryDirectIntentTurnAuthority;
  /** Host-private Skill discovery seam for isolated hosts and tests. */
  skillResolver?: SparkSkillResolver;
  tokenUsage?: SparkHeadlessTokenUsageContext;
  loop?: SparkHostRuntimeOptions["loop"];
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  /** Host-private nested Role port; daemon executions inject SessionSupervisor here. */
  roleRunner?: ExtensionRoleRunner;
  allowedToolEffects?: readonly ToolEffect[];
  config?: SparkConfig;
  configPath?: string;
  keybindingsPath?: string;
  hasUI?: boolean;
  ui?: SparkHostRuntimeOptions["ui"];
  sessionManager?: SparkHostRuntimeOptions["sessionManager"];
  providers?: string[];
  providerImporter?: (specifier: string) => Promise<unknown>;
  authPath?: string;
  authStore?: SparkAuthStore;
  authEnv?: NodeJS.ProcessEnv;
  modelPicker?: SparkModelPicker;
  systemPrompt?: string;
  noPromptTemplates?: boolean;
  sessionMode?: "plan" | "execute" | "fleet";
  streamTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  toolTimeoutMs?: number;
  interactionTimeoutMs?: number;
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
  /** Host-private roots for reviewer-only isolated native compatibility recovery. */
  roleNativeCompatibilityRecovery?: SparkHostRuntimeOptions["roleNativeCompatibilityRecovery"];
}

export type SparkCliHostServicesFactory = (
  options?: SparkCliHostServicesOptions,
) => Promise<SparkCliHostServices>;
