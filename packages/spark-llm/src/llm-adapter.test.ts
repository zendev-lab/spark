import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkProviderRegistry, SparkProviderLlmAdapter } from "./index.ts";
import type { ProviderConfig } from "./provider-registry.ts";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { sparkContextToGenerateOptions } from "./pi-ai-stream.ts";

function fakeAssistant(stopReason: "stop" | "error" | "aborted", text = "ok") {
  return {
    role: "assistant" as const,
    content: text ? [{ type: "text" as const, text }] : [],
    api: "openai-completions" as const,
    provider: "fake",
    model: "model-a",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" || stopReason === "aborted"
      ? { errorMessage: "provider failed" }
      : {}),
    timestamp: Date.now(),
  };
}

function provider(streamSimple: ProviderConfig["streamSimple"]): ProviderConfig {
  return {
    name: "fake",
    baseUrl: "https://fake.test",
    apiKey: "FAKE_KEY",
    api: "openai-completions",
    streamSimple,
    models: [
      {
        id: "model-a",
        name: "Model A",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  };
}

async function collect(adapter: SparkProviderLlmAdapter, modelId = "model-a") {
  const chunks: StreamChunk[] = [];
  const options = sparkContextToGenerateOptions(
    {
      id: modelId,
      name: "Model A",
      api: "openai-completions",
      provider: "fake",
      baseUrl: "https://fake.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    },
    {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    },
  );
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

test("SparkProviderLlmAdapter emits usage before a successful finish", async () => {
  const registry = new SparkProviderRegistry();
  const message = fakeAssistant("stop");
  registry.registerProvider(
    "fake",
    provider(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
      result: async () => message,
    })),
  );
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const chunks = await collect(new SparkProviderLlmAdapter(registry, "fake"));
  const types = chunks.map((chunk) => chunk.type);
  assert.ok(types.includes("usage"));
  assert.equal(types.at(-1), "finish");
  assert.ok(types.indexOf("usage") < types.lastIndexOf("finish"));
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.equal(finish?.type === "finish" ? finish.reason.kind : undefined, "stop");
});

test("SparkProviderLlmAdapter turns provider failure into a terminal finish", async () => {
  const registry = new SparkProviderRegistry();
  const message = fakeAssistant("error", "");
  registry.registerProvider(
    "fake",
    provider(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "error", error: message };
      },
      result: async () => message,
    })),
  );
  registry.setActive({ providerName: "fake", modelId: "model-a" });
  const chunks = await collect(new SparkProviderLlmAdapter(registry, "fake"));
  assert.equal(chunks.at(-1)?.type, "finish");
  const finish = chunks.at(-1);
  assert.equal(finish && finish.type === "finish" ? finish.reason.kind : undefined, "error");
});

test("SparkProviderLlmAdapter can stream a GenerateOptions request without a pi carrier", async () => {
  const registry = new SparkProviderRegistry();
  const message = fakeAssistant("stop");
  registry.registerProvider(
    "fake",
    provider(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
      result: async () => message,
    })),
  );
  const adapter = new SparkProviderLlmAdapter(registry, "fake");
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream({
    provider: "fake",
    model: "model-a",
    messages: [
      createUserMessage({
        content: [{ type: "text", text: "hi" }],
        source: { kind: "user" },
      }),
    ],
  })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.at(-1)?.type, "finish");
});

test("SparkProviderLlmAdapter advertises reasoning efforts only when the model supports them", async () => {
  const registry = new SparkProviderRegistry();
  const message = fakeAssistant("stop");
  registry.registerProvider(
    "fake",
    provider(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
      result: async () => message,
    })),
  );
  const adapter = new SparkProviderLlmAdapter(registry, "fake");
  const withoutReasoning = await adapter.resolveModel("fake", "model-a");
  assert.equal("reasoning" in withoutReasoning, false);

  registry.registerProvider("thinker", {
    ...provider(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
      result: async () => message,
    })),
    name: "thinker",
    models: [
      {
        id: "model-b",
        name: "Model B",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024,
      },
    ],
  });
  const thinking = await new SparkProviderLlmAdapter(registry, "thinker").resolveModel(
    "thinker",
    "model-b",
  );
  assert.deepEqual(
    thinking.reasoning?.efforts.map((effort) => effort.id),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
});
