import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkProviderRegistry } from "../provider-registry.ts";
import {
  DEFAULT_SPARK_ENABLED_MODEL_PATTERNS,
  normalizeSparkEnabledModelPatterns,
  resolveSparkEnabledModelIds,
} from "./provider-catalog.ts";

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

  assert.deepEqual(resolveSparkEnabledModelIds(registry, ["fake-provider/gpt-5.6-*"]), [
    "fake-provider/gpt-5.6-frontier",
  ]);
  assert.deepEqual(resolveSparkEnabledModelIds(registry, ["fake-provider/*"]), [
    "fake-provider/gpt-5.3-compat",
    "fake-provider/gpt-5.6-frontier",
  ]);
});

test("bundled enabledModels migrate onto grok-4.6 and keep custom scopes", () => {
  assert.deepEqual(
    normalizeSparkEnabledModelPatterns([
      "openai-codex/gpt-5.6-*",
      "baidu-oneapi/claude-opus-5",
      "baidu-oneapi/deepseek-v4-flash",
      "baidu-oneapi/gpt-5.6-*",
      "baidu-oneapi/grok-4.5",
    ]),
    [...DEFAULT_SPARK_ENABLED_MODEL_PATTERNS],
  );
  assert.deepEqual(normalizeSparkEnabledModelPatterns(["baidu-oneapi/*"]), ["baidu-oneapi/*"]);
  const defaults: readonly string[] = DEFAULT_SPARK_ENABLED_MODEL_PATTERNS;
  assert.equal(defaults.includes("baidu-oneapi/grok-4.6"), true);
  assert.equal(defaults.includes("baidu-oneapi/grok-4.5"), false);
  assert.equal(defaults.includes("kimi-coding/*"), true);
});

test("previous grok-4.6 default set migrates onto Kimi Coding", () => {
  assert.deepEqual(
    normalizeSparkEnabledModelPatterns([
      "openai-codex/gpt-5.6-*",
      "baidu-oneapi/claude-opus-5",
      "baidu-oneapi/deepseek-v4-flash",
      "baidu-oneapi/gpt-5.6-*",
      "baidu-oneapi/grok-4.6",
    ]),
    [...DEFAULT_SPARK_ENABLED_MODEL_PATTERNS],
  );
});
