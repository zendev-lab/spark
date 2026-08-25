import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SparkHostRuntime,
  SparkProviderRegistry,
  loadProviderPlugins,
  loadSparkProductAgentPlugins,
  loadSparkProductCapabilities,
  loadSparkProductDshToolSurfaces,
  registerSparkProductCapabilities,
} from "../host/index.ts";

test("Spark product composition has a fixed capability set", () => {
  assert.deepEqual(
    loadSparkProductCapabilities().map((capability) => capability.name),
    [
      "@zendev-lab/spark-ask",
      "@zendev-lab/spark-artifacts",
      "@zendev-lab/spark-files",
      "@zendev-lab/spark-llm-providers",
      "@zendev-lab/spark-memory",
      "@zendev-lab/spark-roles",
      "@zendev-lab/spark-session",
      "spark",
    ],
  );
});

test("Spark product composition registers capabilities and its DSH agent plugins", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-product-composition-test" });

  await registerSparkProductCapabilities(host);

  assert.deepEqual(
    loadSparkProductAgentPlugins().map((plugin) => plugin.name),
    ["dsh-tool-cue", "dsh-tool-fusion", "dsh-tool-web"],
  );
  assert.equal(host.getAllTools().length > 0, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "cue_exec"),
    false,
  );
});

test("Spark product composition rejects a required capability registration failure", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-product-composition-failure-test" });
  host.registerTool = () => {
    throw new Error("required capability registration failed");
  };

  await assert.rejects(
    registerSparkProductCapabilities(host),
    /required capability registration failed/u,
  );
});

test("Spark product DSH tools carry policy metadata", async () => {
  const surfaces = await loadSparkProductDshToolSurfaces();

  assert.deepEqual(
    surfaces.map(({ config }) => config.name),
    [
      "cue_exec",
      "cue_run",
      "cue_script",
      "script_run",
      "script_eval",
      "cue_jobs",
      "cue_resources",
      "cue_schedule",
      "cue_scope",
      "cue_history",
      "fusion",
      "web_search",
      "web_fetch",
      "get_search_content",
    ],
  );
  assert.equal(
    surfaces.every(({ policy }) => policy.reconcile === "none"),
    true,
  );
});

test("loadProviderPlugins invokes provider default factory with the provider registry", async () => {
  const registry = new SparkProviderRegistry();
  const fakeModule = {
    default: function fakeProvider(api: SparkProviderRegistry): void {
      api.registerProvider("fake-provider", {
        name: "fake-provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: () => undefined as unknown,
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 1024,
          },
        ],
      });
    },
  };

  const result = await loadProviderPlugins({
    providerApi: registry,
    providers: ["fake-provider-pkg"],
    importer: async () => fakeModule,
  });

  assert.equal(result.outcomes[0]?.ok, true);
  assert.equal(registry.hasProvider("fake-provider"), true);
});

test("loadProviderPlugins resolves bundled providers without installed workspace packages", async () => {
  const registry = new SparkProviderRegistry();

  const result = await loadProviderPlugins({
    providerApi: registry,
    providers: [
      "@zendev-lab/spark-llm-providers/baidu-oneapi-provider",
      "@zendev-lab/spark-llm-providers/openai-codex-provider",
      "@zendev-lab/spark-llm-providers/kimi-coding-provider",
    ],
  });

  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.ok),
    [true, true, true],
  );
  assert.equal(registry.hasProvider("baidu-oneapi"), true);
  assert.equal(registry.hasProvider("openai-codex"), true);
  assert.equal(registry.hasProvider("kimi-coding"), true);
});

test("loadProviderPlugins isolates failures", async () => {
  const registry = new SparkProviderRegistry();
  const goodProvider = {
    default(api: SparkProviderRegistry): void {
      api.registerProvider("good-provider", {
        name: "good-provider",
        baseUrl: "https://good.test",
        api: "openai-completions",
        streamSimple: () => undefined as unknown,
        models: [fakeModel("good-model")],
      });
    },
  };
  const badProvider = {
    default(): void {
      throw new Error("boom");
    },
  };

  const result = await loadProviderPlugins({
    providerApi: registry,
    providers: ["good-provider", "bad-provider"],
    importer: async (specifier) => (specifier === "good-provider" ? goodProvider : badProvider),
  });

  assert.equal(result.outcomes[0]?.ok, true);
  assert.equal(result.outcomes[1]?.ok, false);
  assert.match(result.outcomes[1]?.error ?? "", /boom/);
  assert.equal(registry.hasProvider("good-provider"), true);
});

test("loadProviderPlugins reports modules without a default factory", async () => {
  const result = await loadProviderPlugins({
    providerApi: new SparkProviderRegistry(),
    providers: ["malformed"],
    importer: async () => ({}),
  });

  assert.equal(result.outcomes[0]?.ok, false);
  assert.match(
    result.outcomes[0]?.error ?? "",
    /must default-export a function\(api: ProviderRegistrationAPI\)/,
  );
});

test("loadProviderPlugins waits for async default factories to settle", async () => {
  const registry = new SparkProviderRegistry();
  const asyncModule = {
    default: async function asyncFactory(api: SparkProviderRegistry): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 5));
      api.registerProvider("async-provider", {
        name: "async-provider",
        baseUrl: "https://async.test",
        api: "openai-completions",
        streamSimple: () => undefined as unknown,
        models: [fakeModel("async-model")],
      });
    },
  };

  const result = await loadProviderPlugins({
    providerApi: registry,
    providers: ["async-provider"],
    importer: async () => asyncModule,
  });

  assert.equal(result.outcomes[0]?.ok, true);
  assert.equal(registry.hasProvider("async-provider"), true);
});

function fakeModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 1024,
  };
}
