import assert from "node:assert/strict";
import { test } from "vitest";

import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

import { llmChunksToPiAiStream, piEventsToLlmChunks } from "./dsh-pi-bridge.ts";

const MODEL: Model<string> = {
  id: "model-a",
  name: "Model A",
  api: "openai-completions",
  provider: "fake",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "fake",
    model: "model-a",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function piStream(events: AssistantMessageEvent[], result?: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () =>
      result ?? (events.find((event) => event.type === "done")?.message as AssistantMessage),
  };
}

async function roundTrip(events: AssistantMessageEvent[]) {
  const types: string[] = [];
  const stream = llmChunksToPiAiStream(piEventsToLlmChunks(piStream(events)), MODEL);
  for await (const event of stream) types.push(event.type);
  return types;
}

test("pi-ai start, deltas, and toolcall_end survive a StreamChunk round-trip", async () => {
  const partial = assistant("hello");
  const toolCall = {
    type: "toolCall" as const,
    id: "tc-1",
    name: "echo",
    arguments: { x: 1 },
  };
  const types = await roundTrip([
    { type: "start", partial },
    { type: "text_delta", contentIndex: 0, delta: "hello", partial },
    {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall,
      partial: {
        ...partial,
        content: [...partial.content, toolCall],
        stopReason: "toolUse",
      },
    },
    {
      type: "done",
      reason: "toolUse",
      message: {
        ...partial,
        content: [...partial.content, toolCall],
        stopReason: "toolUse",
      },
    },
  ]);
  assert.deepEqual(types, ["start", "text_delta", "toolcall_end", "done"]);
});

test("an empty pi-ai iterator does not throw while converting to chunks", async () => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of piEventsToLlmChunks(
    piStream([], undefined as unknown as AssistantMessage),
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, []);
});
