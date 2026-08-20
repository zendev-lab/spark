/**
 * dsh-agent-loop composition for Spark turns.
 *
 * SparkAgentLoop remains the host-facing facade (prompt items, outbox, views).
 * This module is the low-level driver: Cordis plugins + AgentLoop.followup/whenIdle.
 */
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type AgentHandle } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  CallId,
  LlmAdapter,
  LlmError,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { idleWatchdog } from "@deepseek-ai/dsh-timeout";
import ToolRuntime, { defineTool, type PreToolDecision } from "@deepseek-ai/dsh-tools";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@zendev-lab/spark-llm";
import {
  llmChunksToPiAiStream,
  piEventToLlmChunks,
  sparkContextToGenerateOptions,
} from "@zendev-lab/spark-llm/pi-ai-stream";

import type { SparkPromptItem } from "./prompt-items.ts";
import { isPlainRecord } from "./tool-dispatch.ts";
import type { SparkTurnLlm } from "./turn-llm.ts";

export interface SparkTurnDriverCheckpoint {
  toolCalls: ToolCall[];
  promptItems: readonly SparkPromptItem[];
  roundtrips: number;
}

const SPARK_TURN_PROVIDER = "spark-turn";
const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";
const SPARK_TURN_RESTART_YIELD_ERROR_CODE = "SPARK_TURN_RESTART_YIELD";

export interface SparkTurnDriverTool {
  name: string;
  description: string;
  parallelSafe?: boolean;
  timeoutMs?: number;
}

export interface SparkAssembledTurn {
  model: Model<string>;
  context: PiContext;
  requestedOutputTokens: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface SparkTurnDriverHooks {
  assemble(): Promise<SparkAssembledTurn>;
  dispatchToolCall(toolCall: ToolCall, signal: AbortSignal): Promise<ToolResultMessage>;
  onStreamEvent?(event: { type: string; [key: string]: unknown }): void;
  onAssistant?(assistant: unknown): void | Promise<void>;
  onToolResult?(result: ToolResultMessage): void;
  onTooling?(): void;
  onRoundtrip?(): void | Promise<void>;
  beforeToolCalls?(checkpoint: SparkTurnDriverCheckpoint): void | Promise<void>;
  preExecute?(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<PreToolDecision>;
  collectToolCalls?(assistant: unknown): ToolCall[];
  promptItems(): readonly SparkPromptItem[];
  roundtrips(): number;
}

export interface RunSparkDshTurnInput {
  llm: SparkTurnLlm;
  sessionId: string;
  cwd?: string;
  followupText: string;
  tools: readonly SparkTurnDriverTool[];
  maxParallelToolCalls: number;
  streamIdleTimeoutMs: number;
  signal: AbortSignal;
  hooks: SparkTurnDriverHooks;
}

interface SparkTurnConcurrencyGate {
  sequential: boolean;
}

interface SparkTurnDriverCapture {
  restart?: unknown;
  driverError?: unknown;
}

export async function runSparkDshTurn(input: RunSparkDshTurnInput): Promise<void> {
  const ctx = new Context();
  let handle: AgentHandle | undefined;
  const captured: SparkTurnDriverCapture = {};
  const cancelAgent = (): void => {
    handle?.agent.cancel({ kind: "user" });
  };
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, {
      agents: [],
      maxParallelToolCalls: input.maxParallelToolCalls,
    });
    installSparkHangTimeoutPlugin(ctx, input.streamIdleTimeoutMs);
    installSparkConsentPlugin(ctx, input.hooks);
    installSparkHostGuardPlugin(ctx, (signal) => {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
      }
    });
    ctx.on("agent/error", (payload) => {
      captured.driverError ??= payload.error;
    });
    const registeredNames = new Set(input.tools.map((tool) => tool.name));
    const parallelSafeNames = new Set(
      input.tools.filter((tool) => tool.parallelSafe).map((tool) => tool.name),
    );
    const concurrency: SparkTurnConcurrencyGate = { sequential: false };
    ctx.llm.registerAdapter(
      [SPARK_TURN_PROVIDER],
      new SparkTurnLlmAdapter(
        input.llm,
        input.hooks,
        input.signal,
        ctx,
        registeredNames,
        parallelSafeNames,
        concurrency,
        captured,
      ),
    );
    for (const tool of input.tools) {
      ctx.tools.register(sparkHostToolDefinition(tool, input.hooks, concurrency));
    }
    handle = await ctx.agents.create({
      sessionId: SessionId(input.sessionId),
      agentOptions: { provider: SPARK_TURN_PROVIDER, model: SPARK_TURN_PROVIDER },
      ...(isAbsolutePath(input.cwd) ? { meta: { cwd: input.cwd } } : {}),
      signal: input.signal,
    });
    if (input.signal.aborted) {
      cancelAgent();
    } else {
      input.signal.addEventListener("abort", cancelAgent, { once: true });
    }
    handle.agent.followup(
      createUserMessage({
        content: [{ type: "text", text: input.followupText }],
        source: { kind: "user" },
      }),
    );
    await handle.agent.whenIdle();
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error(String(input.signal.reason ?? "aborted"));
    }
    if (captured.restart) throw captured.restart;
    if (captured.driverError) throw captured.driverError;
  } finally {
    input.signal.removeEventListener("abort", cancelAgent);
    await handle?.dispose().catch(() => undefined);
    await ctx.fiber.dispose();
  }
}

export function installSparkConsentPlugin(ctx: Context, hooks: SparkTurnDriverHooks): void {
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!hooks.preExecute) return next();
    const args = isPlainRecord(exec.arguments) ? exec.arguments : {};
    const decision = await hooks.preExecute(exec.name, args, exec.signal);
    if (decision.kind === "allow") return next();
    return decision;
  });
}

export function installSparkHostGuardPlugin(
  ctx: Context,
  guard: (signal: AbortSignal) => void | Promise<void>,
): void {
  ctx.on("agent/pre-step", async (payload, next) => {
    await guard(payload.signal);
    return next();
  });
  ctx.on("agent/request-error", async (_payload, next) => next());
}

export function installSparkHangTimeoutPlugin(ctx: Context, idleTimeoutMs: number): void {
  if (idleTimeoutMs <= 0) return;
  ctx.on("llm/stream", async function* (options: GenerateOptions, next) {
    const watchdog = idleWatchdog(options.signal, idleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE);
    try {
      const iterator = next()[Symbol.asyncIterator]();
      while (true) {
        const result = await watchdog.next(iterator);
        if (result.done) return;
        yield result.value;
      }
    } finally {
      watchdog[Symbol.dispose]();
    }
  });
}

class SparkTurnLlmAdapter extends LlmAdapter {
  private readonly llm: SparkTurnLlm;
  private readonly hooks: SparkTurnDriverHooks;
  private readonly signal: AbortSignal;
  private readonly ctx: Context;
  private readonly registeredNames: Set<string>;
  private readonly parallelSafeNames: Set<string>;
  private readonly concurrency: SparkTurnConcurrencyGate;
  private readonly captured: SparkTurnDriverCapture;

  constructor(
    llm: SparkTurnLlm,
    hooks: SparkTurnDriverHooks,
    signal: AbortSignal,
    ctx: Context,
    registeredNames: Set<string>,
    parallelSafeNames: Set<string>,
    concurrency: SparkTurnConcurrencyGate,
    captured: SparkTurnDriverCapture,
  ) {
    super();
    this.llm = llm;
    this.hooks = hooks;
    this.signal = signal;
    this.ctx = ctx;
    this.registeredNames = registeredNames;
    this.parallelSafeNames = parallelSafeNames;
    this.concurrency = concurrency;
    this.captured = captured;
  }

  override providerInfo(provider: string) {
    return { id: provider, name: "Spark turn driver" };
  }

  override async listModels(provider: string) {
    return [{ provider, id: SPARK_TURN_PROVIDER, name: "Spark turn model" }];
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.hooks.onRoundtrip?.();
    const assembled = await this.hooks.assemble();
    const cacheKey = readPromptCacheKey(assembled.context);
    const generate = sparkContextToGenerateOptions(assembled.model, assembled.context, {
      signal: options.signal ?? this.signal,
      maxTokens: assembled.requestedOutputTokens,
      ...(assembled.reasoning !== undefined ? { reasoning: assembled.reasoning } : {}),
      ...(cacheKey ? { promptCacheKey: cacheKey, prompt_cache_key: cacheKey } : {}),
    } as Parameters<typeof sparkContextToGenerateOptions>[2]);
    const hooks = this.hooks;
    try {
      const piStream = llmChunksToPiAiStream(this.llm.stream(generate), assembled.model);
      for await (const event of piStream) {
        hooks.onStreamEvent?.(event);
        if (event.type === "error") {
          await hooks.onAssistant?.(event.error);
          yield* piEventToLlmChunks(event);
          return;
        }
        if (event.type !== "done") continue;
        await hooks.onAssistant?.(event.message);
        const toolCalls = hooks.collectToolCalls?.(event.message) ?? [];
        if (toolCalls.length === 0) {
          yield* piEventToLlmChunks(event);
          return;
        }
        hooks.onTooling?.();
        try {
          await hooks.beforeToolCalls?.({
            toolCalls,
            promptItems: hooks.promptItems(),
            roundtrips: hooks.roundtrips(),
          });
        } catch (error) {
          if (isRestartYieldError(error)) {
            this.captured.restart = error;
            yield { type: "finish", reason: { kind: "stop" } };
            return;
          }
          throw error;
        }
        for (const toolCall of toolCalls) {
          this.ensureHostTool(toolCall.name);
        }
        this.concurrency.sequential = !toolCalls.every((call) =>
          this.parallelSafeNames.has(call.name),
        );
        yield* dshChunksFromAssistant(event.message);
        return;
      }
    } catch (error) {
      if (isRestartYieldError(error)) {
        this.captured.restart = error;
        yield { type: "finish", reason: { kind: "stop" } };
        return;
      }
      const message = error instanceof Error ? error.message.trim() : String(error);
      throw new LlmError(message || "provider error", errorCodeOf(error), { cause: error });
    }
  }

  private ensureHostTool(name: string): void {
    if (this.registeredNames.has(name)) return;
    this.registeredNames.add(name);
    this.ctx.tools.register(
      sparkHostToolDefinition({ name, description: name }, this.hooks, this.concurrency),
    );
  }
}

function sparkHostToolDefinition(
  tool: SparkTurnDriverTool,
  hooks: SparkTurnDriverHooks,
  concurrency: SparkTurnConcurrencyGate,
) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: {},
    ...(tool.timeoutMs && tool.timeoutMs > 0 ? { timeoutMs: tool.timeoutMs } : {}),
    ...(tool.parallelSafe ? { isConcurrencySafe: () => !concurrency.sequential } : {}),
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const toolCall: ToolCall = {
        type: "toolCall",
        id: String(exec.callId),
        name: tool.name,
        arguments: isPlainRecord(args) ? args : {},
      };
      const result = await hooks.dispatchToolCall(toolCall, exec.signal);
      hooks.onToolResult?.(result);
      const text = result.content
        .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
        .join("\n");
      return { text, isError: Boolean(result.isError) };
    },
  });
}

function* dshChunksFromAssistant(message: AssistantMessage): Iterable<StreamChunk> {
  let index = 0;
  for (const part of message.content) {
    if (part.type === "toolCall") {
      const toolCall = part as ToolCall;
      const id = CallId(String(toolCall.id));
      const args = JSON.stringify(toolCall.arguments ?? {});
      yield { type: "block-start", index, blockType: "tool-call" };
      yield {
        type: "tool-call-delta",
        index,
        id,
        name: toolCall.name,
        argumentsDelta: args,
      };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id, name: toolCall.name, arguments: args },
      };
    } else if (part.type === "text") {
      yield { type: "block-start", index, blockType: "text" };
      yield { type: "text-delta", index, text: part.text };
      yield { type: "block-end", index, block: { type: "text", text: part.text } };
    } else if (part.type === "thinking") {
      const text = "thinking" in part && typeof part.thinking === "string" ? part.thinking : "";
      yield { type: "block-start", index, blockType: "reasoning" };
      yield { type: "reasoning-delta", index, text };
      yield { type: "block-end", index, block: { type: "reasoning", text } };
    }
    index += 1;
  }
  yield { type: "finish", reason: { kind: "tool-calls" } };
}

function readPromptCacheKey(context: PiContext): string | undefined {
  const key = (context as PiContext & { promptCacheKey?: unknown }).promptCacheKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function errorCodeOf(value: unknown): string {
  if (!value || typeof value !== "object") return "UNKNOWN";
  const record = value as { code?: unknown; cause?: unknown };
  if (typeof record.code === "string" && record.code.trim()) return record.code.trim();
  return errorCodeOf(record.cause);
}

function isRestartYieldError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === SPARK_TURN_RESTART_YIELD_ERROR_CODE;
}

function isAbsolutePath(path: string | undefined): path is string {
  return Boolean(path && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)));
}
