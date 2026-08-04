import type { SparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import type { SparkSessionLeaseIdentity, ToolEffect } from "@zendev-lab/spark-core";
import type { SparkConfig } from "./config.ts";
import type { SparkExtensionLoadResult } from "./extension-loader.ts";
import type { SparkKeybindings } from "./keybindings.ts";
import type { SparkModelSelector, SparkModelPicker } from "./model-selector.ts";
import type { SparkHostModelRegistry } from "./model-registry.ts";
import type { LoadResult } from "./plugin-loader.ts";
import type { SparkPromptTemplateResolveResult } from "./prompt-templates.ts";
import type { SparkProviderRegistry } from "./provider-registry.ts";
import type { SparkHostRuntime, SparkHostRuntimeOptions } from "./runtime.ts";
import type { SparkSessionStore } from "./session-store.ts";
import type { SparkSkillResolver } from "./skill-resolver.ts";
import type { SparkTheme, SparkThemeCatalog } from "./theme.ts";
import type { SparkAgentLoop } from "./agent-loop.ts";
import type { SparkAuthStore, SparkProviderAuthResolver } from "./auth.ts";

export interface SparkCliHostDiagnostic {
  type: "warning" | "error";
  message: string;
}

export interface SparkCompactionModelRunnerRequest {
  model: string;
  prompt: string;
  maxTokens: number;
}

export type SparkCompactionModelRunner = (
  request: SparkCompactionModelRunnerRequest,
) => Promise<unknown>;

export interface SparkCliHostServices {
  cwd: string;
  config: SparkConfig;
  saveConfig?: (config: SparkConfig) => Promise<void>;
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
  extensionLoadResult: SparkExtensionLoadResult;
  providerLoadResult: LoadResult;
  diagnostics: SparkCliHostDiagnostic[];
  themeCatalog?: SparkThemeCatalog;
  theme?: SparkTheme;
}

export interface SparkCliHostServicesOptions {
  cwd?: string;
  workspaceId?: string;
  sparkHome?: string;
  sparkStateRoot?: string;
  sessionSurface?: "local" | "channel";
  sessionSource?: "tui" | "web" | "channel" | "daemon" | "session";
  sessionLease?: SparkSessionLeaseIdentity;
  channelBinding?: SparkHostRuntimeOptions["channelBinding"];
  invocationId?: string;
  /** Host-private test/bootstrap seam; never exposed to extensions or model tools. */
  memoryDirectIntentAuthority?: SparkMemoryDirectIntentTurnAuthority;
  stateOwnerSessionId?: string;
  driver?: SparkHostRuntimeOptions["driver"];
  sessionQuestionChain?: readonly string[];
  allowedTools?: readonly string[];
  allowedToolEffects?: readonly ToolEffect[];
  config?: SparkConfig;
  configPath?: string;
  keybindingsPath?: string;
  hasUI?: boolean;
  ui?: SparkHostRuntimeOptions["ui"];
  sessionManager?: SparkHostRuntimeOptions["sessionManager"];
  extensions?: string[];
  providers?: string[];
  extensionImporter?: (specifier: string) => Promise<unknown>;
  providerImporter?: (specifier: string) => Promise<unknown>;
  authPath?: string;
  authStore?: SparkAuthStore;
  authEnv?: NodeJS.ProcessEnv;
  modelPicker?: SparkModelPicker;
  systemPrompt?: string;
  noPromptTemplates?: boolean;
  executionPhase?: "plan" | "implement";
  streamTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  toolTimeoutMs?: number;
  interactionTimeoutMs?: number;
  approvalMethod?: "skip" | "human" | "auto";
  approvalRejectAction?: "ask" | "deny";
}

export type SparkCliHostServicesFactory = (
  options?: SparkCliHostServicesOptions,
) => Promise<SparkCliHostServices>;
