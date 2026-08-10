import assert from "node:assert/strict";
import { test } from "vitest";

import {
  TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
  retryProviderStreamBeforeOutput,
} from "./provider-stream-retry.ts";

function assistant(content: unknown[], stopReason: string = "stop"): any {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fake",
    model: "fake",
    stopReason,
    timestamp: Date.now(),
  };
}

function stream(events: any[], result?: Promise<any>): any {
  const finalResult = result ?? new Promise<any>(() => undefined);
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => await finalResult,
  };
}

test("terminal-less provider stream promotes a complete tool call to autonomous continuation", async () => {
  let providerCalls = 0;
  const toolCall = {
    type: "toolCall",
    id: "call-1",
    name: "write_once",
    arguments: { value: "x" },
  };
  const wrapped = retryProviderStreamBeforeOutput(
    stream([
      { type: "start", partial: assistant([]) },
      { type: "toolcall_end", toolCall, partial: assistant([toolCall], "toolUse") },
    ]),
    () => {
      providerCalls += 1;
      return stream([]);
    },
    { providerName: "fake", maxRetries: 2, shouldRetry: () => true },
  );
  const events: any[] = [];
  for await (const event of wrapped) events.push(event);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  assert.equal(done?.message.stopReason, "toolUse");
  assert.deepEqual(done?.message.content, [toolCall]);
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
    (error: any) => error?.code === TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
  );
});
