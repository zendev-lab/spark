import assert from "node:assert/strict";
import { test } from "vitest";
import { Context } from "@deepseek-ai/cordis";

import {
  LlmAdapter,
  LlmRuntime,
  createUserMessage,
  type GenerateOptions,
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
