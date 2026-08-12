import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkProviderRegistry } from "../provider-registry.ts";
import { resolveSparkScopedModelIds } from "./provider-catalog.ts";

const fakeProvider = {
  name: "fake-provider",
  baseUrl: "https://fake.test",
  api: "openai-completions" as const,
  streamSimple: () => ({}),
  models: [
    {
      id: "gpt-5.3-compat",
      name: "Compatibility model",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    },
    {
      id: "gpt-5.6-frontier",
      name: "Frontier model",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 100,
    },
  ],
};

test("scope resolution can retain compatibility catalog entries without enabling them", () => {
  const registry = new SparkProviderRegistry();
  registry.registerProvider("fake-provider", fakeProvider);

  assert.deepEqual(resolveSparkScopedModelIds(registry, ["fake-provider/gpt-5.6-*"]), [
    "fake-provider/gpt-5.6-frontier",
  ]);
  assert.deepEqual(resolveSparkScopedModelIds(registry, ["fake-provider/*"]), [
    "fake-provider/gpt-5.3-compat",
    "fake-provider/gpt-5.6-frontier",
  ]);
});
