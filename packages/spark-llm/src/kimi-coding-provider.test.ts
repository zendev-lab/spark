import assert from "node:assert/strict";
import { test } from "vitest";

import { loadSparkProviderCatalog } from "./control/provider-catalog.ts";
import registerKimiCodingProvider, {
  KIMI_CODING_API_KEY_ENV,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_PROVIDER_ID,
} from "./kimi-coding-provider.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";

test("registers pi-ai Kimi Coding as an API-key provider", () => {
  const registry = new SparkProviderRegistry();
  registerKimiCodingProvider(registry);

  const provider = registry.getProvider(KIMI_CODING_PROVIDER_ID);
  assert.ok(provider);
  assert.equal(provider.name, KIMI_CODING_PROVIDER_ID);
  assert.equal(provider.label, "Kimi For Coding");
  assert.equal(provider.apiKey, KIMI_CODING_API_KEY_ENV);
  assert.equal(provider.baseUrl, KIMI_CODING_BASE_URL);
  const modelIds = provider.models.map((model) => model.id);
  assert.equal(modelIds.length, 4);
  assert.equal(new Set(modelIds).size, modelIds.length, "provider model ids must be unique");
});

test("bundled catalog importer loads kimi-coding without a dynamic package import", async () => {
  const { registry, outcomes } = await loadSparkProviderCatalog();
  assert.equal(registry.hasProvider(KIMI_CODING_PROVIDER_ID), true);
  assert.equal(registry.listModelsFor(KIMI_CODING_PROVIDER_ID).length, 4);
  assert.equal(
    outcomes.find((outcome) => outcome.specifier === "@zendev-lab/spark-llm/kimi-coding-provider")
      ?.ok,
    true,
  );
});
