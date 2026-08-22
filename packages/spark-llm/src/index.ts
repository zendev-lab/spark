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
export { TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE } from "./provider-stream-retry.ts";
export {
  type SparkProviderAttemptObservation,
  type SparkProviderAttemptObserver,
} from "./provider-attempt.ts";

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
  type SparkWorkflowModelRunnerOptions,
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
export {
  KIMI_CODING_API_KEY_ENV,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_PROVIDER_ID,
  default as registerKimiCodingProvider,
} from "./kimi-coding-provider.ts";
export { piAiProviderConfig, registerSparkAiProvider } from "./spark-provider-adapter.ts";
export type { SparkProviderAdapterOptions } from "./spark-provider-adapter.ts";
export {
  runSparkLeaf,
  resolveLeafModelId,
  type SparkLeafRequest,
  type SparkLeafResult,
  type SparkLeafDegradeReason,
  type SparkLeafModelBinding,
  type SparkLeafBindingResolver,
  type SparkLeafRunnerDeps,
  type SparkLeafProviderAttemptObservation,
  type SparkLeafProviderAttemptObserver,
} from "./leaf-runner.ts";
export {
  createProviderRegistryLeafRunner,
  type SparkLeafHostRunnerOptions,
} from "./leaf-host-runner.ts";
export {
  SparkProviderLlmAdapter,
  adaptersFromProviderRegistry,
  createBaiduOneApiLlmAdapter,
  createOpenAiCodexLlmAdapter,
} from "./llm-adapter.ts";
