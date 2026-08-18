import assert from "node:assert/strict";
import { test } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";

import plugin, { BAIDU_ONEAPI_PROVIDER } from "./dsh-plugin.ts";

const CATALOG_IDS = [
  "claude-opus-4.6",
  "claude-opus-5",
  "deepseek-v4-flash",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "grok-4.5",
  "grok-4.6",
];

async function mount(config: Parameters<typeof plugin.apply>[1]) {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(plugin, config);
  return ctx;
}

test("dsh-plugin default export carries the Cordis plugin identity", () => {
  assert.equal(plugin.name, "spark-llm");
  assert.deepEqual(plugin.inject, ["llm"]);
  assert.equal(typeof plugin.apply, "function");
});

test("dsh-plugin registers the baidu-oneapi route with the full catalog", async () => {
  const ctx = await mount({ providers: {} });
  const providers = ctx.llm.listProviders();
  assert.deepEqual(
    providers.map((entry) => entry.id),
    [BAIDU_ONEAPI_PROVIDER],
  );
  assert.equal(providers[0]?.name, "Baidu OneAPI");

  const models = await ctx.llm.listModels(BAIDU_ONEAPI_PROVIDER);
  assert.deepEqual(
    models.map((model) => model.id),
    CATALOG_IDS,
  );

  const deepseek = await ctx.llm.resolveModelInfo(BAIDU_ONEAPI_PROVIDER, "deepseek-v4-flash");
  assert.equal(deepseek.context?.contextWindow, 768_000);
  assert.equal(deepseek.defaultMaxTokens, 32_768);
  assert.ok(deepseek.reasoning, "deepseek-v4-flash advertises reasoning");

  const grok = await ctx.llm.resolveModelInfo(BAIDU_ONEAPI_PROVIDER, "grok-4.6");
  assert.equal(grok.context?.contextWindow, 500_000);
});

test("dsh-plugin honors the configured display name in the settings directory", async () => {
  const ctx = await mount({
    providers: { [BAIDU_ONEAPI_PROVIDER]: { displayName: "My Gateway" } },
  });
  // The provider route itself keeps the product name from the registry; the
  // configured display name is the settings-directory label.
  assert.equal(ctx.llm.listProviders()[0]?.name, "Baidu OneAPI");

  const directory = ctx.llm.listConfigurableProviders();
  const entry = directory.find((item) => item.provider === BAIDU_ONEAPI_PROVIDER);
  assert.ok(entry, "directory declares the baidu-oneapi route");
  assert.equal(entry.displayName, "My Gateway");
  assert.equal(entry.settingsNs, "spark-llm");
  assert.deepEqual(entry.settingsPath, ["providers", BAIDU_ONEAPI_PROVIDER]);
  assert.equal(entry.declared, false, "the route ships with the plugin, not from configuration");
});
