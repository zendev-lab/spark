import assert from "node:assert/strict";
import { test } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  CallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";
import {
  createSparkInvocationService,
  type SparkDshToolPolicyMetadata,
} from "@zendev-lab/spark-core";
import type {
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@zendev-lab/spark-llm";

import {
  encodeSparkAuxiliaryModelRoute,
  installSparkConsentPlugin,
  runSparkDshTurn,
} from "./dsh-turn-driver.ts";

class ScriptedAdapter extends LlmAdapter {
  calls = 0;

  override providerInfo(provider: string) {
    return { id: provider, name: provider };
  }

  async *stream() {
    this.calls += 1;
    if (this.calls === 1) {
      const id = CallId("call-ping-1");
      yield { type: "block-start" as const, index: 0, blockType: "tool-call" as const };
      yield {
        type: "tool-call-delta" as const,
        index: 0,
        id,
        name: "ping",
        argumentsDelta: "{}",
      };
      yield {
        type: "block-end" as const,
        index: 0,
        block: { type: "tool-call" as const, id, name: "ping", arguments: "{}" },
      };
      yield { type: "usage" as const, usage: { inputTokens: 8, outputTokens: 4 } };
      yield { type: "finish" as const, reason: { kind: "tool-calls" as const } };
      return;
    }
    yield { type: "block-start" as const, index: 0, blockType: "text" as const };
    yield { type: "text-delta" as const, index: 0, text: "pong from dsh-agent-loop" };
    yield {
      type: "block-end" as const,
      index: 0,
      block: { type: "text" as const, text: "pong from dsh-agent-loop" },
    };
    yield { type: "usage" as const, usage: { inputTokens: 12, outputTokens: 6 } };
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }
}

async function mountLoop(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore);
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
}

test("dsh-agent-loop drives a scripted ping tool to a terminal assistant message", async () => {
  const events: string[] = [];
  const ctx = new Context();
  await mountLoop(ctx);
  ctx.llm.registerAdapter(["scripted"], new ScriptedAdapter());
  ctx.tools.register(
    defineTool({
      name: "ping",
      description: "Return a fixed pong payload.",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          return [{ type: "text", text: JSON.stringify(value) }];
        },
      },
      async execute() {
        return { ok: true, from: "spark-tool" };
      },
    }),
  );
  ctx.on("session/event", (_session, event) => {
    events.push(event.type);
  });
  const handle = await ctx.agents.create({
    sessionId: SessionId("spark-turn-spike"),
    agentOptions: { provider: "scripted", model: "scripted-model" },
  });
  handle.agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "ping once" }],
      source: { kind: "user" },
    }),
  );
  await handle.agent.whenIdle();
  await handle.dispose();
  await ctx.fiber.dispose();
  assert.ok(events.includes("tool/result"));
  assert.ok(events.includes("assistant/message"));
});

test("Spark consent plugin denies a tool before execute", async () => {
  let executed = false;
  const events: string[] = [];
  const ctx = new Context();
  await mountLoop(ctx);
  installSparkConsentPlugin(ctx, {
    assemble: async () => {
      throw new Error("unused");
    },
    dispatchToolCall: async () => {
      throw new Error("unused");
    },
    promptItems: () => [],
    roundtrips: () => 1,
    preExecute: async () => ({ kind: "deny", reason: "blocked by spark" }),
  });
  ctx.llm.registerAdapter(["scripted"], new ScriptedAdapter());
  ctx.tools.register(
    defineTool({
      name: "ping",
      description: "Return a fixed pong payload.",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          return [{ type: "text", text: JSON.stringify(value) }];
        },
      },
      async execute() {
        executed = true;
        return { ok: true };
      },
    }),
  );
  ctx.on("session/event", (_session, event) => {
    events.push(event.type);
  });
  const handle = await ctx.agents.create({
    sessionId: SessionId("spark-turn-deny"),
    agentOptions: { provider: "scripted", model: "scripted-model" },
  });
  handle.agent.followup(
    createUserMessage({
      content: [{ type: "text", text: "ping once" }],
      source: { kind: "user" },
    }),
  );
  await handle.agent.whenIdle();
  await handle.dispose();
  await ctx.fiber.dispose();
  assert.equal(executed, false);
  assert.ok(events.includes("tool/result"));
});

test("runSparkDshTurn rejects pre-start cancellation without reserving a Turn", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  const events: string[] = [];
  ctx.on("session/event", (_session, event) => events.push(event.type));
  const controller = new AbortController();
  controller.abort(new Error("cancel before admission"));
  const invocation = createSparkInvocationService({
    cwd: "/tmp",
    sessionId: "pre-start-cancel",
    invocationId: "inv_pre_start_cancel",
    attempt: {
      epoch: 1,
      daemonGeneration: 1,
      correlationId: "attempt:inv_pre_start_cancel:1",
    },
    signal: controller.signal,
  });

  try {
    await assert.rejects(
      runSparkDshTurn({
        ctx,
        llm: {
          stream() {
            throw new Error("LLM must not start");
          },
        },
        sessionId: "pre-start-cancel",
        invocation,
        followupText: "do not start",
        tools: [],
        streamIdleTimeoutMs: 0,
        signal: controller.signal,
        hooks: {
          assemble: async () => {
            throw new Error("turn assembly must not start");
          },
          dispatchToolCall: async () => {
            throw new Error("tool dispatch must not start");
          },
          promptItems: () => [],
          roundtrips: () => 0,
        },
      }),
      /cancel before admission/,
    );
    assert.deepEqual(events, []);
    assert.deepEqual(ctx.agents.list(), []);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("runSparkDshTurn starts no model work when the Invocation reservation cannot persist", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  const events: string[] = [];
  let llmCalls = 0;
  ctx.on("session/event", (_session, event) => events.push(event.type));
  ctx.on("session/flush", async () => {
    throw new Error("reservation persistence failed");
  });
  const controller = new AbortController();

  try {
    await assert.rejects(
      runSparkDshTurn({
        ctx,
        llm: {
          stream() {
            llmCalls += 1;
            throw new Error("LLM must not start");
          },
        },
        sessionId: "reservation-persistence-failure",
        invocation: createSparkInvocationService({
          cwd: "/tmp",
          sessionId: "reservation-persistence-failure",
          invocationId: "inv_reservation_persistence_failure",
          attempt: {
            epoch: 1,
            daemonGeneration: 1,
            correlationId: "attempt:inv_reservation_persistence_failure:1",
          },
          signal: controller.signal,
        }),
        followupText: "do not start",
        tools: [],
        streamIdleTimeoutMs: 0,
        signal: controller.signal,
        hooks: {
          assemble: async () => {
            throw new Error("turn assembly must not start");
          },
          dispatchToolCall: async () => {
            throw new Error("tool dispatch must not start");
          },
          promptItems: () => [],
          roundtrips: () => 0,
        },
      }),
      /reservation persistence failed/,
    );
    assert.equal(llmCalls, 0);
    assert.equal(events.filter((event) => event === "spark/invocation").length, 1);
    assert.equal(events.includes("turn/start"), false);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("runSparkDshTurn starts no model work without a Session persistence owner", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  let llmCalls = 0;
  const controller = new AbortController();

  try {
    await assert.rejects(
      runSparkDshTurn({
        ctx,
        llm: {
          stream() {
            llmCalls += 1;
            throw new Error("LLM must not start");
          },
        },
        sessionId: "reservation-persistence-missing",
        invocation: createSparkInvocationService({
          cwd: "/tmp",
          sessionId: "reservation-persistence-missing",
          invocationId: "inv_reservation_persistence_missing",
          attempt: {
            epoch: 1,
            daemonGeneration: 1,
            correlationId: "attempt:inv_reservation_persistence_missing:1",
          },
          signal: controller.signal,
        }),
        followupText: "do not start",
        tools: [],
        streamIdleTimeoutMs: 0,
        signal: controller.signal,
        hooks: {
          assemble: async () => {
            throw new Error("turn assembly must not start");
          },
          dispatchToolCall: async () => {
            throw new Error("tool dispatch must not start");
          },
          promptItems: () => [],
          roundtrips: () => 0,
        },
      }),
      /has no Session persistence owner/,
    );
    assert.equal(llmCalls, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("runSparkDshTurn starts no model work when cancellation arrives during reservation flush", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  const controller = new AbortController();
  const events: string[] = [];
  let llmCalls = 0;
  ctx.on("session/event", (_session, event) => events.push(event.type));
  ctx.on("session/flush", async () => {
    controller.abort(new Error("abort during reservation flush"));
  });

  try {
    await assert.rejects(
      runSparkDshTurn({
        ctx,
        llm: {
          stream() {
            llmCalls += 1;
            throw new Error("LLM must not start");
          },
        },
        sessionId: "reservation-flush-cancellation",
        invocation: createSparkInvocationService({
          cwd: "/tmp",
          sessionId: "reservation-flush-cancellation",
          invocationId: "inv_reservation_flush_cancellation",
          attempt: {
            epoch: 1,
            daemonGeneration: 1,
            correlationId: "attempt:inv_reservation_flush_cancellation:1",
          },
          signal: controller.signal,
        }),
        followupText: "do not start",
        tools: [],
        streamIdleTimeoutMs: 0,
        signal: controller.signal,
        hooks: {
          assemble: async () => {
            throw new Error("turn assembly must not start");
          },
          dispatchToolCall: async () => {
            throw new Error("tool dispatch must not start");
          },
          promptItems: () => [],
          roundtrips: () => 0,
        },
      }),
      /abort during reservation flush/,
    );
    assert.equal(llmCalls, 0);
    assert.equal(events.filter((event) => event === "spark/invocation").length, 1);
    assert.equal(events.includes("turn/start"), false);
    assert.equal(events.includes("user/message"), false);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("runSparkDshTurn composes and projects a Cordis-native tool", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  const requests: GenerateOptions[] = [];
  const projectedResults: ToolResultMessage[] = [];
  const messages: Message[] = [
    { role: "user", content: "run native probe", timestamp: Date.now() },
  ];
  const registrations: unknown[] = [];
  let executions = 0;
  const model: Model<string> = {
    id: "native-probe-model",
    name: "Native probe model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 2_000,
  };
  const policy = Object.freeze({
    effect: "read",
    executionMode: "sequential",
    domains: ["test"],
    approval: "required",
    reconcile: "none",
  } as const satisfies SparkDshToolPolicyMetadata);
  const nativePlugin = {
    name: "native-probe-plugin",
    apply(agentCtx: Context) {
      const tool = {
        ...defineTool({
          name: "native_probe",
          description: "Run the native probe.",
          parameters: { value: { type: "string", required: true } },
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          async execute(args) {
            executions += 1;
            return { ok: true, args };
          },
        }),
        sparkPolicy: policy,
      };
      agentCtx.tools.register(tool);
      agentCtx.systemPrompt.section({
        name: "tool:native-probe",
        order: 120,
        text: "Native probe guidance.",
      });
    },
  };
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      const requestIndex = requests.length;
      return (async function* () {
        if (requestIndex === 1) {
          const id = CallId("native-probe-call");
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: 0,
            id,
            name: "native_probe",
            argumentsDelta: '{"value":"ok"}',
          };
          yield {
            type: "block-end",
            index: 0,
            block: {
              type: "tool-call",
              id,
              name: "native_probe",
              arguments: '{"value":"ok"}',
            },
          };
          yield { type: "finish", reason: { kind: "tool-calls" } };
          return;
        }
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "native complete" };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: "native complete" },
        };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };

  try {
    await runSparkDshTurn({
      ctx,
      llm,
      sessionId: "spark-turn-native-probe",
      agentPlugins: [nativePlugin],
      followupText: "run native probe",
      tools: [],
      streamIdleTimeoutMs: 0,
      signal: new AbortController().signal,
      hooks: {
        assemble: async () => ({
          model,
          context: { systemPrompt: "Spark prompt.", messages: [...messages], tools: [] },
          requestedOutputTokens: 1_000,
        }),
        dispatchToolCall: async () => {
          throw new Error("native tool must not dispatch through SparkHostAPI");
        },
        onAssistant: (assistant) => {
          messages.push(assistant as AssistantMessage);
        },
        onToolResult: (result) => {
          projectedResults.push(result);
          messages.push(result);
        },
        preExecute: async (_name, _args, _signal, registration) => {
          registrations.push(registration);
          return { kind: "allow" };
        },
        isDshToolAvailable: (_name, candidate) => candidate === policy,
        collectToolCalls: (assistant) =>
          (assistant as AssistantMessage).content.filter(
            (part): part is ToolCall => part.type === "toolCall",
          ),
        promptItems: () => [],
        roundtrips: () => requests.length,
      },
    });
  } finally {
    await ctx.fiber.dispose();
  }

  assert.equal(
    executions,
    1,
    JSON.stringify({ requests: requests.length, registrations, projectedResults }),
  );
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.tools?.some((tool) => tool.name === "native_probe"),
    true,
  );
  assert.match(requests[0]?.system ?? "", /Native probe guidance/);
  assert.deepEqual(registrations, [{ owner: "dsh", callId: "native-probe-call", policy }]);
  assert.equal(projectedResults[0]?.toolName, "native_probe");
  assert.equal(projectedResults[0]?.isError, false);
  assert.match(
    projectedResults[0]?.content[0]?.type === "text" ? projectedResults[0].content[0].text : "",
    /"ok":true/,
  );
  assert.equal(
    requests[1]?.messages.some((message) =>
      message.content.some((part) => part.type === "tool-result"),
    ),
    true,
  );
});

test("Cordis-native tools can make bounded DSH LLM calls through the private driver route", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  const requests: GenerateOptions[] = [];
  const messages: Message[] = [{ role: "user", content: "run auxiliary probe", timestamp: 1 }];
  const model: Model<string> = {
    id: "active-model",
    name: "Active model",
    api: "openai-completions",
    provider: "active-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  const policy = Object.freeze({
    effect: "read",
    executionMode: "sequential",
    domains: ["test"],
    approval: "none",
    reconcile: "none",
  } as const satisfies SparkDshToolPolicyMetadata);
  const plugin = {
    name: "auxiliary-probe",
    apply(agentCtx: Context) {
      const tool = {
        ...defineTool({
          name: "auxiliary_probe",
          description: "Run one bounded auxiliary request.",
          parameters: {},
          output: {
            schema: { type: "object", additionalProperties: true },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          async execute(_args, exec) {
            let text = "";
            for await (const chunk of agentCtx.llm.stream({
              provider: exec.agent?.options.provider ?? "",
              model: encodeSparkAuxiliaryModelRoute("panel-model", "panel-provider"),
              system: "bounded auxiliary request",
              messages: [
                createUserMessage({
                  content: [{ type: "text", text: "probe" }],
                  source: { kind: "user" },
                }),
              ],
              maxTokens: 128,
              signal: exec.signal,
            })) {
              if (chunk.type === "text-delta") text += chunk.text;
            }
            return { text };
          },
        }),
        sparkPolicy: policy,
      };
      agentCtx.tools.register(tool);
    },
  };
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      const index = requests.length;
      return (async function* () {
        if (index === 1) {
          const id = CallId("auxiliary-probe-call");
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: 0,
            id,
            name: "auxiliary_probe",
            argumentsDelta: "{}",
          };
          yield {
            type: "block-end",
            index: 0,
            block: { type: "tool-call", id, name: "auxiliary_probe", arguments: "{}" },
          };
          yield { type: "finish", reason: { kind: "tool-calls" } };
          return;
        }
        const text = index === 2 ? "auxiliary result" : "outer complete";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };

  try {
    await runSparkDshTurn({
      ctx,
      llm,
      sessionId: "auxiliary-model-call",
      agentPlugins: [plugin],
      followupText: "run auxiliary probe",
      tools: [],
      streamIdleTimeoutMs: 0,
      signal: new AbortController().signal,
      hooks: {
        assemble: async () => ({
          model,
          context: { systemPrompt: "Spark prompt.", messages: [...messages], tools: [] },
          requestedOutputTokens: 1_000,
        }),
        resolveAuxiliaryModel: () => model,
        dispatchToolCall: async () => {
          throw new Error("Spark host tool dispatch is not expected");
        },
        onAssistant: (assistant) => {
          messages.push(assistant as AssistantMessage);
        },
        preExecute: async () => ({ kind: "allow" }),
        isDshToolAvailable: () => true,
        promptItems: () => [],
        roundtrips: () => 1,
      },
    });
  } finally {
    await ctx.fiber.dispose();
  }

  assert.equal(requests.length, 3);
  assert.deepEqual(
    {
      provider: requests[1]?.provider,
      model: requests[1]?.model,
      maxTokens: requests[1]?.maxTokens,
    },
    { provider: "panel-provider", model: "panel-model", maxTokens: 128 },
  );
  assert.equal(requests[1]?.system, "bounded auxiliary request");
});

test("runSparkDshTurn isolates sparkInvocation across concurrent Agents", async () => {
  const ctx = new Context();
  await mountLoop(ctx);
  ctx.on("session/flush", async () => undefined);
  const seen = new Set<string>();
  const model: Model<string> = {
    id: "concurrent-execution-model",
    name: "Concurrent execution model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 2_000,
  };
  const plugin = {
    name: "capture-concurrent-spark-invocation",
    inject: ["sparkInvocation"],
    apply(agentCtx: Context) {
      seen.add(agentCtx.sparkInvocation.sessionId);
    },
  };
  const llm = {
    stream() {
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "done" };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: "done" },
        };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
  const run = async (sessionId: string): Promise<void> => {
    const controller = new AbortController();
    const messages: Message[] = [
      { role: "user", content: `run ${sessionId}`, timestamp: Date.now() },
    ];
    await runSparkDshTurn({
      ctx,
      llm,
      sessionId,
      invocation: createSparkInvocationService({
        cwd: "/tmp",
        sessionId,
        invocationId: `inv_${sessionId}`,
        attempt: {
          epoch: 1,
          daemonGeneration: 1,
          correlationId: `attempt:inv_${sessionId}:1`,
        },
        signal: controller.signal,
      }),
      agentPlugins: [plugin],
      followupText: `run ${sessionId}`,
      tools: [],
      streamIdleTimeoutMs: 0,
      signal: controller.signal,
      hooks: {
        assemble: async () => ({
          model,
          context: { systemPrompt: "Spark prompt.", messages: [...messages], tools: [] },
          requestedOutputTokens: 1_000,
        }),
        dispatchToolCall: async () => {
          throw new Error("no tool call expected");
        },
        onAssistant: (assistant) => {
          messages.push(assistant as AssistantMessage);
        },
        promptItems: () => [],
        roundtrips: () => 1,
      },
    });
  };

  try {
    await Promise.all([run("concurrent-agent-a"), run("concurrent-agent-b")]);
  } finally {
    await ctx.fiber.dispose();
  }

  assert.deepEqual([...seen].sort(), ["concurrent-agent-a", "concurrent-agent-b"]);
});
