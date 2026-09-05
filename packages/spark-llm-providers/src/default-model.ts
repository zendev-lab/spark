import type { SparkActiveSelection, SparkProviderRegistry } from "./provider-registry.ts";

export const DEFAULT_SPARK_MODEL_ID = "openai-codex/gpt-6-astra";

export function resolveSparkDefaultModelSelection(
  registry: SparkProviderRegistry,
): SparkActiveSelection | undefined {
  const [providerName, modelId] = DEFAULT_SPARK_MODEL_ID.split("/") as [string, string];
  if (registry.listModelsFor(providerName).some((model) => model.id === modelId))
    return { providerName, modelId };
  const provider = registry.listProviders()[0];
  const model = provider?.models[0];
  return provider && model ? { providerName: provider.name, modelId: model.id } : undefined;
}
