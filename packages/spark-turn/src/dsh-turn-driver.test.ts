import assert from "node:assert/strict";
import { test } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { CallId, LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { defineTool } from "@deepseek-ai/dsh-tools";

import { installSparkConsentPlugin } from "./dsh-turn-driver.ts";

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
