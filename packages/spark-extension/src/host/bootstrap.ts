/** Spark TUI native host service construction. */

import { basename, join, resolve } from "node:path";
import { stableId, type SparkHostAPI } from "@zendev-lab/spark-core";
import { resolveSparkUserPaths } from "@zendev-lab/spark-system";
import {
  adaptersFromProviderRegistry,
  createProviderRegistryLeafRunner,
  createProviderRegistryWorkflowModelRunner,
  type Model,
  type SparkProviderAttemptObservation,
} from "@zendev-lab/spark-llm";
import { createSparkLlmComposition } from "../llm-runtime.ts";
import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import {
  DEFAULT_SPARK_IDENTITY_PROMPT,
  renderAgentRuntimeContextPrompt,
} from "@zendev-lab/spark-host/system-prompt";
import type { SparkHeadlessTokenUsageContext } from "@zendev-lab/spark-host/headless-loader";
import { composeAgentSystemPrompt } from "@zendev-lab/spark-modes";
import {
  SparkRolesReviewerRunner,
  createSparkRoleRegistry,
  loadSparkMode,
  renderSparkActiveSystemPrompt,
  type SparkSessionContext,
} from "../host-support.ts";
import type {
  SparkCliHostServices,
  SparkCliHostServicesOptions,
  SparkCliHostDiagnostic,
  SparkCompactionModelRunner,
} from "./contracts.ts";
export type {
  SparkCliHostServices,
  SparkCliHostServicesOptions,
  SparkCliHostDiagnostic,
  SparkCompactionModelRunner,
  SparkCompactionModelRunnerRequest,
} from "./contracts.ts";

import { SparkAuthStore, SparkProviderAuthResolver, defaultSparkAuthPath } from "./auth.ts";
import {
  type SparkConfig,
  defaultSparkConfigPath,
  loadSparkConfig,
  saveSparkConfig,
} from "./config.ts";
import { SparkExtensionLoader, selectSparkAgentPlugins } from "./extension-loader.ts";
import { SparkKeybindings } from "@zendev-lab/spark-host/keybindings";
import {
  SparkModelSelector,
  registerSparkModelSelectorKeybindings,
  resolveSparkModelSelectionById,
  sparkModelSelectionValue,
} from "./model-selector.ts";
import { SparkHostModelRegistry } from "./model-registry.ts";
import { loadPlugins, type LoadResult } from "./plugin-loader.ts";
import {
  SparkPromptTemplateResolver,
  type SparkPromptTemplateResolveResult,
} from "./prompt-templates.ts";
import { SparkProviderRegistry, type SparkActiveSelection } from "./provider-registry.ts";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import { SparkSessionStore } from "@zendev-lab/spark-session/transcript";
import {
  SparkSkillResolver,
  formatSelectedSparkSkillsForPrompt,
  type SparkSkillPromptMatch,
} from "@zendev-lab/spark-roles/skill-resolver";
import { loadSparkThemeCatalog } from "./theme.ts";

import { SparkAgentLoop } from "./agent-loop.ts";
export async function createSparkCliHostServices(
  options: SparkCliHostServicesOptions = {},
): Promise<SparkCliHostServices> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const diagnostics: SparkCliHostDiagnostic[] = [];
  const configPath =
    options.configPath ??
    (options.sparkHome ? join(options.sparkHome, "config.json") : defaultSparkConfigPath());
  const config = options.config ?? (await loadSparkConfig(configPath));
  const saveLoadedConfig = (
    nextConfig: SparkConfig,
    options?: import("./config.ts").SparkConfigSaveOptions,
  ) => saveSparkConfig(nextConfig, configPath, options);

  const keybindings = new SparkKeybindings();
  const keybindingsPath =
    options.keybindingsPath ?? defaultSparkCliKeybindingsPath(options.sparkHome);
  try {
    await keybindings.loadFromDisk(keybindingsPath);
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: `Failed to load keybindings: ${errorMessage(error)}`,
    });
  }

  const memoryDirectIntentAuthority =
    options.sessionSurface === "channel"
      ? undefined
      : (options.memoryDirectIntentAuthority ?? createSparkMemoryDirectIntentTurnAuthority());
  const runtime = new SparkHostRuntime({
    cwd,
    workspaceId: options.workspaceId,
    sparkStateRoot: options.sparkStateRoot,
    sessionSurface: options.sessionSurface,
    sessionSource: options.sessionSource,
    channelBinding: options.channelBinding,
    invocationId: options.invocationId,
    taskExecutionScope: options.taskExecutionScope,
    memoryDirectIntentAuthority,
    loop: options.loop,
    sessionQuestionChain: options.sessionQuestionChain,
    roleNativeCompatibilityRecovery: options.roleNativeCompatibilityRecovery,
    allowedTools: options.allowedTools,
    allowedToolEffects: options.allowedToolEffects,
    hasUI: options.hasUI ?? false,
    ui: options.ui,
    sessionManager: options.sessionManager,
    keybindings,
  });
  if (options.sessionLease) runtime.setSessionLeaseProvider(() => options.sessionLease);
  // Registered before extensions so request-scoped prompt state is cleared
  // before any extension's agent_end handler can enqueue a background turn.
  let clearRequestSkillSelection: () => void = () => undefined;
  runtime.on("agent_end", () => clearRequestSkillSelection());

  const providerRegistry = new SparkProviderRegistry();
  const providerLoadResult = await loadPlugins({
    extensionApi: runtime,
    providerApi: providerRegistry,
    extensions: [],
    providers: options.providers ?? config.providers,
    importer: options.providerImporter,
  });
  for (const outcome of providerLoadResult.outcomes) {
    if (!outcome.ok)
      diagnostics.push({
        type: "warning",
        message: `Provider ${outcome.specifier}: ${outcome.error}`,
      });
  }
  const activeSelection = selectInitialModel(providerRegistry, config);
  if (!activeSelection) {
    diagnostics.push({ type: "warning", message: "No Spark model is registered yet." });
  }
  const authStore =
    options.authStore ??
    new SparkAuthStore({ path: options.authPath ?? defaultSparkAuthPath(options.sparkHome) });
  await authStore.reload();
  if (authStore.loadError) {
    diagnostics.push({
      type: "warning",
      message: `Failed to load Spark auth store: ${errorMessage(authStore.loadError)}`,
    });
  }
  const authResolver = new SparkProviderAuthResolver(authStore, { env: options.authEnv });
  const resolveApiKey = (provider: Parameters<typeof authResolver.resolveApiKeyAsync>[0]) =>
    authResolver.resolveApiKeyAsync(provider);
  runtime.setLeafRunner(
    createProviderRegistryLeafRunner({
      registry: providerRegistry,
      runnerOptions: { resolveApiKey },
      ...(options.tokenUsage
        ? {
            observeProviderAttempt: (observation: SparkProviderAttemptObservation) =>
              recordProviderTokenUsage(options.tokenUsage, observation),
          }
        : {}),
    }),
  );
  const modelRegistry = new SparkHostModelRegistry(providerRegistry, {
    authResolver,
    getError: () => formatProviderLoadError(providerLoadResult),
  });
  runtime.setModelRegistry(modelRegistry);

  const modelSelector = new SparkModelSelector({
    registry: providerRegistry,
    config,
    saveConfig: saveLoadedConfig,
    picker: options.modelPicker,
  });
  registerSparkModelSelectorKeybindings(keybindings, modelSelector, {
    notify: (message, level) => runtime.makeContext().ui?.notify?.(message, level),
  });
  keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle the assistant thinking level (off/minimal/low/medium/high/xhigh)",
    handler: async () => {
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
      const current = config.activeThinkingLevel;
      const index = current ? levels.indexOf(current) : -1;
      const next = levels[(index + 1) % levels.length]!;
      config.activeThinkingLevel = next;
      await saveLoadedConfig(config);
      runtime.makeContext().ui?.notify?.(`thinking ${next}`, "info");
    },
  });

  const sessionStore = new SparkSessionStore({ cwd, sparkHome: options.sparkHome });
  const workflowModelRunner = createProviderRegistryWorkflowModelRunner(providerRegistry, {
    resolveApiKey: (provider) => authResolver.resolveApiKeyAsync(provider),
    ...(options.tokenUsage
      ? {
          observeProviderAttempt: (observation: SparkProviderAttemptObservation) =>
            recordProviderTokenUsage(options.tokenUsage, observation),
        }
      : {}),
  });
  const runCompactionModel: SparkCompactionModelRunner = async (request) => {
    const response = await workflowModelRunner({
      prompt: request.prompt,
      label: "compact-v2-smart-summary",
      phase: "compact",
      model: request.model,
      metadata: { purpose: "session_compaction" },
      maxTokens: request.maxTokens,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return response.structured ?? response.text;
  };
  runtime.setSessionManager(
    options.sessionManager ?? createSparkCliSessionManagerStub(sessionStore, cwd),
  );

  const agentPluginSelection = selectSparkAgentPlugins(options.extensions ?? config.extensions);
  const extensionLoadResult = await new SparkExtensionLoader({
    api: runtime as SparkHostAPI,
    extensions: agentPluginSelection.extensionSpecs,
    importer: options.extensionImporter,
  }).load();
  extensionLoadResult.outcomes.push(...agentPluginSelection.outcomes);
  for (const outcome of extensionLoadResult.outcomes) {
    if (!outcome.ok)
      diagnostics.push({
        type: "warning",
        message: `Extension ${outcome.specifier}: ${outcome.error}`,
      });
  }

  const themeCatalog = await loadSparkThemeCatalog({
    cwd,
    sparkHome: options.sparkHome,
    configuredThemePaths: config.themes ?? [],
    activeThemeId: config.activeTheme,
  });
  for (const diagnostic of themeCatalog.diagnostics) diagnostics.push(diagnostic);

  // Role execution is daemon-owned. Headless hosts receive the supervised
  // adapter explicitly; an embedded host must not create a second lifecycle.
  runtime.setRoleRunner(options.roleRunner);
  const skillResolver =
    options.skillResolver ??
    new SparkSkillResolver({
      cwd,
      sparkHome: options.sparkHome,
      skillDirs: config.skills ?? [],
    });
  const promptTemplateResolver = new SparkPromptTemplateResolver({
    cwd,
    sparkHome: options.sparkHome,
    promptTemplatePaths: config.promptTemplates ?? [],
    includeDefaults: options.noPromptTemplates !== true,
  });
  const promptTemplates = await promptTemplateResolver.resolve();
  for (const diagnostic of promptTemplates.diagnostics) {
    diagnostics.push({ type: "warning", message: formatPromptTemplateDiagnostic(diagnostic) });
  }
  const skillsCatalogPrompt = await skillResolver.formatAvailableSkillsForPrompt();
  let selectedSkillMatches: SparkSkillPromptMatch[] = [];
  let selectedSkillsPrompt = "";
  const baseSystemPrompt = options.systemPrompt ?? DEFAULT_SPARK_IDENTITY_PROMPT;
  const initialPromptState = await resolveSparkCliAgentPromptState(
    cwd,
    runtime.makeContext(),
    baseSystemPrompt,
    skillsCatalogPrompt,
    selectedSkillsPrompt,
  );
  if (!options.dshContext) {
    throw new Error("Spark host services require the daemon shared DSH context");
  }
  const llmComposition = await createSparkLlmComposition({
    ctx: options.dshContext,
    routeNamespace: options.invocationId ?? globalThis.crypto.randomUUID(),
    adapters: adaptersFromProviderRegistry(providerRegistry, { resolveApiKey }),
  });
  runtime.on("session_shutdown", () => {
    void llmComposition.dispose();
  });
  const agentLoop = new SparkAgentLoop({
    host: runtime,
    llm: llmComposition.llm,
    dshContext: options.dshContext,
    agentPlugins: agentPluginSelection.agentPlugins,
    getModel: () => {
      const model = providerRegistry.buildActiveModel();
      if (!model) throw new Error("No active Spark model selected");
      return model as Model<string>;
    },
    getReasoning: () => config.activeThinkingLevel,
    beforeProviderRequest: ({ model, estimate, requestedOutputTokens }) => {
      const contextWindow = positiveFiniteInteger(model.contextWindow);
      if (!contextWindow) return;
      const estimatedRequestTokens = estimate.tokens + requestedOutputTokens;
      // The earlier session preflight owns the configurable reserve and early
      // compaction thresholds. This final assembled-envelope guard is the hard
      // provider boundary. SparkAgentLoop has already clamped the configured
      // output budget, so this validates the exact envelope sent downstream.
      if (
        sparkProviderRequestFitsContextWindow(estimate.tokens, requestedOutputTokens, contextWindow)
      ) {
        return;
      }
      const error = new Error(
        `Spark provider request preflight estimated ${estimatedRequestTokens} tokens ` +
          `(messages=${estimate.messageTokens}, system=${estimate.systemPromptTokens}, ` +
          `tools=${estimate.toolTokens}, output=${requestedOutputTokens}), exceeding ` +
          `context window ${contextWindow}.`,
      ) as Error & { code?: string };
      error.code = "SPARK_CONTEXT_OVERFLOW_PREFLIGHT";
      throw error;
    },
    systemPrompt: initialPromptState.systemPrompt,
    streamTimeoutMs: options.streamTimeoutMs,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    toolTimeoutMs: options.toolTimeoutMs,
    interactionTimeoutMs: options.interactionTimeoutMs,
    prepareUserSubmit: async (request) => {
      // Selection belongs to exactly one real user request. Clear the prior
      // bodies before resolving so an empty/unmatched request cannot inherit
      // stale instructions from the preceding turn.
      selectedSkillMatches = [];
      selectedSkillsPrompt = "";
      try {
        selectedSkillMatches = await skillResolver.loadMatchingSkillsForPrompt(request, 3);
        selectedSkillsPrompt = formatSelectedSparkSkillsForPrompt(selectedSkillMatches);
      } finally {
        // A disappearing/unreadable skill may reject this submit, but it must
        // never leave the previous request's bodies installed in the prompt.
        const promptState = await resolveSparkCliAgentPromptState(
          cwd,
          runtime.makeContext(),
          baseSystemPrompt,
          skillsCatalogPrompt,
          selectedSkillsPrompt,
        );
        agentLoop.setSystemPrompt(promptState.systemPrompt);
        agentLoop.setCurrentMode(options.sessionMode ?? promptState.mode);
      }
    },
    finishUserSubmit: () => clearRequestSkillSelection(),
    promptManifest: {
      getSelectedSkills: () => selectedSkillMatches.map((match) => match.skill.name),
    },
    // Manual turns require human approval. A driver bypasses `manual_only`
    // only after the Session has a persisted `driverAuthority: "granted"` fact.
    approvalMethod: options.approvalMethod ?? "human",
    ...(options.approvalRejectAction ? { approvalRejectAction: options.approvalRejectAction } : {}),
    reviewToolApproval: async (request, signal) => {
      const ctx = runtime.makeContext();
      const reviewer = new SparkRolesReviewerRunner({
        registry: await createSparkRoleRegistry(cwd),
        cwd,
        nativeExecutor: ctx.runRole,
      });
      const result = await reviewer.review(
        {
          targetKind: "tool_approval",
          cwd,
          toolName: request.toolName,
          toolCallId: request.toolCallId,
          arguments: request.arguments,
          reason: request.reason,
          sessionKey: ctx.sessionId,
          forkFromSession: ctx.sessionManager?.getSessionFile?.(),
        },
        signal,
      );
      return {
        outcome: result.verdict.outcome,
        summary: result.verdict.summary,
      };
    },
  });
  agentLoop.setCurrentMode(options.sessionMode ?? initialPromptState.mode);
  clearRequestSkillSelection = () => {
    const hadSelection = selectedSkillMatches.length > 0 || selectedSkillsPrompt.length > 0;
    selectedSkillMatches = [];
    selectedSkillsPrompt = "";
    if (!hadSelection) return;
    agentLoop.setSystemPrompt(
      composeSparkCliAgentSystemPrompt(
        cwd,
        baseSystemPrompt,
        skillsCatalogPrompt,
        selectedSkillsPrompt,
        agentLoop.getCurrentMode() ?? initialPromptState.mode,
      ),
    );
  };
  runtime.on("before_agent_start", async (event, ctx) => {
    if (options.sessionMode) {
      agentLoop.setSystemPrompt(
        composeSparkCliAgentSystemPrompt(
          cwd,
          baseSystemPrompt,
          skillsCatalogPrompt,
          selectedSkillsPrompt,
          options.sessionMode,
        ),
      );
      agentLoop.setCurrentMode(options.sessionMode);
      return;
    }
    if (sparkAgentLifecycleSource(event) === "triggerTurn") {
      // Loop/background turns (goal, repro, workflow, scheduled continuations)
      // are not assist-plan turns. Do not inherit a request skill body or a
      // persisted plan/implement tool profile from the last user session.
      selectedSkillMatches = [];
      selectedSkillsPrompt = "";
      agentLoop.setSystemPrompt(
        composeSparkCliLoopSystemPrompt(cwd, baseSystemPrompt, skillsCatalogPrompt),
      );
      agentLoop.setCurrentMode(undefined);
      return;
    }
    const promptState = await resolveSparkCliAgentPromptState(
      cwd,
      ctx,
      baseSystemPrompt,
      skillsCatalogPrompt,
      selectedSkillsPrompt,
    );
    agentLoop.setSystemPrompt(promptState.systemPrompt);
    agentLoop.setCurrentMode(promptState.mode);
  });

  return {
    cwd,
    config,
    saveConfig: saveLoadedConfig,
    runtime,
    memoryDirectIntentAuthority,
    keybindings,
    providerRegistry,
    authStore,
    authResolver,
    modelRegistry,
    modelSelector,
    sessionStore,
    runCompactionModel,
    skillResolver,
    promptTemplates,
    agentLoop,
    disposeLlm: () => llmComposition.dispose(),
    extensionLoadResult,
    providerLoadResult,
    diagnostics,
    themeCatalog,
    theme: themeCatalog.active,
  };
}

function recordProviderTokenUsage(
  context: SparkHeadlessTokenUsageContext | undefined,
  observation: SparkProviderAttemptObservation,
): void {
  if (!context) return;
  const syntheticResponseId = `spark-provider-attempt:${observation.attemptId}`;
  const message =
    observation.outcome === "response"
      ? withProviderAttemptIdentity(observation.message, syntheticResponseId)
      : {
          role: "assistant",
          content: [],
          ...(observation.provider ? { provider: observation.provider } : {}),
          ...(observation.model ? { model: observation.model } : {}),
          responseId: syntheticResponseId,
          stopReason: "error",
          timestamp: observation.observedAt,
        };
  context.record({
    event: { type: "turn_complete", message, reason: "auxiliary_model" },
    ...(context.scope ? { scope: context.scope } : {}),
    executionId: context.executionId,
    kind: context.kind,
    persistence: context.persistence,
    ...(context.parentExecutionId ? { parentExecutionId: context.parentExecutionId } : {}),
    ...(context.detailKind ? { detailKind: context.detailKind } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runRef ? { runRef: context.runRef } : {}),
  });
}

function withProviderAttemptIdentity(
  message: object,
  syntheticResponseId: string,
): Record<string, unknown> {
  const record = message as Record<string, unknown>;
  const hasProviderIdentity = [record.providerResponseId, record.responseId, record.id].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  return hasProviderIdentity ? record : { ...record, responseId: syntheticResponseId };
}

async function resolveSparkCliAgentPromptState(
  cwd: string,
  ctx: SparkSessionContext,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
  selectedSkillsPrompt: string,
): Promise<{ systemPrompt: string; mode: "plan" | "execute" | "fleet" }> {
  const mode = (await loadSparkMode(cwd, ctx)).mode;
  return {
    mode,
    systemPrompt: composeSparkCliAgentSystemPrompt(
      cwd,
      baseSystemPrompt,
      skillsCatalogPrompt,
      selectedSkillsPrompt,
      mode,
    ),
  };
}

function composeSparkCliAgentSystemPrompt(
  cwd: string,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
  selectedSkillsPrompt: string,
  phase: "plan" | "execute" | "fleet",
): string {
  return composeAgentSystemPrompt([
    renderSparkActiveSystemPrompt(baseSystemPrompt, phase),
    skillsCatalogPrompt,
    selectedSkillsPrompt,
    renderAgentRuntimeContextPrompt({ cwd }),
  ]);
}

function composeSparkCliLoopSystemPrompt(
  cwd: string,
  baseSystemPrompt: string,
  skillsCatalogPrompt: string,
): string {
  return composeAgentSystemPrompt([
    baseSystemPrompt,
    skillsCatalogPrompt,
    renderAgentRuntimeContextPrompt({ cwd }),
  ]);
}

function sparkAgentLifecycleSource(event: unknown): "agentLoop" | "triggerTurn" {
  if (
    event &&
    typeof event === "object" &&
    (event as { source?: unknown }).source === "triggerTurn"
  ) {
    return "triggerTurn";
  }
  return "agentLoop";
}

export {
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
} from "@zendev-lab/spark-llm";
export type {
  SparkWorkflowModelRunRequest,
  SparkWorkflowModelRunResponse,
} from "@zendev-lab/spark-llm";

function formatProviderLoadError(providerLoadResult: LoadResult): string | undefined {
  const failures = providerLoadResult.outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return undefined;
  return failures
    .map((outcome) => `${outcome.specifier}: ${outcome.error ?? "unknown error"}`)
    .join("; ");
}

function positiveFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** The assembled request and its configured output budget must fit together. */
export function sparkProviderRequestFitsContextWindow(
  estimatedInputTokens: number,
  requestedOutputTokens: number,
  contextWindow: number,
): boolean {
  return estimatedInputTokens + requestedOutputTokens <= contextWindow;
}

export function selectInitialModel(
  registry: SparkProviderRegistry,
  config: SparkConfig,
): SparkActiveSelection | undefined {
  const configuredModelId = config.activeModelId;
  if (configuredModelId) {
    try {
      const selection = resolveSparkModelSelectionById(registry, configuredModelId);
      registry.setActive(selection);
      config.activeModelId = sparkModelSelectionValue(selection);
      delete config.activeProvider;
      delete config.activeModel;
      return selection;
    } catch {
      // Fall through to legacy pair or first registered model.
    }
  }

  if (config.activeProvider && config.activeModel) {
    try {
      const selection = { providerName: config.activeProvider, modelId: config.activeModel };
      registry.setActive(selection);
      config.activeModelId = sparkModelSelectionValue(selection);
      return selection;
    } catch {
      // Fall through to first registered model.
    }
  }

  const provider = registry.listProviders()[0];
  const model = provider?.models[0];
  if (!provider || !model) return undefined;
  const selection = { providerName: provider.name, modelId: model.id };
  registry.setActive(selection);
  config.activeModelId = sparkModelSelectionValue(selection);
  delete config.activeProvider;
  delete config.activeModel;
  return selection;
}

function createSparkCliSessionManagerStub(store: SparkSessionStore, cwd: string) {
  return {
    getSessionFile: () => currentSparkCliSessionFile(store, cwd),
    getLeafId: () => currentSparkCliLeafId(store, cwd),
  };
}

function currentSparkCliSessionFile(store: SparkSessionStore, cwd: string): string {
  return join(store.sessionDir, `${stableId(cwd)}.jsonl`);
}

function currentSparkCliLeafId(store: SparkSessionStore, cwd: string): string {
  return basename(currentSparkCliSessionFile(store, cwd), ".jsonl");
}

export function defaultSparkCliKeybindingsPath(sparkHome?: string): string {
  return resolveSparkUserPaths({ sparkHome }).keybindingsFile;
}

function formatPromptTemplateDiagnostic(
  diagnostic: SparkPromptTemplateResolveResult["diagnostics"][number],
): string {
  return diagnostic.path
    ? `Prompt template ${diagnostic.path}: ${diagnostic.message}`
    : `Prompt template: ${diagnostic.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
