import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  SparkAgentStreamFunction,
  SparkTurnLlm,
  StreamOptions,
  Tool,
  ToolCall,
} from "../agent-loop.ts";
import { asSparkTurnLlm } from "../turn-llm.ts";

export interface SparkScriptedProviderRequest {
  round: number;
  label?: string;
  model: {
    id: string;
    provider: string;
    api: string;
  };
  systemPrompt?: string;
  promptCacheKey?: string;
  messages: Message[];
  tools: Tool[];
  options: {
    promptCacheKey?: string;
    promptCacheKeyCompat?: string;
    reasoning?: unknown;
    signalAborted: boolean;
  };
}

export type SparkScriptedProviderTraceEvent =
  | {
      type: "provider.request";
      round: number;
      label?: string;
      messageRoles: string[];
      toolNames: string[];
    }
  | {
      type: "provider.event";
      round: number;
      label?: string;
      eventType: AssistantMessageEvent["type"];
    }
  | {
      type: "provider.result";
      round: number;
      label?: string;
      stopReason: AssistantMessage["stopReason"];
    }
  | {
      type: "provider.error";
      round: number;
      label?: string;
      message: string;
    };

export interface SparkScriptedProviderMessageRound {
  kind?: "message";
  label?: string;
  message: AssistantMessage;
  events?: readonly AssistantMessageEvent[];
  inspectRequest?: (request: SparkScriptedProviderRequest) => void;
}

export interface SparkScriptedProviderThrowRound {
  kind: "throw";
  label?: string;
  error: Error | string;
  events?: readonly AssistantMessageEvent[];
  inspectRequest?: (request: SparkScriptedProviderRequest) => void;
}

export interface SparkScriptedProviderHangRound {
  kind: "hang";
  label?: string;
  events?: readonly AssistantMessageEvent[];
  inspectRequest?: (request: SparkScriptedProviderRequest) => void;
}

export type SparkScriptedProviderRound =
  | SparkScriptedProviderMessageRound
  | SparkScriptedProviderThrowRound
  | SparkScriptedProviderHangRound;

export interface SparkScriptedProvider {
  readonly streamFunction: SparkAgentStreamFunction;
  readonly llm: SparkTurnLlm;
  readonly requests: readonly SparkScriptedProviderRequest[];
  readonly trace: readonly SparkScriptedProviderTraceEvent[];
  readonly consumedRounds: number;
  readonly remainingRounds: number;
  assertExhausted(): void;
}

export interface SparkScriptedAssistantOptions {
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
  timestamp?: number;
  usage?: Partial<AssistantMessage["usage"]>;
}

const SCRIPTED_PROVIDER_TIMESTAMP = Date.UTC(2026, 0, 1);

export const SPARK_SCRIPTED_PROVIDER_MODEL = {
  id: "spark-scripted-provider",
  name: "Spark Scripted Provider",
  api: "openai-completions",
  provider: "spark-scripted",
  baseUrl: "https://scripted.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 4_000,
} as Model<string>;

export function sparkScriptedToolCall(
  id: string,
  name: string,
  arguments_: Record<string, unknown> = {},
): ToolCall {
  return {
    type: "toolCall",
    id,
    name,
    arguments: arguments_,
  };
}

export function sparkScriptedAssistant(
  content: AssistantMessage["content"],
  options: SparkScriptedAssistantOptions = {},
): AssistantMessage {
  const baseUsage: AssistantMessage["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  const usage = {
    ...baseUsage,
    ...options.usage,
    cost: {
      ...baseUsage.cost,
      ...options.usage?.cost,
    },
  };
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "spark-scripted",
    model: SPARK_SCRIPTED_PROVIDER_MODEL.id,
    usage,
    stopReason: options.stopReason ?? "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    timestamp: options.timestamp ?? SCRIPTED_PROVIDER_TIMESTAMP,
  };
}

export function sparkScriptedTextAssistant(
  text: string,
  options: SparkScriptedAssistantOptions = {},
): AssistantMessage {
  return sparkScriptedAssistant([{ type: "text", text }], options);
}

export function createSparkScriptedProvider(
  rounds: readonly SparkScriptedProviderRound[],
): SparkScriptedProvider {
  const requests: SparkScriptedProviderRequest[] = [];
  const trace: SparkScriptedProviderTraceEvent[] = [];
  let cursor = 0;

  const streamFunction: SparkAgentStreamFunction = (model, context, options) => {
    const roundIndex = cursor;
    const round = rounds[roundIndex];
    if (!round) {
      throw new Error(
        `Spark scripted provider received unexpected request ${roundIndex + 1}; ` +
          `only ${rounds.length} round(s) were configured`,
      );
    }
    cursor += 1;

    const request = snapshotRequest(roundIndex + 1, round.label, model, context, options);
    requests.push(request);
    trace.push({
      type: "provider.request",
      round: request.round,
      ...(request.label ? { label: request.label } : {}),
      messageRoles: request.messages.map((message) => message.role),
      toolNames: request.tools.map((tool) => tool.name),
    });
    round.inspectRequest?.(request);

    return createRoundStream(roundIndex + 1, round, trace);
  };

  return {
    streamFunction,
    llm: asSparkTurnLlm(streamFunction),
    get requests() {
      return requests;
    },
    get trace() {
      return trace;
    },
    get consumedRounds() {
      return cursor;
    },
    get remainingRounds() {
      return Math.max(0, rounds.length - cursor);
    },
    assertExhausted() {
      if (cursor !== rounds.length) {
        throw new Error(
          `Spark scripted provider consumed ${cursor}/${rounds.length} configured round(s); ` +
            `${Math.max(0, rounds.length - cursor)} round(s) remain`,
        );
      }
    },
  };
}

function createRoundStream(
  roundNumber: number,
  round: SparkScriptedProviderRound,
  trace: SparkScriptedProviderTraceEvent[],
): ReturnType<SparkAgentStreamFunction> {
  const label = round.label;
  const events =
    round.events ??
    (round.kind === "message" || round.kind === undefined
      ? ([
          {
            type: "done",
            reason: normalizeDoneReason(round.message.stopReason),
            message: round.message,
          },
        ] satisfies AssistantMessageEvent[])
      : []);

  if (round.kind === "hang") {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          traceEvent(trace, roundNumber, label, event);
          yield event;
        }
        await new Promise<never>(() => undefined);
      },
      result: async () => await new Promise<never>(() => undefined),
    } as ReturnType<SparkAgentStreamFunction>;
  }

  if (round.kind === "throw") {
    const error = typeof round.error === "string" ? new Error(round.error) : round.error;
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          traceEvent(trace, roundNumber, label, event);
          yield event;
        }
        trace.push({
          type: "provider.error",
          round: roundNumber,
          ...(label ? { label } : {}),
          message: error.message,
        });
        throw error;
      },
      result: async () => {
        throw error;
      },
    } as ReturnType<SparkAgentStreamFunction>;
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        traceEvent(trace, roundNumber, label, event);
        yield event;
      }
    },
    result: async () => {
      trace.push({
        type: "provider.result",
        round: roundNumber,
        ...(label ? { label } : {}),
        stopReason: round.message.stopReason,
      });
      return round.message;
    },
  } as ReturnType<SparkAgentStreamFunction>;
}

function normalizeDoneReason(
  reason: AssistantMessage["stopReason"],
): "stop" | "length" | "toolUse" {
  return reason === "length" || reason === "toolUse" ? reason : "stop";
}

function traceEvent(
  trace: SparkScriptedProviderTraceEvent[],
  round: number,
  label: string | undefined,
  event: AssistantMessageEvent,
): void {
  trace.push({
    type: "provider.event",
    round,
    ...(label ? { label } : {}),
    eventType: event.type,
  });
  if (event.type === "done") {
    trace.push({
      type: "provider.result",
      round,
      ...(label ? { label } : {}),
      stopReason: event.message.stopReason,
    });
  } else if (event.type === "error") {
    trace.push({
      type: "provider.error",
      round,
      ...(label ? { label } : {}),
      message: event.error.errorMessage?.trim() || "provider stream failed",
    });
  }
}

function snapshotRequest(
  round: number,
  label: string | undefined,
  model: Model<string>,
  context: Context,
  options: StreamOptions | undefined,
): SparkScriptedProviderRequest {
  const requestContext = context as Context & {
    systemPrompt?: string;
    promptCacheKey?: string;
    messages?: Message[];
    tools?: Tool[];
  };
  const requestOptions = options as
    | (StreamOptions & {
        promptCacheKey?: string;
        prompt_cache_key?: string;
        reasoning?: unknown;
      })
    | undefined;
  return {
    round,
    ...(label ? { label } : {}),
    model: {
      id: String(model.id),
      provider: String(model.provider),
      api: String(model.api),
    },
    ...(requestContext.systemPrompt ? { systemPrompt: requestContext.systemPrompt } : {}),
    ...(requestContext.promptCacheKey ? { promptCacheKey: requestContext.promptCacheKey } : {}),
    messages: cloneJson(requestContext.messages ?? []),
    tools: cloneJson(requestContext.tools ?? []),
    options: {
      ...(requestOptions?.promptCacheKey ? { promptCacheKey: requestOptions.promptCacheKey } : {}),
      ...(requestOptions?.prompt_cache_key
        ? { promptCacheKeyCompat: requestOptions.prompt_cache_key }
        : {}),
      ...(requestOptions?.reasoning !== undefined ? { reasoning: requestOptions.reasoning } : {}),
      signalAborted: requestOptions?.signal?.aborted ?? false,
    },
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
