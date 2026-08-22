import {
  LlmAdapter,
  ReasoningEffortId,
  attributionHeaders,
  type GenerateOptions,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { Model } from "@earendil-works/pi-ai";

import {
  generateOptionsToPiContext,
  generateOptionsToPiModel,
  generateOptionsToPiStreamOptions,
  piEventsToLlmChunks,
  readSparkPiGenerateCarrier,
} from "./pi-ai-stream.ts";
import type { SparkProviderRegistry } from "./provider-registry.ts";
import {
  createProviderRegistryStreamFunction,
  type ProviderRegistryRunnerOptions,
} from "./provider-runner.ts";

/** Session thinking levels Spark may send as dsh-llm `reasoningEffort`. */
const SPARK_LLM_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId("minimal"), name: "Minimal" },
  { id: ReasoningEffortId("low"), name: "Low" },
  { id: ReasoningEffortId("medium"), name: "Medium" },
  { id: ReasoningEffortId("high"), name: "High" },
  { id: ReasoningEffortId("xhigh"), name: "Extra high" },
];

export class SparkProviderLlmAdapter extends LlmAdapter {
  readonly #registry: SparkProviderRegistry;
  readonly #providerName: string;
  readonly #runnerOptions: ProviderRegistryRunnerOptions;

  constructor(
    registry: SparkProviderRegistry,
    providerName: string,
    runnerOptions: ProviderRegistryRunnerOptions = {},
  ) {
    super();
    this.#registry = registry;
    this.#providerName = providerName;
    this.#runnerOptions = runnerOptions;
  }

  override providerInfo(provider: string) {
    const config = this.#registry.getProvider(this.#providerName);
    return { id: provider, name: config?.label ?? config?.name ?? provider };
  }

  override async listModels(provider: string) {
    return this.#registry.listModelsFor(this.#providerName).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.input,
    }));
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const definition = this.#registry
      .listModelsFor(this.#providerName)
      .find((entry) => entry.id === model || entry.aliases?.includes(model));
    return {
      provider,
      id: model,
      name: definition?.name ?? model,
      ...(definition
        ? {
            inputModalities: [...definition.input],
            context: { contextWindow: definition.contextWindow },
            defaultMaxTokens: definition.maxTokens,
            ...(definition.reasoning
              ? {
                  reasoning: {
                    efforts: SPARK_LLM_REASONING_EFFORTS,
                  },
                }
              : {}),
          }
        : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void attributionHeaders();
    const carrier = readSparkPiGenerateCarrier(options);
    const model = carrier?.model ?? generateOptionsToPiModel(options);
    const context = carrier?.context ?? generateOptionsToPiContext(options);
    const streamOptions = carrier?.options ?? generateOptionsToPiStreamOptions(options);
    this.#registry.setActive({
      providerName: options.provider,
      modelId: options.model,
    });
    const stream = createProviderRegistryStreamFunction(this.#registry, this.#runnerOptions)(
      model as Model<string>,
      context,
      streamOptions,
    );
    yield* piEventsToLlmChunks(stream);
  }
}

export function adaptersFromProviderRegistry(
  registry: SparkProviderRegistry,
  runnerOptions: ProviderRegistryRunnerOptions = {},
): Array<{ providers: string[]; adapter: SparkProviderLlmAdapter }> {
  return registry.listProviders().map((config) => ({
    providers: [config.name],
    adapter: new SparkProviderLlmAdapter(registry, config.name, runnerOptions),
  }));
}

export function createBaiduOneApiLlmAdapter(
  registry: SparkProviderRegistry,
  runnerOptions?: ProviderRegistryRunnerOptions,
): SparkProviderLlmAdapter {
  return new SparkProviderLlmAdapter(registry, "baidu-oneapi", runnerOptions);
}

export function createOpenAiCodexLlmAdapter(
  registry: SparkProviderRegistry,
  runnerOptions?: ProviderRegistryRunnerOptions,
): SparkProviderLlmAdapter {
  return new SparkProviderLlmAdapter(registry, "openai-codex", runnerOptions);
}
