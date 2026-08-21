/**
 * dsh-agent-loop composition for Spark turns.
 *
 * SparkAgentLoop remains the host-facing facade (prompt items, outbox, views).
 * This module is the low-level driver: Cordis plugins + AgentLoop.followup/whenIdle.
 */
import { randomUUID } from "node:crypto";

import type { Context, Plugin } from "@deepseek-ai/cordis";
import { type AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  CallId,
  LlmAdapter,
  LlmError,
  createUserMessage,
  isAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
  type ToolResultMessage as DshToolResultMessage,
  type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { idleWatchdog } from "@deepseek-ai/dsh-timeout";
import { defineTool, type PreToolDecision } from "@deepseek-ai/dsh-tools";
import type { SparkDshToolPolicyMetadata, SparkExecutionService } from "@zendev-lab/spark-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  Tool,
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

declare module "@deepseek-ai/cordis" {
  interface Context {
    sparkExecution: SparkExecutionService;
  }
}

export interface SparkTurnDriverCheckpoint {
  toolCalls: ToolCall[];
  promptItems: readonly SparkPromptItem[];
  roundtrips: number;
}

const SPARK_TURN_PROVIDER = "spark-turn";
const SPARK_AUXILIARY_MODEL_PREFIX = "spark-auxiliary-model:";
const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";
const SPARK_TURN_RESTART_YIELD_ERROR_CODE = "SPARK_TURN_RESTART_YIELD";

export interface SparkTurnDriverTool {
  name: string;
  description: string;
  parallelSafe?: boolean;
  timeoutMs?: number;
}

/** Encode an explicit model behind one invocation-private Spark driver route. */
export function encodeSparkAuxiliaryModelRoute(model: string, provider?: string): string {
  const normalizedModel = model.trim();
  if (!normalizedModel) throw new Error("Spark auxiliary model id is required");
  return `${SPARK_AUXILIARY_MODEL_PREFIX}${encodeURIComponent(provider?.trim() ?? "")}/${encodeURIComponent(normalizedModel)}`;
}

export interface SparkAssembledTurn {
  model: Model<string>;
  context: PiContext;
  requestedOutputTokens: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface SparkDshToolDescriptor {
  readonly schema: ToolSchema;
  readonly policy: SparkDshToolPolicyMetadata | undefined;
}

export interface SparkPreparedTurn {
  context: PiContext;
  requestedOutputTokens: number;
}

export interface SparkTurnDriverHooks {
  assemble(): Promise<SparkAssembledTurn>;
  /** Resolve the Spark provider behind the Agent's private driver route. */
  resolveAuxiliaryModel?(): Model<string>;
  prepareRequest?(
    assembled: SparkAssembledTurn,
    context: PiContext,
    dshTools: readonly SparkDshToolDescriptor[],
  ): Promise<SparkPreparedTurn>;
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
    registration: SparkTurnToolRegistration,
  ): Promise<PreToolDecision>;
  isDshToolAvailable?(name: string, policy: SparkDshToolPolicyMetadata | undefined): boolean;
  collectToolCalls?(assistant: unknown): ToolCall[];
  promptItems(): readonly SparkPromptItem[];
  roundtrips(): number;
}

export interface RunSparkDshTurnInput {
  /** Shared daemon Cordis root. The Agent handle owns the invocation-local scope. */
  ctx: Context;
  llm: SparkTurnLlm;
  sessionId: string;
  sessionMetadata?: SparkDshSessionMetadata;
  execution: SparkExecutionService;
  /** Cordis plugins composed into this invocation's unpublished Agent scope. */
  agentPlugins?: readonly Plugin[];
  cwd?: string;
  followupText: string;
  tools: readonly SparkTurnDriverTool[];
  streamIdleTimeoutMs: number;
  signal: AbortSignal;
  hooks: SparkTurnDriverHooks;
}

export type SparkTurnToolRegistration =
  | { readonly owner: "spark-host" }
  | {
      readonly owner: "dsh";
      readonly callId: string;
      readonly policy: SparkDshToolPolicyMetadata | undefined;
    };

export interface SparkDshSessionMetadata {
  timestamp: string;
  sparkVersion: number;
  visibility?: "internal";
  purpose?: "side_thread" | "loop_tick";
  parentSessionPath?: string;
}

interface SparkTurnConcurrencyGate {
  sequential: boolean;
}

interface SparkTurnDriverCapture {
  restart?: unknown;
  driverError?: unknown;
}

export async function runSparkDshTurn(input: RunSparkDshTurnInput): Promise<void> {
  const ctx = input.ctx;
  let handle: AgentHandle | undefined;
  let disposeExecutionService: (() => Promise<void>) | undefined;
  const captured: SparkTurnDriverCapture = {};
  const cancelAgent = (): void => {
    handle?.agent.cancel({ kind: "user" });
  };
  try {
    // Cordis services are context-global unless their isolation label is
    // changed explicitly. Mount one active provider fiber per Invocation, then
    // join that label from the Agent scope so dependency-injected plugins can
    // consume ctx.sparkExecution without colliding with concurrent Agents.
    const executionLabel = Symbol("sparkExecution");
    const executionFiber = await ctx.isolate("sparkExecution", executionLabel).plugin({
      name: `spark-execution/${randomUUID()}`,
      provide: "sparkExecution",
      apply(providerCtx: Context) {
        providerCtx.provide("sparkExecution", input.execution);
      },
    });
    disposeExecutionService = executionFiber.dispose;
    const registeredNames = new Set(input.tools.map((tool) => tool.name));
    const parallelSafeNames = new Set(
      input.tools.filter((tool) => tool.parallelSafe).map((tool) => tool.name),
    );
    const concurrency: SparkTurnConcurrencyGate = { sequential: false };
    const driverProvider = `${SPARK_TURN_PROVIDER}/${randomUUID()}`;
    const setup = async (agentCtx: Context): Promise<void> => {
      const executionCtx = agentCtx.isolate("sparkExecution", executionLabel);
      if (!persisted && input.sessionMetadata) {
        const agent = executionCtx.agent;
        if (!agent) throw new Error("DSH Agent setup is missing its scoped Agent");
        appendSparkSessionMetadata(agent.session, input.sessionMetadata);
      }
      installSparkHangTimeoutPlugin(executionCtx, input.streamIdleTimeoutMs);
      installSparkConsentPlugin(executionCtx, input.hooks, registeredNames);
      installSparkHostGuardPlugin(executionCtx, (signal) => {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        }
      });
      executionCtx.on("agent/error", (payload) => {
        captured.driverError ??= payload.error;
      });
      executionCtx.llm.registerAdapter(
        [driverProvider],
        new SparkTurnLlmAdapter(
          driverProvider,
          input.llm,
          input.hooks,
          input.signal,
          executionCtx,
          registeredNames,
          parallelSafeNames,
          concurrency,
          captured,
        ),
      );
      for (const tool of input.tools) {
        executionCtx.tools.register(sparkHostToolDefinition(tool, input.hooks, concurrency));
      }
      for (const plugin of input.agentPlugins ?? []) {
        await executionCtx.plugin(plugin);
      }
      installNativeDshToolResultProjection(executionCtx, input.hooks, registeredNames);
    };
    const sessionId = SessionId(input.sessionId);
    const persistence = ctx.get("sessionPersistence");
    const persisted =
      persistence?.supportsRawArtifacts === true
        ? await persistence.readRaw(sessionId, input.signal)
        : undefined;
    handle = persisted
      ? await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: driverProvider, model: driverProvider },
          signal: input.signal,
          setup,
        })
      : await ctx.agents.create({
          sessionId,
          agentOptions: { provider: driverProvider, model: driverProvider },
          ...(isAbsolutePath(input.cwd) ? { meta: { cwd: input.cwd } } : {}),
          signal: input.signal,
          setup,
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
    await handle.agent.ctx.sessions.flush(handle.agent.session);
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
    await disposeExecutionService?.().catch(() => undefined);
  }
}

function appendSparkSessionMetadata(
  session: AgentHandle["agent"]["session"],
  metadata: SparkDshSessionMetadata,
): void {
  (session as unknown as { append(type: string, data: unknown): unknown }).append(
    "spark/meta",
    metadata,
  );
}

export function installSparkConsentPlugin(
  ctx: Context,
  hooks: SparkTurnDriverHooks,
  sparkHostTools: ReadonlySet<string> = new Set(),
): void {
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!hooks.preExecute) return next();
    const args = isPlainRecord(exec.arguments) ? exec.arguments : {};
    const registration: SparkTurnToolRegistration = sparkHostTools.has(exec.name)
      ? { owner: "spark-host" }
      : {
          owner: "dsh",
          callId: String(exec.callId),
          policy: sparkDshToolPolicy(ctx, exec.name, exec.agent),
        };
    const decision = await hooks.preExecute(exec.name, args, exec.signal, registration);
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
  private readonly driverProvider: string;
  private readonly llm: SparkTurnLlm;
  private readonly hooks: SparkTurnDriverHooks;
  private readonly signal: AbortSignal;
  private readonly ctx: Context;
  private readonly registeredNames: Set<string>;
  private readonly parallelSafeNames: Set<string>;
  private readonly concurrency: SparkTurnConcurrencyGate;
  private readonly captured: SparkTurnDriverCapture;

  constructor(
    driverProvider: string,
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
    this.driverProvider = driverProvider;
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
    if (!isAgentLoopRequest(options)) {
      const activeModel = this.hooks.resolveAuxiliaryModel?.();
      if (!activeModel) {
        throw new LlmError("Spark auxiliary model route is unavailable", "NO_ADAPTER");
      }
      const usesDriverRoute = options.provider === this.driverProvider;
      const explicit = usesDriverRoute ? decodeSparkAuxiliaryModelRoute(options.model) : undefined;
      const provider =
        explicit?.provider || (usesDriverRoute ? activeModel.provider : options.provider);
      const model =
        explicit?.model ??
        (usesDriverRoute && options.model === this.driverProvider ? activeModel.id : options.model);
      const maxTokens =
        options.maxTokens === undefined
          ? activeModel.maxTokens
          : Math.min(options.maxTokens, activeModel.maxTokens);
      yield* this.llm.stream({ ...options, provider, model, maxTokens });
      return;
    }
    await this.hooks.onRoundtrip?.();
    const assembled = await this.hooks.assemble();
    const composition = mergeNativeDshComposition(
      assembled.context,
      options,
      this.ctx,
      this.registeredNames,
      this.hooks,
    );
    const prepared = this.hooks.prepareRequest
      ? await this.hooks.prepareRequest(assembled, composition.context, composition.tools)
      : {
          context: composition.context,
          requestedOutputTokens: assembled.requestedOutputTokens,
        };
    const cacheKey = readPromptCacheKey(prepared.context);
    const generate = sparkContextToGenerateOptions(assembled.model, prepared.context, {
      signal: options.signal ?? this.signal,
      maxTokens: prepared.requestedOutputTokens,
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
          yield* dshChunksFromAssistant(event.message);
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
    // A Cordis-native plugin owns this name in the Agent scope. Do not shadow
    // it with the compatibility dispatcher after the model selects it.
    if (this.ctx.tools.get(name, this.ctx.agent)) return;
    this.registeredNames.add(name);
    this.ctx.tools.register(
      sparkHostToolDefinition({ name, description: name }, this.hooks, this.concurrency),
    );
  }
}

function decodeSparkAuxiliaryModelRoute(
  value: string,
): { provider?: string; model: string } | undefined {
  if (!value.startsWith(SPARK_AUXILIARY_MODEL_PREFIX)) return undefined;
  const encoded = value.slice(SPARK_AUXILIARY_MODEL_PREFIX.length);
  const separator = encoded.indexOf("/");
  if (separator < 0) return undefined;
  try {
    const provider = decodeURIComponent(encoded.slice(0, separator));
    const model = decodeURIComponent(encoded.slice(separator + 1));
    return model ? { ...(provider ? { provider } : {}), model } : undefined;
  } catch {
    return undefined;
  }
}

function mergeNativeDshComposition(
  context: PiContext,
  options: GenerateOptions,
  ctx: Context,
  sparkHostTools: ReadonlySet<string>,
  hooks: SparkTurnDriverHooks,
): { context: PiContext; tools: SparkDshToolDescriptor[] } {
  const existingTools = context.tools ?? [];
  const existingNames = new Set(existingTools.map((tool) => tool.name));
  const nativeTools = (options.tools ?? []).flatMap((schema): SparkDshToolDescriptor[] => {
    if (sparkHostTools.has(schema.name) || existingNames.has(schema.name)) return [];
    const policy = sparkDshToolPolicy(ctx, schema.name, ctx.agent);
    if (hooks.isDshToolAvailable?.(schema.name, policy) === false) return [];
    return [{ schema, policy }];
  });
  if (nativeTools.length === 0) return { context, tools: [] };
  const systemPrompt = joinPromptSections(context.systemPrompt, options.system);
  return {
    context: {
      ...context,
      ...(systemPrompt ? { systemPrompt } : {}),
      tools: [...existingTools, ...nativeTools.map((entry) => dshSchemaToPiTool(entry.schema))],
    } as PiContext,
    tools: nativeTools,
  };
}

function dshSchemaToPiTool(schema: ToolSchema): Tool {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
  } as Tool;
}

function joinPromptSections(primary: string | undefined, secondary: string | undefined): string {
  const sections = [primary?.trim(), secondary?.trim()].filter((section): section is string =>
    Boolean(section),
  );
  return [...new Set(sections)].join("\n\n");
}

function sparkDshToolPolicy(
  ctx: Context,
  name: string,
  scope: unknown,
): SparkDshToolPolicyMetadata | undefined {
  const definition = ctx.tools.get(name, scope as Parameters<typeof ctx.tools.get>[1]);
  return (definition as { sparkPolicy?: SparkDshToolPolicyMetadata } | undefined)?.sparkPolicy;
}

function installNativeDshToolResultProjection(
  ctx: Context,
  hooks: SparkTurnDriverHooks,
  sparkHostTools: ReadonlySet<string>,
): void {
  const callNames = new Map<string, string>();
  ctx.on("session/event", (_session, event) => {
    if (event.type === "tool/call") {
      callNames.set(String(event.data.callId), event.data.name);
      return;
    }
    if (event.type !== "tool/result") return;
    const callId = String(event.data.message.source.callId);
    const name = callNames.get(callId);
    callNames.delete(callId);
    if (!name || sparkHostTools.has(name)) return;
    hooks.onToolResult?.(sparkToolResultFromDsh(event.data.message, name, event.data.meta));
  });
}

function sparkToolResultFromDsh(
  message: DshToolResultMessage,
  toolName: string,
  meta: unknown,
): ToolResultMessage {
  const block = message.content[0];
  const content = block.content.flatMap((part) => {
    if (part.type === "text") return [{ type: "text" as const, text: part.text }];
    if (part.type === "image") {
      return [
        {
          type: "text" as const,
          text: `[DSH image attachment ${String(part.attachment.attachmentId)}]`,
        },
      ];
    }
    return [];
  });
  return {
    role: "toolResult",
    toolCallId: String(block.toolCallId),
    toolName,
    content,
    ...(meta !== undefined ? { details: meta } : parsedJsonDetails(content)),
    isError: Boolean(block.isError),
    timestamp: Date.now(),
  };
}

function parsedJsonDetails(content: readonly { type: "text"; text: string }[]): {
  details?: Record<string, unknown>;
} {
  if (content.length !== 1) return {};
  try {
    const value: unknown = JSON.parse(content[0]?.text ?? "");
    return isPlainRecord(value) ? { details: value } : {};
  } catch {
    return {};
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
  const hasToolCalls = message.content.some((part) => part.type === "toolCall");
  const kind = hasToolCalls
    ? "tool-calls"
    : message.stopReason === "length"
      ? "max-tokens"
      : "stop";
  yield { type: "finish", reason: { kind } };
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
