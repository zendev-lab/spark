import assert from "node:assert/strict";
import { test } from "vitest";

import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import {
  TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
  retryProviderStreamBeforeOutput,
} from "./provider-stream-retry.ts";

type ProviderStream = Parameters<typeof retryProviderStreamBeforeOutput>[0];

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function stream(
  events: AssistantMessageEvent[],
  result?: Promise<AssistantMessage>,
): ProviderStream {
  const finalResult = result ?? new Promise<AssistantMessage>(() => undefined);
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => await finalResult,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("terminal-less provider stream promotes a complete tool call to autonomous continuation", async () => {
  let providerCalls = 0;
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "call-1",
    name: "write_once",
    arguments: { value: "x" },
  };
  const wrapped = retryProviderStreamBeforeOutput(
    stream([
      { type: "start", partial: assistant([]) },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall,
        partial: assistant([toolCall], "toolUse"),
      },
    ]),
    () => {
      providerCalls += 1;
      return stream([]);
    },
    { providerName: "fake", maxRetries: 2, shouldRetry: () => true },
  );
  const events: AssistantMessageEvent[] = [];
  for await (const event of wrapped) events.push(event);
  const done = events.at(-1);
  assert.ok(done?.type === "done");
  assert.equal(done.message.stopReason, "toolUse");
  assert.deepEqual(done.message.content, [toolCall]);
  assert.equal(providerCalls, 0);
});

test("terminal-less provider stream without a complete tool call remains a classified transient failure", async () => {
  const wrapped = retryProviderStreamBeforeOutput(
    stream([{ type: "start", partial: assistant([]) }]),
    () => stream([]),
    { providerName: "fake", maxRetries: 0, shouldRetry: () => false },
  );
  await assert.rejects(
    async () => {
      for await (const _event of wrapped) {
        /* consume */
      }
    },
    (error: unknown) => isRecord(error) && error.code === TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
  );
});
