/**
 * Private pi-ai stream transport used by SparkProviderLlmAdapter.
 *
 * dsh-llm StreamChunk is the live wire. These helpers keep the bundled pi-ai
 * provider runners working without a public reverse dsh↔pi bridge.
 */
import type { CallId } from "@deepseek-ai/dsh-llm";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type FinishReason,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  StreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

const SPARK_ASSISTANT_REPLAY_KEY = "sparkAssistant";
const SPARK_PI_REQUEST_KEY = "__sparkPiRequest";
const SPARK_EVENT_KEY = "sparkEvent";
const sparkEvents = new WeakMap<StreamChunk, AssistantMessageEvent>();

type SparkTaggedChunk = StreamChunk & {
  [SPARK_EVENT_KEY]?: AssistantMessageEvent;
};

export type SparkPiAiStream = AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface SparkPiGenerateCarrier {
  model: Model<string>;
  context: Context;
  options: StreamOptions & { maxTokens?: number; reasoning?: string };
}

type SparkGenerateOptions = GenerateOptions & {
  [SPARK_PI_REQUEST_KEY]?: SparkPiGenerateCarrier;
};

export function sparkContextToGenerateOptions(
  model: Model<string>,
  context: Context,
  options: StreamOptions & { maxTokens?: number; reasoning?: string } = {},
): GenerateOptions {
  const reasoning = options.reasoning;
  const generate = {
    provider: String(model.provider ?? "spark"),
    model: model.id,
    ...(context.systemPrompt ? { system: context.systemPrompt } : {}),
    messages: (context.messages ?? []).flatMap((message) => piMessageToDshMessages(message)),
    ...(context.tools ? { tools: context.tools.map(piToolToSchema) } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    // LlmRuntime rejects reasoningEffort unless the model advertises it.
    ...(typeof reasoning === "string" && reasoning !== "off" && model.reasoning
      ? { reasoningEffort: reasoning as GenerateOptions["reasoningEffort"] }
      : {}),
  } as SparkGenerateOptions;
  generate[SPARK_PI_REQUEST_KEY] = { model, context, options };
  return generate;
}

export function readSparkPiGenerateCarrier(
  options: GenerateOptions,
): SparkPiGenerateCarrier | undefined {
  return (options as SparkGenerateOptions)[SPARK_PI_REQUEST_KEY];
}

export function generateOptionsToPiContext(options: GenerateOptions): Context {
  const carrier = readSparkPiGenerateCarrier(options);
  if (carrier) return carrier.context;
  return {
    ...(options.system ? { systemPrompt: options.system } : {}),
    messages: options.messages.flatMap(dshMessageToPiMessages),
    ...(options.tools
      ? {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
  } as Context;
}

export function generateOptionsToPiModel(options: GenerateOptions): Model<string> {
  const carrier = readSparkPiGenerateCarrier(options);
  if (carrier) return carrier.model;
  return {
    id: options.model,
    name: options.model,
    api: "openai-completions",
    provider: options.provider,
    baseUrl: "",
    reasoning: Boolean(options.reasoningEffort),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: options.maxTokens ?? 4096,
  };
}

export function generateOptionsToPiStreamOptions(options: GenerateOptions): StreamOptions {
  const carrier = readSparkPiGenerateCarrier(options);
  if (carrier) return carrier.options as StreamOptions;
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoningEffort ? { reasoning: options.reasoningEffort } : {}),
  } as StreamOptions;
}

export function piEventToLlmChunks(event: AssistantMessageEvent): StreamChunk[] {
  return [...chunksForPiEvent(event)];
}

export async function* piEventsToLlmChunks(stream: SparkPiAiStream): AsyncIterable<StreamChunk> {
  let sawTerminal = false;
  for await (const event of stream) {
    yield* chunksForPiEvent(event);
    if (event.type === "done" || event.type === "error") {
      sawTerminal = true;
      return;
    }
  }
  if (sawTerminal) return;
  const message = await stream.result();
  if (message) yield* assistantMessageToChunks(message);
}

export function llmChunksToPiAiStream(
  chunks: AsyncIterable<StreamChunk>,
  model: Model<string>,
): SparkPiAiStream {
  let resolveResult: (value: AssistantMessage) => void = () => undefined;
  const resultPromise = new Promise<AssistantMessage>((resolve) => {
    resolveResult = resolve;
  });
  return {
    async *[Symbol.asyncIterator]() {
      let assembled = emptyAssistant(model);
      let started = false;
      let finished = false;
      for await (const chunk of chunks) {
        const sparkEvent = readSparkEvent(chunk);
        if (sparkEvent) {
          if (sparkEvent.type === "start") started = true;
          if (!(sparkEvent.type === "start" && chunk.type === "text-delta" && chunk.text === "")) {
            assembled = applyChunk(assembled, chunk);
          }
          yield sparkEvent;
          if (sparkEvent.type === "done") {
            finished = true;
            resolveResult(sparkEvent.message);
            return;
          }
          if (sparkEvent.type === "error") {
            finished = true;
            resolveResult(sparkEvent.error);
            return;
          }
          continue;
        }
        assembled = applyChunk(assembled, chunk);
        if (chunk.type === "finish") {
          finished = true;
          const replayed = readSparkAssistantReplay(chunk.replayState);
          const message = replayed ?? withFinish(assembled, chunk);
          if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
            yield { type: "error", reason: chunk.reason.kind, error: message };
          } else {
            if (!started) {
              started = true;
              yield { type: "start", partial: message };
            }
            yield { type: "done", reason: doneReason(message), message };
          }
          resolveResult(message);
          return;
        }
        if (chunk.type === "usage") continue;
        if (!started) {
          started = true;
          yield { type: "start", partial: assembled };
        }
        const reconstructed = reconstructPiEvent(chunk, assembled);
        if (reconstructed) yield reconstructed;
      }
      if (!finished) {
        // Completing without a terminal finish matches a pi-ai stream whose
        // iterator ended and whose result() is undefined. A hang never reaches
        // here, so idle-timeout stays on the pending iterator.
        resolveResult(undefined as unknown as AssistantMessage);
      }
    },
    result: () => resultPromise,
  };
}

function tagChunk(chunk: StreamChunk, event: AssistantMessageEvent): StreamChunk {
  sparkEvents.set(chunk, event);
  (chunk as SparkTaggedChunk)[SPARK_EVENT_KEY] = event;
  return chunk;
}

function readSparkEvent(chunk: StreamChunk): AssistantMessageEvent | undefined {
  return sparkEvents.get(chunk) ?? (chunk as SparkTaggedChunk)[SPARK_EVENT_KEY];
}

function contentIndexOf(event: AssistantMessageEvent): number {
  return "contentIndex" in event ? event.contentIndex : 0;
}

function toolCallIdFromPartial(event: AssistantMessageEvent): CallId | undefined {
  if (!("partial" in event) || !event.partial || !("contentIndex" in event)) return undefined;
  const part = event.partial.content[event.contentIndex];
  if (part?.type === "toolCall") return part.id as CallId;
  return undefined;
}

function* chunksForPiEvent(event: AssistantMessageEvent): Iterable<StreamChunk> {
  const index = contentIndexOf(event);
  switch (event.type) {
    case "start":
      yield tagChunk({ type: "text-delta", index: 0, text: "" }, event);
      return;
    case "text_start":
      yield tagChunk({ type: "block-start", index, blockType: "text" }, event);
      return;
    case "text_delta":
      yield tagChunk({ type: "text-delta", index, text: event.delta }, event);
      return;
    case "text_end":
      yield tagChunk(
        { type: "block-end", index, block: { type: "text", text: event.content } },
        event,
      );
      return;
    case "thinking_start":
      yield tagChunk({ type: "block-start", index, blockType: "reasoning" }, event);
      return;
    case "thinking_delta":
      yield tagChunk({ type: "reasoning-delta", index, text: event.delta }, event);
      return;
    case "thinking_end":
      yield tagChunk(
        { type: "block-end", index, block: { type: "reasoning", text: event.content } },
        event,
      );
      return;
    case "toolcall_start":
    case "toolcall_delta": {
      const id = toolCallIdFromPartial(event) ?? (`spark-tool-${String(index)}` as CallId);
      yield tagChunk(
        {
          type: "tool-call-delta",
          index,
          id,
          argumentsDelta: event.type === "toolcall_delta" ? event.delta : "",
        },
        event,
      );
      return;
    }
    case "toolcall_end":
      yield tagChunk(
        {
          type: "block-end",
          index,
          block: {
            type: "tool-call",
            id: event.toolCall.id as CallId,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments ?? {}),
          },
        },
        event,
      );
      return;
    case "done":
      yield usageChunk(event.message);
      yield tagChunk(
        {
          type: "finish",
          reason: finishReasonFromAssistant(event.message),
          replayState: { response: { [SPARK_ASSISTANT_REPLAY_KEY]: event.message } },
        },
        event,
      );
      return;
    case "error":
      yield tagChunk(assistantFailureChunk(event.error), event);
      return;
  }
}

function applyChunk(message: AssistantMessage, chunk: StreamChunk): AssistantMessage {
  if (chunk.type === "text-delta") return appendText(message, chunk.text);
  if (chunk.type === "reasoning-delta") return appendThinking(message, chunk.text);
  if (chunk.type === "tool-call-delta") {
    return upsertToolCall(message, chunk.id, chunk.name, chunk.argumentsDelta);
  }
  if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
    return upsertToolCall(message, chunk.block.id, chunk.block.name, chunk.block.arguments);
  }
  return message;
}

function reconstructPiEvent(
  chunk: StreamChunk,
  assembled: AssistantMessage,
): AssistantMessageEvent | undefined {
  if (chunk.type === "block-start") {
    if (chunk.blockType === "text") {
      return { type: "text_start", contentIndex: chunk.index, partial: assembled };
    }
    if (chunk.blockType === "reasoning") {
      return { type: "thinking_start", contentIndex: chunk.index, partial: assembled };
    }
    if (chunk.blockType === "tool-call") {
      return { type: "toolcall_start", contentIndex: chunk.index, partial: assembled };
    }
  }
  if (chunk.type === "text-delta") {
    return {
      type: "text_delta",
      contentIndex: chunk.index,
      delta: chunk.text,
      partial: assembled,
    };
  }
  if (chunk.type === "reasoning-delta") {
    return {
      type: "thinking_delta",
      contentIndex: chunk.index,
      delta: chunk.text,
      partial: assembled,
    };
  }
  if (chunk.type === "tool-call-delta") {
    return {
      type: "toolcall_delta",
      contentIndex: chunk.index,
      delta: chunk.argumentsDelta,
      partial: assembled,
    };
  }
  if (chunk.type === "block-end") {
    if (chunk.block.type === "text") {
      return {
        type: "text_end",
        contentIndex: chunk.index,
        content: chunk.block.text,
        partial: assembled,
      };
    }
    if (chunk.block.type === "reasoning") {
      return {
        type: "thinking_end",
        contentIndex: chunk.index,
        content: chunk.block.text,
        partial: assembled,
      };
    }
    if (chunk.block.type === "tool-call") {
      return {
        type: "toolcall_end",
        contentIndex: chunk.index,
        toolCall: {
          type: "toolCall",
          id: chunk.block.id,
          name: chunk.block.name,
          arguments: parseArguments(chunk.block.arguments),
        } as ToolCall,
        partial: assembled,
      };
    }
  }
  return undefined;
}

function doneReason(
  message: AssistantMessage,
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse" | "deferred"> {
  if (message.stopReason === "length") return "length";
  if (message.stopReason === "toolUse") return "toolUse";
  if (message.stopReason === "deferred") return "deferred";
  return "stop";
}

function piToolToSchema(tool: Tool): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters:
      tool.parameters && typeof tool.parameters === "object"
        ? (tool.parameters as Record<string, unknown>)
        : { type: "object" },
  };
}

function piMessageToDshMessages(message: Message): GenerateOptions["messages"] {
  if (message.role === "assistant") {
    return [
      createAssistantMessage({
        content: assistantContentToBlocks(message.content),
        source: {
          provider: message.provider ?? "spark",
          model: message.model ?? "unknown",
        },
      }),
    ];
  }
  if (message.role === "toolResult") {
    const toolResult = message as ToolResultMessage;
    return [
      createToolResultMessage({
        callId: toolResult.toolCallId as CallId,
        content: textBlocksFromUnknown(toolResult.content),
        isError: Boolean(toolResult.isError),
      }),
    ];
  }
  const text = userMessageText(message);
  return [
    createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }),
  ];
}

function dshMessageToPiMessages(message: GenerateOptions["messages"][number]): Message[] {
  if (message.role === "assistant") {
    return [
      {
        role: "assistant",
        content: dshBlocksToPiContent(message.content),
        api: "openai-completions",
        provider: message.source.kind === "model" ? message.source.provider : "spark",
        model: message.source.kind === "model" ? message.source.model : "unknown",
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      } as AssistantMessage,
    ];
  }
  const toolResult = message.content.find((block) => block.type === "tool-result");
  if (toolResult && toolResult.type === "tool-result") {
    return [
      {
        role: "toolResult",
        toolCallId: toolResult.toolCallId,
        toolName: "",
        content: toolResult.content.map((block) =>
          block.type === "text" ? { type: "text", text: block.text } : { type: "text", text: "" },
        ),
        isError: Boolean(toolResult.isError),
        timestamp: Date.now(),
      } as ToolResultMessage,
    ];
  }
  return [
    {
      role: "user",
      content: message.content
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n"),
      timestamp: Date.now(),
    } as Message,
  ];
}

function assistantContentToBlocks(content: AssistantMessage["content"]) {
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "thinking") {
      const text = "thinking" in part && typeof part.thinking === "string" ? part.thinking : "";
      return { type: "reasoning" as const, text };
    }
    if (part.type === "toolCall") {
      const toolCall = part as ToolCall;
      return {
        type: "tool-call" as const,
        id: toolCall.id as CallId,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments ?? {}),
      };
    }
    return { type: "text" as const, text: "" };
  });
}

function dshBlocksToPiContent(
  content: GenerateOptions["messages"][number]["content"],
): AssistantMessage["content"] {
  const parts: AssistantMessage["content"] = [];
  for (const block of content) {
    if (block.type === "text") parts.push({ type: "text", text: block.text });
    if (block.type === "reasoning") parts.push({ type: "thinking", thinking: block.text } as never);
    if (block.type === "tool-call") {
      parts.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      } as ToolCall);
    }
  }
  return parts;
}

function* assistantMessageToChunks(
  message: AssistantMessage,
  terminal?: Extract<AssistantMessageEvent, { type: "done" }>,
): Iterable<StreamChunk> {
  let index = 0;
  for (const part of message.content) {
    if (part.type === "text") {
      yield { type: "block-start", index, blockType: "text" };
      yield { type: "text-delta", index, text: part.text };
      yield { type: "block-end", index, block: { type: "text", text: part.text } };
    } else if (part.type === "thinking") {
      const text = "thinking" in part && typeof part.thinking === "string" ? part.thinking : "";
      yield { type: "block-start", index, blockType: "reasoning" };
      yield { type: "reasoning-delta", index, text };
      yield { type: "block-end", index, block: { type: "reasoning", text } };
    } else if (part.type === "toolCall") {
      const toolCall = part as ToolCall;
      const args = JSON.stringify(toolCall.arguments ?? {});
      yield { type: "block-start", index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index,
        id: toolCall.id as CallId,
        name: toolCall.name,
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index,
        block: {
          type: "tool-call",
          id: toolCall.id as CallId,
          name: toolCall.name,
          arguments: args,
        },
      };
    }
    index += 1;
  }
  yield usageChunk(message);
  const finish: StreamChunk = {
    type: "finish",
    reason: finishReasonFromAssistant(message),
    replayState: { response: { [SPARK_ASSISTANT_REPLAY_KEY]: message } },
  };
  yield terminal ? tagChunk(finish, terminal) : finish;
}

function usageChunk(message: AssistantMessage): StreamChunk {
  return {
    type: "usage",
    usage: {
      inputTokens: message.usage?.input ?? 0,
      outputTokens: message.usage?.output ?? 0,
      ...(message.usage?.cacheRead !== undefined
        ? { cacheReadTokens: message.usage.cacheRead }
        : {}),
      ...(message.usage?.cacheWrite !== undefined
        ? { cacheWriteTokens: message.usage.cacheWrite }
        : {}),
    },
  };
}

function assistantFailureChunk(message: AssistantMessage): StreamChunk {
  return {
    type: "finish",
    reason: {
      kind: message.stopReason === "aborted" ? "aborted" : "error",
      failure: {
        message: message.errorMessage?.trim() || "provider error",
        code: message.stopReason === "aborted" ? "ABORTED" : "PROVIDER",
      },
    },
    replayState: { response: { [SPARK_ASSISTANT_REPLAY_KEY]: message } },
  };
}

function finishReasonFromAssistant(message: AssistantMessage): FinishReason {
  if (message.stopReason === "toolUse") return { kind: "tool-calls" };
  if (message.stopReason === "length") return { kind: "max-tokens" };
  if (message.stopReason === "aborted") {
    return {
      kind: "aborted",
      failure: { message: message.errorMessage?.trim() || "aborted", code: "ABORTED" },
    };
  }
  if (message.stopReason === "error") {
    return {
      kind: "error",
      failure: { message: message.errorMessage?.trim() || "provider error", code: "PROVIDER" },
    };
  }
  return { kind: "stop" };
}

function readSparkAssistantReplay(replayState: unknown): AssistantMessage | undefined {
  if (!replayState || typeof replayState !== "object") return undefined;
  const response = (replayState as { response?: unknown }).response;
  if (!response || typeof response !== "object") return undefined;
  const assistant = (response as Record<string, unknown>)[SPARK_ASSISTANT_REPLAY_KEY];
  if (!assistant || typeof assistant !== "object") return undefined;
  return assistant as AssistantMessage;
}

function emptyAssistant(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function appendText(message: AssistantMessage, text: string): AssistantMessage {
  const last = message.content.at(-1);
  if (last?.type === "text") {
    return {
      ...message,
      content: [...message.content.slice(0, -1), { type: "text", text: last.text + text }],
    };
  }
  return { ...message, content: [...message.content, { type: "text", text }] };
}

function appendThinking(message: AssistantMessage, text: string): AssistantMessage {
  const last = message.content.at(-1);
  if (last?.type === "thinking" && "thinking" in last && typeof last.thinking === "string") {
    return {
      ...message,
      content: [
        ...message.content.slice(0, -1),
        { ...last, thinking: last.thinking + text } as never,
      ],
    };
  }
  return {
    ...message,
    content: [...message.content, { type: "thinking", thinking: text } as never],
  };
}

function upsertToolCall(
  message: AssistantMessage,
  id: string,
  name: string | undefined,
  argumentsDelta: string,
): AssistantMessage {
  const existing = message.content.find(
    (part): part is ToolCall => part.type === "toolCall" && part.id === id,
  );
  if (existing) {
    const prev =
      typeof existing.arguments === "string"
        ? existing.arguments
        : JSON.stringify(existing.arguments ?? {});
    return {
      ...message,
      content: message.content.map((part) =>
        part === existing
          ? {
              ...existing,
              name: name ?? existing.name,
              arguments: parseArguments(prev + argumentsDelta),
            }
          : part,
      ),
    };
  }
  return {
    ...message,
    content: [
      ...message.content,
      {
        type: "toolCall",
        id,
        name: name ?? "",
        arguments: parseArguments(argumentsDelta),
      } as ToolCall,
    ],
  };
}

function withFinish(
  message: AssistantMessage,
  chunk: Extract<StreamChunk, { type: "finish" }>,
): AssistantMessage {
  const stopReason =
    chunk.reason.kind === "tool-calls"
      ? "toolUse"
      : chunk.reason.kind === "max-tokens"
        ? "length"
        : chunk.reason.kind === "aborted"
          ? "aborted"
          : chunk.reason.kind === "error"
            ? "error"
            : "stop";
  return {
    ...message,
    stopReason,
    ...("failure" in chunk.reason ? { errorMessage: chunk.reason.failure.message } : {}),
  };
}

function userMessageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
    .join("");
}

function textBlocksFromUnknown(content: unknown): Array<{ type: "text"; text: string }> {
  if (!Array.isArray(content)) return [{ type: "text", text: unknownToText(content) }];
  return content.map((part) =>
    part && typeof part === "object" && "text" in part
      ? { type: "text", text: unknownToText(part.text) }
      : { type: "text", text: "" },
  );
}

function unknownToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
