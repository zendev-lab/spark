import assert from "node:assert/strict";
import { test } from "vitest";

import {
  LlmAdapter,
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

test("createSparkLlmComposition mounts LlmRuntime without exposing Context", async () => {
  const composition = await createSparkLlmComposition();
  try {
    assert.equal("ctx" in composition, false);
    assert.equal(typeof composition.llm.stream, "function");
    assert.equal(typeof composition.registerAdapter, "function");
    assert.deepEqual(composition.llm.listProviders(), []);
  } finally {
    await composition.dispose();
  }
});

test("createSparkLlmComposition registers adapters and unloads them on dispose", async () => {
  const adapter = new ScriptedAdapter([
    { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const composition = await createSparkLlmComposition({
    adapters: [{ providers: ["scripted"], adapter }],
  });
  try {
    assert.deepEqual(
      composition.llm.listProviders().map((provider) => provider.id),
      ["scripted"],
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

  const afterDispose = await createSparkLlmComposition();
  try {
    assert.deepEqual(afterDispose.llm.listProviders(), []);
  } finally {
    await afterDispose.dispose();
  }
});
