import assert from "node:assert/strict";
import { test } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ResolvedSubagentStartRequest, SubagentProvider } from "@deepseek-ai/dsh-subagent";

import {
  apply,
  createSparkSessionSubagentProviders,
  createUnavailableSparkSubagentHost,
  inject,
  name,
  roleRefFromDshRequest,
  type SparkSubagentHost,
  type SparkSubagentHostStartRequest,
  type SparkSubagentRegistry,
} from "./subagent.ts";

function recordingHost(
  starts: SparkSubagentHostStartRequest[] = [],
  lifecycle: string[] = [],
): SparkSubagentHost {
  return {
    agentOptions: true,
    async start(input) {
      starts.push(input);
      return {
        sessionId: `sess_${starts.length}`,
        invocationId: `inv_${starts.length}`,
        result: Promise.resolve({
          output: [{ type: "text", text: "child result" }],
          stopReason: "completed",
        }),
        cancel(reason) {
          lifecycle.push(`cancel:${reason}`);
        },
        async waitForIdle() {
          lifecycle.push("idle");
        },
      };
    },
  };
}

function fakeRegistry(): {
  registry: SparkSubagentRegistry;
  providers: Map<string, SubagentProvider>;
} {
  const providers = new Map<string, SubagentProvider>();
  return {
    providers,
    registry: {
      registerProvider(provider) {
        providers.set(provider.name, provider);
        return () => providers.delete(provider.name);
      },
    },
  };
}

function request(
  input: Partial<ResolvedSubagentStartRequest> & { parentSessionId?: string } = {},
): ResolvedSubagentStartRequest {
  const parentSessionId = input.parentSessionId ?? "sess_admin";
  const parent = {
    id: SessionId(parentSessionId),
    options: {},
    session: {
      id: SessionId(parentSessionId),
      header: { delegationDepth: 0 },
    },
  } as unknown as Agent;
  return {
    prompt: [],
    parent,
    signal: new AbortController().signal,
    descriptor: { version: 3, mode: "one-shot", provider: "spawn" },
    ...input,
  } as ResolvedSubagentStartRequest;
}

test("registers spawn and fork providers with daemon AgentOptions support", () => {
  const providers = createSparkSessionSubagentProviders(recordingHost());
  assert.deepEqual(
    providers.map((provider) => [provider.name, provider.inheritsParentContext]),
    [
      ["spawn", false],
      ["fork", true],
    ],
  );
  assert.equal(providers[0]?.capabilities.agentOptions, true);
  assert.equal(providers[0]?.capabilities.persona, true);
});

test("start passes official AgentOptions and resolves the durable terminal result", async () => {
  const starts: SparkSubagentHostStartRequest[] = [];
  const lifecycle: string[] = [];
  const [spawn] = createSparkSessionSubagentProviders(recordingHost(starts, lifecycle));
  const run = await spawn!.start(
    request({
      persona: "reviewer",
      label: " Audit ",
      prompt: [{ type: "text", text: "Review the diff." }],
      agentOptions: {
        provider: "baidu-oneapi",
        model: "grok-4.6",
        reasoningEffort: "high" as never,
        maxTokens: 2048,
      },
    }),
  );
  assert.equal(String(run.id), "sess_1");
  assert.deepEqual(await run.result, {
    output: [{ type: "text", text: "child result" }],
    stopReason: "completed",
  });
  assert.deepEqual(
    starts.map(({ signal: _signal, descriptor: _descriptor, ...start }) => start),
    [
      {
        parentSessionId: "sess_admin",
        roleRef: "role:builtin-reviewer",
        mode: "spawn",
        name: "Audit",
        prompt: [{ type: "text", text: "Review the diff." }],
        agentOptions: {
          provider: "baidu-oneapi",
          model: "grok-4.6",
          reasoningEffort: "high",
          maxTokens: 2048,
        },
        delegationDepth: 1,
      },
    ],
  );
  await run.dispose();
  await run.dispose();
  assert.deepEqual(lifecycle, ["cancel:DSH subagent run disposed", "idle"]);
});

test("fork inherits context and enforces the official depth cap", async () => {
  const starts: SparkSubagentHostStartRequest[] = [];
  const fork = createSparkSessionSubagentProviders(recordingHost(starts))[1]!;
  await fork.start(request());
  assert.equal(starts[0]?.mode, "fork");
  assert.equal(starts[0]?.roleRef, "role:builtin-executor");
  await assert.rejects(async () => await fork.start(request({ maxDepth: 0 })), {
    name: "SparkSubagentError",
    code: "subagent_depth_exceeded",
  });
});

test("Web fallback advertises no AgentOptions and never creates a local child", async () => {
  const [spawn] = createSparkSessionSubagentProviders(createUnavailableSparkSubagentHost());
  assert.equal(spawn!.capabilities.agentOptions, false);
  await assert.rejects(async () => await spawn!.start(request()), {
    name: "SparkSubagentError",
    code: "subagent_execution_unavailable",
  });
});

test("apply registers providers onto the official ctx.subagents service", async () => {
  const { registry, providers } = fakeRegistry();
  const ctx = new Context();
  ctx.provide("subagents", registry);
  apply(ctx, { host: recordingHost() });
  assert.equal(name, "spark-session-subagent");
  assert.deepEqual(inject, ["subagents"]);
  assert.deepEqual([...providers.keys()], ["spawn", "fork"]);
  await ctx.fiber.dispose();
});

test("roleRefFromDshRequest maps supported persona aliases onto Role refs", () => {
  assert.equal(roleRefFromDshRequest({}), "role:builtin-executor");
  assert.equal(roleRefFromDshRequest({ persona: "explorer" }), "role:builtin-explorer");
  assert.equal(
    roleRefFromDshRequest({ persona: "role:builtin-reviewer" }),
    "role:builtin-reviewer",
  );
  assert.throws(() => roleRefFromDshRequest({ persona: "you" }), {
    name: "SparkSubagentError",
    code: "invalid_role_ref",
  });
});
