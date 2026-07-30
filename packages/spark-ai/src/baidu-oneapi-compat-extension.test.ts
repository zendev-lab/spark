import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

import registerBaiduOneApiCompatibilityExtension from "./baidu-oneapi-compat-extension.ts";
import registerBaiduOneApiProvider from "./baidu-oneapi-provider.ts";
import { type BaiduOneApiStream, createBaiduOneApiProviderAdapter } from "./baidu-oneapi.ts";
import { SparkProviderRegistry } from "./provider-registry.ts";

const BAIDU_MODEL_IDS = [
  "claude-opus-4.6",
  "claude-opus-5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
];

function testModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    baseUrl: "https://oneapi-comate.baidu-int.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
}

function terminalMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function terminalStream(
  model: Model<Api>,
  beforeDone?: () => void | Promise<void>,
): ReturnType<ProviderStreams["stream"]> {
  const message = terminalMessage(model);
  return {
    async *[Symbol.asyncIterator]() {
      await beforeDone?.();
      const event: AssistantMessageEvent = { type: "done", reason: "stop", message };
      yield event;
    },
    async result() {
      return message;
    },
  } as unknown as ReturnType<ProviderStreams["stream"]>;
}

async function consume(stream: BaiduOneApiStream): Promise<void> {
  for await (const _event of stream) void _event;
  await stream.result();
}

test("Pi compatibility and Spark-native adapters expose the same Baidu model catalog", () => {
  const piRegistry = new SparkProviderRegistry();
  const nativeRegistry = new SparkProviderRegistry();

  registerBaiduOneApiCompatibilityExtension(piRegistry);
  registerBaiduOneApiProvider(nativeRegistry);

  const piProvider = piRegistry.getProvider("baidu-oneapi");
  const nativeProvider = nativeRegistry.getProvider("baidu-oneapi");
  expect(piProvider).toBeDefined();
  expect(nativeProvider).toBeDefined();
  expect(piProvider?.models).toEqual(nativeProvider?.models);
  expect(nativeProvider?.models.map((model) => model.id)).toEqual(BAIDU_MODEL_IDS);
  expect(piProvider?.baseUrl).toBe(nativeProvider?.baseUrl);
  expect(piProvider?.api).toBe("baidu-oneapi");
});

test("Baidu Responses uses one top-level instructions value and leaves caller overrides intact", async () => {
  const contexts: Context[] = [];
  const payloads: unknown[] = [];
  const openAIResponses: ProviderStreams = {
    stream: (model) => terminalStream(model),
    streamSimple: (model, context, options) =>
      terminalStream(model, async () => {
        contexts.push(context);
        payloads.push(
          await options?.onPayload?.(
            { model: model.id, input: [{ role: "user", content: "hello" }] },
            model,
          ),
        );
      }),
  };
  const anthropicMessages: ProviderStreams = {
    stream: (model) => terminalStream(model),
    streamSimple: (model) => terminalStream(model),
  };
  const adapter = createBaiduOneApiProviderAdapter({ anthropicMessages, openAIResponses });
  const model = testModel("gpt-5.6-sol");
  const systemPrompt = "SPARK_SYSTEM_PROMPT_SENTINEL";

  await consume(
    adapter.streamOpenAIResponses(model, {
      systemPrompt,
      messages: [],
      tools: [],
    }),
  );
  await consume(adapter.streamOpenAIResponses(model, { messages: [], tools: [] }));
  await consume(
    adapter.streamOpenAIResponses(
      model,
      { systemPrompt, messages: [], tools: [] },
      {
        onPayload(payload) {
          return { ...(payload as Record<string, unknown>), instructions: "CALLER_OVERRIDE" };
        },
      },
    ),
  );

  expect(contexts).toHaveLength(3);
  expect(contexts.every((context) => context.systemPrompt === undefined)).toBe(true);
  expect(payloads[0]).toMatchObject({ instructions: systemPrompt, model: "gpt-5.6-sol" });
  expect(JSON.stringify(payloads[0]).split(systemPrompt)).toHaveLength(2);
  expect(JSON.stringify((payloads[0] as { input: unknown }).input)).not.toContain(systemPrompt);
  expect(payloads[1]).toMatchObject({ instructions: "You are a helpful assistant." });
  expect(payloads[2]).toMatchObject({ instructions: "CALLER_OVERRIDE" });
});

test("Baidu Anthropic keeps the caller system block while remapping the gateway model", async () => {
  let capturedContext: Context | undefined;
  let capturedPayload: unknown;
  const anthropicMessages: ProviderStreams = {
    stream: (model, context, options) =>
      terminalStream(model, async () => {
        capturedContext = context;
        capturedPayload = await options?.onPayload?.(
          {
            model: model.id,
            system: [{ type: "text", text: context.systemPrompt }],
            messages: [],
          },
          model,
        );
      }),
    streamSimple: (model) => terminalStream(model),
  };
  const openAIResponses: ProviderStreams = {
    stream: (model) => terminalStream(model),
    streamSimple: (model) => terminalStream(model),
  };
  const adapter = createBaiduOneApiProviderAdapter({ anthropicMessages, openAIResponses });
  const model = testModel("claude-opus-5");
  const systemPrompt = "CLAUDE_SYSTEM_PROMPT_SENTINEL";

  await consume(
    adapter.streamAnthropic(model, {
      systemPrompt,
      messages: [],
      tools: [],
    }),
  );

  expect(capturedContext?.systemPrompt).toBe(systemPrompt);
  expect(capturedPayload).toMatchObject({
    model: "Opus 5",
    system: [{ type: "text", text: systemPrompt }],
  });
});
