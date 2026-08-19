import * as piAi from "@earendil-works/pi-ai";
import type {
  AnthropicEffort,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { classifyProviderFailure } from "./provider-failure.ts";
import {
  isMalformedProviderJsonFailure,
  retryProviderStreamBeforeOutput,
} from "./provider-stream-retry.ts";
import type { ProviderRegistrationAPI } from "./provider-registry.ts";

const BAIDU_ONEAPI_PROVIDER = "baidu-oneapi";
const BAIDU_ONEAPI_API = "baidu-oneapi";
const BAIDU_ONEAPI_BASE_URL = "https://oneapi-comate.baidu-int.com";
const BAIDU_ONEAPI_OPENAI_BASE_URL = `${BAIDU_ONEAPI_BASE_URL}/v1`;
const BAIDU_ONEAPI_STREAM_MAX_RETRIES = 3;
const OPENAI_RESPONSES_FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";
// Catalog anthropic rows always reason (claude-opus-*, deepseek-v4-flash).
// When a caller omits a thinking level, keep thinking enabled with Spark's
// session default ("high") instead of silently producing a text-only stream:
// the Baidu gateway does not honor `thinking: {type:"adaptive"}` without an
// output effort, and the model's chain-of-thought would leak into plain text.
const BAIDU_ONEAPI_DEFAULT_REASONING_LEVEL = "high" as const;

const GATEWAY_MODEL_BY_ID: Record<string, string> = {
  "claude-opus-5": "Opus 5",
  "deepseek-v4-flash": "deepseek-v4-flash-0731-internal",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "grok-4.5": "grok-4.5",
  "grok-4.6": "grok-4.6",
};
const BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "grok-4.5",
  "grok-4.6",
]);
// Note (measured 2026-08-19): grok-* rows keep the Responses route, but the
// gateway currently 404s /v1/responses for them ("Unknown endpoint") — this
// is an upstream limitation reported by the gateway operator, not something
// this adapter can route around. DeepSeek stays on anthropic-messages because
// the Responses translation drops its thinking entirely (see deepseek row).

function gatewayModelId(modelId: string): string {
  return GATEWAY_MODEL_BY_ID[modelId] ?? modelId;
}

type BaiduOneApiTransportApi = "anthropic-messages" | "openai-responses";
export type BaiduOneApiStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface BaiduOneApiTransports {
  anthropicMessages: ProviderStreams;
  openAIResponses: ProviderStreams;
}

export interface BaiduOneApiProviderAdapter {
  register(api: ProviderRegistrationAPI): void;
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): BaiduOneApiStream;
  streamAnthropic(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): BaiduOneApiStream;
  streamOpenAIResponses(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): BaiduOneApiStream;
}

export function createBaiduOneApiProviderAdapter(
  transports: BaiduOneApiTransports,
): BaiduOneApiProviderAdapter {
  const streamAnthropic = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    streamBaiduOneApiAnthropicWith(transports, model, context, options);
  const streamOpenAIResponses = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => streamBaiduOneApiOpenAIResponsesWith(transports, model, context, options);
  const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    BAIDU_ONEAPI_OPENAI_RESPONSES_MODEL_IDS.has(model.id)
      ? streamOpenAIResponses(model, context, options)
      : streamAnthropic(model, context, options);

  return {
    register: (api) => registerBaiduOneApiProvider(api, stream),
    stream,
    streamAnthropic,
    streamOpenAIResponses,
  };
}

const GPT_5_6_LUNA_COST = { input: 0.1, output: 0.6, cacheRead: 0.01, cacheWrite: 0.125 };
const GPT_5_6_TERRA_COST = { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.3125 };
const GPT_5_6_SOL_COST = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 };
// Responses-row thinking map. Measured on the gateway (2026-08-19):
// gpt-5.6-sol/luna/terra accept every effort (minimal..max) syntactically and
// emit real response.reasoning items once the output budget allows. Spark's
// minimal is still forwarded as the lowest real level (low) because the
// gateway produced no reasoning items at minimal in the sampled calls.
const GPT_THINKING_LEVEL_MAP = { minimal: "low", xhigh: "xhigh" };
const CLAUDE_OPUS_COST = {
  input: 5.5,
  output: 27.5,
  cacheRead: 0.55,
  cacheWrite: 6.875,
};
const DEEPSEEK_V4_FLASH_COST = {
  input: 0.14,
  output: 0.28,
  cacheRead: 0.0028,
  cacheWrite: 0.14,
};
const GROK_4_5_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.3,
  cacheWrite: 2,
};
const GROK_4_6_COST = {
  input: 2,
  output: 6,
  cacheRead: 0.5,
  cacheWrite: 2,
};

// The compat factory imports the transport after stream() returns, so the process-wide
// OpenAI log guard must remain active until the lazy stream reaches a terminal result.
let openAiSdkLogGuardDepth = 0;
let openAiSdkPreviousLogLevel: string | undefined;

export function silenceOpenAiSdkTransportLogs(transport: ProviderStreams): ProviderStreams {
  return {
    stream: (model, context, options) =>
      withOpenAiSdkLoggingDisabled(() => transport.stream(model, context, options)),
    streamSimple: (model, context, options) =>
      withOpenAiSdkLoggingDisabled(() => transport.streamSimple(model, context, options)),
  };
}

function withOpenAiSdkLoggingDisabled<T extends BaiduOneApiStream>(start: () => T): T {
  const release = acquireOpenAiSdkLogGuard();
  let stream: T;
  try {
    stream = start();
  } catch (error) {
    release();
    throw error;
  }
  try {
    void stream.result().then(release, release);
  } catch (error) {
    release();
    throw error;
  }
  return stream;
}

function acquireOpenAiSdkLogGuard(): () => void {
  if (openAiSdkLogGuardDepth === 0) {
    openAiSdkPreviousLogLevel = process.env.OPENAI_LOG;
    process.env.OPENAI_LOG = "off";
  }
  openAiSdkLogGuardDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openAiSdkLogGuardDepth -= 1;
    if (openAiSdkLogGuardDepth > 0) return;
    if (process.env.OPENAI_LOG === "off") {
      if (openAiSdkPreviousLogLevel === undefined) {
        Reflect.deleteProperty(process.env, "OPENAI_LOG");
      } else {
        process.env.OPENAI_LOG = openAiSdkPreviousLogLevel;
      }
    }
    openAiSdkPreviousLogLevel = undefined;
  };
}

function mapThinkingEffort(
  model: Model<Api>,
  reasoning: SimpleStreamOptions["reasoning"] | "off" | undefined,
): AnthropicEffort | undefined {
  const mapped = reasoning ? model.thinkingLevelMap?.[reasoning] : undefined;
  if (typeof mapped === "string") return mapped as AnthropicEffort;
  if (mapped === null) return undefined;
  switch (reasoning) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withBaiduOneApiTransportApi<TApi extends BaiduOneApiTransportApi>(
  model: Model<Api>,
  api: TApi,
): Model<TApi> {
  return { ...model, api } as Model<TApi>;
}

const BAIDU_CONTEXT_OVERFLOW_SEMANTIC = "context_length_exceeded";
const BAIDU_CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext (?:window|length) (?:is )?(?:full|exceeded)\b/iu,
  /\bmaximum context (?:window|length)(?: size)?(?: is| has been)? exceeded\b/iu,
  /\bmaximum prompt length (?:is|of) \d+\b/iu,
  /\bprompt (?:is )?too long for (?:the )?context window\b/iu,
  /\bcontext[_ -]length[_ -]exceeded\b/iu,
] as const;

function isBaiduContextOverflowMessage(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
  return BAIDU_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message.errorMessage!));
}

export function normalizeBaiduOneApiMessage(message: AssistantMessage): AssistantMessage {
  const errorMessage =
    isBaiduContextOverflowMessage(message) &&
    !message.errorMessage?.includes(BAIDU_CONTEXT_OVERFLOW_SEMANTIC)
      ? `${BAIDU_CONTEXT_OVERFLOW_SEMANTIC}: ${message.errorMessage}`
      : message.errorMessage;
  return {
    ...message,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    api: BAIDU_ONEAPI_API,
    provider: BAIDU_ONEAPI_PROVIDER,
  };
}

export function isNormalizedBaiduContextOverflow(message: AssistantMessage): boolean {
  return piAi.isContextOverflow(message);
}

function retagBaiduOneApiMessage(message: AssistantMessage): AssistantMessage {
  return normalizeBaiduOneApiMessage(message);
}

export function normalizeBaiduOneApiEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === "done")
    return { ...event, message: normalizeBaiduOneApiMessage(event.message) };
  if (event.type === "error") return { ...event, error: normalizeBaiduOneApiMessage(event.error) };
  return { ...event, partial: normalizeBaiduOneApiMessage(event.partial) };
}

function retagBaiduOneApiEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  return normalizeBaiduOneApiEvent(event);
}

export function normalizeBaiduOneApiStream(stream: BaiduOneApiStream): BaiduOneApiStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) yield retagBaiduOneApiEvent(event);
    },
    async result() {
      return retagBaiduOneApiMessage(await stream.result());
    },
  };
}

function startBaiduOneApiStream(
  model: Model<Api>,
  factory: () => BaiduOneApiStream,
): BaiduOneApiStream {
  try {
    return normalizeBaiduOneApiStream(factory());
  } catch (error) {
    return normalizeBaiduOneApiStream(baiduOneApiErrorStream(model, error));
  }
}

function baiduOneApiErrorStream(model: Model<Api>, error: unknown): BaiduOneApiStream {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: BAIDU_ONEAPI_API,
    provider: BAIDU_ONEAPI_PROVIDER,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  const stream = piAi.createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

export function resolveBaiduOneApiKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined || apiKey === "BAIDU_ONEAPI_API_KEY") {
    return process.env.BAIDU_ONEAPI_API_KEY;
  }
  if (apiKey === "OPENAI_API_KEY") {
    throw new Error("baidu-oneapi does not accept OPENAI_API_KEY; use BAIDU_ONEAPI_API_KEY.");
  }
  return apiKey;
}

export function remapBaiduOneApiPayload(
  payload: unknown,
  gatewayModel: string,
  effort?: AnthropicEffort,
): unknown {
  if (!isRecord(payload)) return payload;

  const remapped: Record<string, unknown> = { ...payload, model: gatewayModel };
  const thinking = remapped.thinking;
  if (isRecord(thinking) && thinking.type === "enabled") {
    remapped.thinking = {
      type: "adaptive",
      display: typeof thinking.display === "string" ? thinking.display : "summarized",
    };
    if (effort) {
      remapped.output_config = {
        ...(isRecord(remapped.output_config) ? remapped.output_config : {}),
        effort,
      };
    }
  }

  return remapped;
}

function streamBaiduOneApiAnthropicWith(
  transports: BaiduOneApiTransports,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const gatewayModel = gatewayModelId(model.id);
  const apiKey = resolveBaiduOneApiKey(options?.apiKey);
  const transportModel = withBaiduOneApiTransportApi(model, "anthropic-messages");
  // Catalog anthropic rows always reason. Keep thinking enabled even when the
  // caller does not send an explicit level, so DeepSeek V4 Flash chain-of-
  // thought is streamed as reasoning blocks instead of plain assistant text.
  // An explicit "off" (used by Spark thinking control) still disables it.
  const requested = options?.reasoning as SimpleStreamOptions["reasoning"] | "off" | undefined;
  const reasoning =
    requested ?? (model.reasoning ? BAIDU_ONEAPI_DEFAULT_REASONING_LEVEL : undefined);
  const effort = mapThinkingEffort(model, reasoning);

  return startBaiduOneApiStream(
    model,
    () =>
      transports.anthropicMessages.stream(transportModel, context, {
        ...options,
        ...(apiKey !== undefined ? { apiKey } : {}),
        thinkingEnabled: reasoning !== undefined && reasoning !== "off",
        ...(effort !== undefined ? { effort } : {}),
        async onPayload(payload: unknown) {
          const remapped = remapBaiduOneApiPayload(payload, gatewayModel, effort);
          return (await options?.onPayload?.(remapped, model)) ?? remapped;
        },
      } as Parameters<ProviderStreams["stream"]>[2]) as BaiduOneApiStream,
  );
}

function streamBaiduOneApiOpenAIResponsesWith(
  transports: BaiduOneApiTransports,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const gatewayModel = gatewayModelId(model.id);
  const apiKey = resolveBaiduOneApiKey(options?.apiKey);
  const transportModel = withBaiduOneApiTransportApi(model, "openai-responses");
  const { systemPrompt, ...transportContext } = context;
  const instructions = systemPrompt || OPENAI_RESPONSES_FALLBACK_INSTRUCTIONS;
  const createStream = () =>
    startBaiduOneApiStream(
      model,
      () =>
        transports.openAIResponses.streamSimple(transportModel, transportContext, {
          ...options,
          ...(apiKey !== undefined ? { apiKey } : {}),
          fetch: repairBaiduOneApiResponsesFetch(options?.fetch),
          async onPayload(payload: unknown) {
            const remapped = remapOpenAIResponsesModel(payload, gatewayModel);
            const instructed = isRecord(remapped) ? { ...remapped, instructions } : remapped;
            return (await options?.onPayload?.(instructed, model)) ?? instructed;
          },
        }) as BaiduOneApiStream,
    );

  return retryProviderStreamBeforeOutput(createStream(), createStream, {
    providerName: BAIDU_ONEAPI_PROVIDER,
    maxRetries: options?.maxRetries ?? BAIDU_ONEAPI_STREAM_MAX_RETRIES,
    ...(options?.maxRetryDelayMs !== undefined ? { maxRetryDelayMs: options.maxRetryDelayMs } : {}),
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    shouldRetry: (message) =>
      isMalformedProviderJsonFailure(message) ||
      classifyProviderFailure(message).failureClass === "transient",
    shouldRetryThrown: (error) => classifyProviderFailure(error).failureClass === "transient",
  });
}

function remapOpenAIResponsesModel(payload: unknown, gatewayModel: string): unknown {
  return isRecord(payload) ? { ...payload, model: gatewayModel } : payload;
}

/**
 * Baidu OneAPI occasionally appends a single colon after an otherwise complete
 * OpenAI Responses SSE JSON value (`data: {...}:`). The OpenAI SDK correctly
 * rejects that wire value. Repair only this observed gateway defect: the
 * suffix must be exactly one colon and removing it must produce a complete
 * `response.*` event object. Every other malformed envelope remains unchanged
 * and is handled by the bounded retry/failure policy.
 */
export function repairBaiduOneApiResponsesFetch(
  upstreamFetch: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await (upstreamFetch ?? globalThis.fetch)(input, init);
    if (!response.body || !isEventStreamResponse(response)) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(response.body.pipeThrough(createBaiduOneApiSseRepairStream()), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function createBaiduOneApiSseRepairStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        controller.enqueue(encoder.encode(`${repairBaiduOneApiSseLine(line)}\n`));
        newline = buffered.indexOf("\n");
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) controller.enqueue(encoder.encode(repairBaiduOneApiSseLine(buffered)));
    },
  });
}

export function repairBaiduOneApiSseLine(line: string): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const content = carriageReturn ? line.slice(0, -1) : line;
  if (!content.startsWith("data:") || !content.endsWith(":")) return line;
  const separator = content.indexOf(":");
  const prefix = content.slice(0, separator + 1);
  const data = content.slice(separator + 1);
  const repairedData = data.slice(0, -1);
  try {
    const parsed = JSON.parse(repairedData.trim()) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.type !== "string" ||
      !parsed.type.startsWith("response.")
    ) {
      return line;
    }
  } catch {
    return line;
  }
  return prefix + repairedData + carriageReturn;
}

function registerBaiduOneApiProvider(
  pi: ProviderRegistrationAPI,
  streamSimple: BaiduOneApiProviderAdapter["stream"],
): void {
  pi.registerProvider(BAIDU_ONEAPI_PROVIDER, {
    name: "Baidu OneAPI",
    baseUrl: process.env.BAIDU_ONEAPI_BASE_URL ?? BAIDU_ONEAPI_BASE_URL,
    apiKey: "BAIDU_ONEAPI_API_KEY",
    api: BAIDU_ONEAPI_API,
    streamSimple,
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        transportApi: "anthropic-messages",
        transportModelId: gatewayModelId("claude-opus-5"),
        reasoning: true,
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        input: ["text", "image"],
        cost: CLAUDE_OPUS_COST,
        // Measured: ok at provider input ~360k; fails near ~400k with context_length_exceeded.
        contextWindow: 384_000,
        maxTokens: 32000,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        transportApi: "anthropic-messages",
        transportModelId: gatewayModelId("deepseek-v4-flash"),
        reasoning: true,
        // Measured low/medium/high/xhigh all accepted by the gateway via the
        // adaptive-thinking dialect; xhigh produces no additional thinking over
        // high for this model, so both collapse onto the gateway's high effort.
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "high",
        },
        input: ["text"],
        cost: DEEPSEEK_V4_FLASH_COST,
        // Measured against oneapi gateway deepseek-v4-flash-0731-internal:
        // requests succeed around provider input ~663k, and hard-fail at
        // usage.input=767994 with stopReason=length and output=0. Register the
        // hard ceiling so Spark compaction/preflight trigger before empty
        // completions (do not advertise 1M).
        //
        // Transport: anthropic-messages stays mandatory for thinking. The
        // gateway's Responses translation for this model accepts requests but
        // never emits reasoning items — even with
        // reasoning:{effort,summary} + include reasoning.encrypted_content the
        // chain-of-thought is flattened into output_text, which reproduces the
        // "thinking not recognized" bug. Only /v1/messages returns thinking as
        // separate content blocks for deepseek-v4-flash (measured 2026-08-19).
        contextWindow: 768_000,
        maxTokens: 32_768,
      },
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: gatewayModelId("gpt-5.6-sol"),
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_SOL_COST,
        // Measured with luna/sol: ok ~359k provider input; fails between ~360k and ~400k.
        contextWindow: 384_000,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: gatewayModelId("gpt-5.6-luna"),
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_LUNA_COST,
        // Measured: ok ~359k provider input; fails by ~400k with explicit context overflow.
        contextWindow: 384_000,
        maxTokens: 32768,
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: gatewayModelId("gpt-5.6-terra"),
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GPT_5_6_TERRA_COST,
        // Same GPT-5.6 family as luna/sol; use the measured family window.
        contextWindow: 384_000,
        maxTokens: 32768,
      },
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: gatewayModelId("grok-4.5"),
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GROK_4_5_COST,
        // Measured: ok ~467k provider input; gateway rejects above max prompt length 500000.
        contextWindow: 500_000,
        maxTokens: 32_768,
      },
      {
        id: "grok-4.6",
        name: "Grok 4.6",
        baseUrl: process.env.BAIDU_ONEAPI_OPENAI_BASE_URL ?? BAIDU_ONEAPI_OPENAI_BASE_URL,
        transportApi: "openai-responses",
        transportModelId: gatewayModelId("grok-4.6"),
        reasoning: true,
        thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
        input: ["text", "image"],
        cost: GROK_4_6_COST,
        // xAI: 500k context, no text output cap. Headline $2/$6, cacheRead $0.50.
        // Same Baidu gateway ceiling as measured grok-4.5 (reject >500000).
        contextWindow: 500_000,
        maxTokens: 32_768,
      },
    ],
  });
}
