import type { ModelPickerGroup } from "$lib/components/model-selector";
import { brandIconForModelProvider } from "@zendev-lab/spark-ui";
import type { SparkModelCatalogProvider } from "@zendev-lab/spark-protocol";
import { modelValue } from "./presentation";
import type { SessionsWorkbenchCopy } from "./types";

export function buildModelGroups(
  providers: SparkModelCatalogProvider[],
  copy: Pick<SessionsWorkbenchCopy, "providerLoginRequired">,
): ModelPickerGroup[] {
  return providers.map((provider) => {
    const available = provider.models.filter((entry) => entry.available);
    return {
      id: provider.providerName,
      label: provider.label,
      brandIcon: brandIconForModelProvider(provider.providerName),
      description: provider.auth.configured ? undefined : copy.providerLoginRequired,
      options:
        available.length > 0
          ? available.map((entry) => ({
              value: modelValue(entry.model),
              label: entry.model.modelLabel ?? entry.model.modelId,
              description:
                entry.model.modelLabel && entry.model.modelLabel !== entry.model.modelId
                  ? entry.model.modelId
                  : undefined,
              keywords: [entry.model.modelId, provider.providerName],
              reasoning: entry.reasoning,
            }))
          : [
              {
                value: `unavailable:${provider.providerName}`,
                label: `${copy.providerLoginRequired} · ${provider.models.length}`,
                disabled: true,
              },
            ],
    };
  });
}
