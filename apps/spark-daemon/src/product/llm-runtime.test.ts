import assert from "node:assert/strict";
import { test } from "vitest";
import { Context } from "@deepseek-ai/cordis";

import {
  LlmAdapter,
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
  type PreparedAdapterCall,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import { createSparkLlmComposition } from "./llm-runtime.ts";

class ScriptedAdapter extends LlmAdapter {
  readonly chunks: StreamChunk[];

  constructor(chunks: StreamChunk[]) {
    super();
    this.chunks = chunks;
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* this.chunks;
  }
}

class PreparedGenerationAdapter extends LlmAdapter {
  preparedProvider: string | undefined;
  preparedModel: string | undefined;
  preparedSignal: AbortSignal | undefined;
  dispatchedProvider: string | undefined;
  fallbackStreamCalls = 0;

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    this.preparedProvider = provider;
    this.preparedModel = model;
    this.preparedSignal = signal;
    return {
      model: { provider, id: model, name: "Prepared model", inputModalities: ["text"] },
      stream: (options) => {
        this.dispatchedProvider = options.provider;
        return scriptedChunks([
          { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
          { type: "finish", reason: { kind: "stop" } },
        ]);
      },
    };
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.fallbackStreamCalls += 1;
    throw new Error("the invocation route discarded the prepared adapter generation");
  }
}

async function* scriptedChunks(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks;
}

test("createSparkLlmComposition reuses the supplied LlmRuntime without exposing Context", async () => {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  const composition = await createSparkLlmComposition({ ctx, routeNamespace: "inv-empty" });
  try {
    assert.equal("ctx" in composition, false);
    assert.equal(typeof composition.llm.stream, "function");
    assert.deepEqual(ctx.llm.listProviders(), []);
  } finally {
    await composition.dispose();
    await ctx.fiber.dispose();
  }
});

test("createSparkLlmComposition registers adapters and unloads them on dispose", async () => {
  const adapter = new ScriptedAdapter([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  const composition = await createSparkLlmComposition({
    ctx,
    routeNamespace: "inv-scripted",
    adapters: [{ providers: ["scripted"], adapter }],
  });
  try {
    assert.deepEqual(
      ctx.llm.listProviders().map((provider) => provider.id),
      ["spark-invocation/inv-scripted/scripted"],
    );
    const chunks: StreamChunk["type"][] = [];
    for await (const chunk of composition.llm.stream({
      provider: "scripted",
      model: "scripted-model",
      messages: [
        createUserMessage({
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        }),
      ],
    })) {
      chunks.push(chunk.type);
    }
    assert.deepEqual(chunks, ["usage", "finish"]);
  } finally {
    await composition.dispose();
  }
  assert.deepEqual(ctx.llm.listProviders(), []);
  await ctx.fiber.dispose();
});

test("createSparkLlmComposition preserves the delegate's prepared adapter generation", async () => {
  const adapter = new PreparedGenerationAdapter();
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  const composition = await createSparkLlmComposition({
    ctx,
    routeNamespace: "inv-prepared",
    adapters: [{ providers: ["scripted"], adapter }],
  });
  const route = "spark-invocation/inv-prepared/scripted";
  const controller = new AbortController();
  try {
    const prepared = await ctx.llm.prepareCall(
      { provider: route, model: "scripted-model" },
      controller.signal,
    );
    assert.deepEqual(prepared.inputModalities, ["text"]);

    const chunks: StreamChunk["type"][] = [];
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        }),
      ],
    })) {
      chunks.push(chunk.type);
    }

    assert.deepEqual(chunks, ["usage", "finish"]);
    assert.equal(adapter.preparedProvider, "scripted");
    assert.equal(adapter.preparedModel, "scripted-model");
    assert.equal(adapter.preparedSignal, controller.signal);
    assert.equal(adapter.dispatchedProvider, "scripted");
    assert.equal(adapter.fallbackStreamCalls, 0);
  } finally {
    await composition.dispose();
    await ctx.fiber.dispose();
  }
});
