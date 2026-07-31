import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ModelThinkingLevel,
  ProviderId,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
export type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";

export * from "./model-routing.ts";
export * from "./provider-failure.ts";

export {
  SparkProviderRegistry,
  type ProviderConfig,
  type ProviderModelDefinition,
  type ProviderRegistrationAPI,
  type SparkActiveSelection,
} from "./provider-registry.ts";
export {
  assistantMessageToText,
  createProviderRegistryStreamFunction,
  createProviderRegistryWorkflowModelRunner,
  normalizeProviderStream,
  openAiCompatiblePromptCachePayload,
  resolveWorkflowModelSelection,
  SPARK_PROVIDER_TRANSPORT_MAX_RETRIES,
  withOpenAiCompatiblePromptCacheKey,
  type ProviderRegistryRunnerOptions,
  type SparkProviderStreamFunction,
  type SparkWorkflowModelRunRequest,
  type SparkWorkflowModelRunResponse,
} from "./provider-runner.ts";
export {
  default as sparkModelsExtension,
  registerSparkModelsTool,
  type SparkModelsExtensionApi,
} from "./models-extension.ts";
export {
  default as registerBaiduOneApiProvider,
  remapBaiduOneApiPayload,
  resolveBaiduOneApiKey,
  streamBaiduOneApi,
  streamBaiduOneApiAnthropic,
  streamBaiduOneApiOpenAIResponses,
} from "./baidu-oneapi-provider.ts";
export {
  OPENAI_CODEX_API,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER_ID,
  default as registerOpenAICodexProvider,
} from "./openai-codex-provider.ts";
export { piAiProviderConfig, registerSparkAiProvider } from "./spark-provider-adapter.ts";
export type { SparkProviderAdapterOptions } from "./spark-provider-adapter.ts";
export {
  CURSOR_API_KEY_ENV,
  CURSOR_PROVIDER_API,
  CURSOR_PROVIDER_BASE_URL,
  CURSOR_PROVIDER_ID,
  default as registerCursorProvider,
  type RegisterCursorProviderOptions,
} from "./cursor-provider.ts";
export {
  buildCursorPrompt,
  createCursorStreamFunction,
  streamCursor,
  type CursorSdkRuntime,
  type CursorStreamDependencies,
} from "./cursor-stream.ts";
export {
  buildCursorModelSelection,
  convertCursorModelItems,
  getCursorModelMetadata,
  getCursorModelMetadataEntries,
  type CursorModelMetadata,
} from "./cursor-model-catalog.ts";
export {
  discoverCursorModels,
  sanitizeCursorDiscoveryError,
  type CursorCatalogFallbackIssue,
  type CursorCatalogFallbackReason,
  type DiscoverCursorModelsOptions,
} from "./cursor-model-discovery.ts";
export {
  DEFAULT_CURSOR_MODEL_CACHE_TTL_MS,
  defaultCursorModelCachePath,
  fingerprintCursorApiKey,
  loadCursorModelCache,
  saveCursorModelCache,
} from "./cursor-model-cache.ts";
export {
  runSparkLeaf,
  resolveLeafModelId,
  type SparkLeafRequest,
  type SparkLeafResult,
  type SparkLeafDegradeReason,
  type SparkLeafModelBinding,
  type SparkLeafBindingResolver,
  type SparkLeafRunnerDeps,
} from "./leaf-runner.ts";
export {
  createProviderRegistryLeafRunner,
  type SparkLeafHostRunnerOptions,
} from "./leaf-host-runner.ts";
