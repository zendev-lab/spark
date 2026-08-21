import assert from "node:assert/strict";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CodeRuntime } from "@deepseek-ai/dsh-code-runtime";
import type { CodeRunRequest, CodeRunResult } from "@deepseek-ai/dsh-code-runtime";
import { CallId, HarnessError } from "@deepseek-ai/dsh-llm";
import { escalationHintMarker, sandboxDenialMarker } from "@deepseek-ai/dsh-sandbox";
import SandboxPolicyService, { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { bindScopeParent, createScope } from "@deepseek-ai/dsh-scope";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import ApprovalService, { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { test } from "vitest";

import {
  normalizeEscalationArguments,
  projectEscalationParameters,
  startSandboxEscalationCompatibility,
  viableEscalationTargets,
} from "./sandbox-escalation-compat.ts";

class FakeRuntime extends CodeRuntime {
  readonly language = "typescript";
  readonly isolation = "fake";

  run(_request: CodeRunRequest): Promise<CodeRunResult> {
    return Promise.resolve({ logs: [] });
  }
}

class FsDeniedError extends HarnessError {
  constructor() {
    super(
      `${sandboxDenialMarker("danger-full-access")}\n${escalationHintMarker("operation")}`,
      "FS_SANDBOX_DENIED",
    );
  }
}

function targetTool(
  name: "write" | "edit",
  seen: unknown[],
  execute?: ToolDefinition["execute"],
): ToolDefinition {
  return {
    name,
    description: `${name} a file`,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
        sandbox_permissions: {
          type: "string",
          enum: ["workspace-write", "danger-full-access"],
        },
        justification: { type: "string" },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value as string }],
    },
    execute:
      execute ??
      ((args): Promise<unknown> => {
        seen.push(args);
        return Promise.resolve("ok");
      }),
  };
}

async function scopedAgent(ctx: Context, presetKey: object, id: string): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(id));
  const agentKey = { id: session.id } as Agent;
  let agentScope!: ReturnType<typeof createScope>;
  await ctx.plugin(
    Object.assign(
      (inner: Context) => {
        agentScope = createScope(inner, agentKey);
        bindScopeParent(agentKey, presetKey);
      },
      { inject: ["tools"] },
    ),
  );
  return Object.assign(agentKey, {
    session,
    ctx: agentScope.ctx,
    options: {},
    inbox: {},
    status: "idle" as const,
  }) as Agent;
}

async function harness(options?: { executeWrite?: ToolDefinition["execute"] }): Promise<{
  ctx: Context;
  agent: Agent;
  seen: unknown[];
  replaceTarget(name: "write" | "edit", definition: ToolDefinition): void;
}> {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SandboxPolicyService, { mode: "danger-full-access" });
  await ctx.plugin(ApprovalService, { policy: "never" });
  ctx.effect(
    () => startSandboxEscalationCompatibility(ctx),
    "spark-web-dsh.sandbox-escalation-compatibility.test()",
  );

  const seen: unknown[] = [];
  const presetKey = { preset: "test" };
  const targetDisposers = new Map<"write" | "edit", () => void>();
  let presetScope!: ReturnType<typeof createScope>;
  await ctx.plugin(
    Object.assign(
      (inner: Context) => {
        presetScope = createScope(inner, presetKey);
        targetDisposers.set(
          "write",
          presetScope.ctx.tools.register(targetTool("write", seen, options?.executeWrite)),
        );
        targetDisposers.set("edit", presetScope.ctx.tools.register(targetTool("edit", seen)));
      },
      { inject: ["tools"] },
    ),
  );
  const agent = await scopedAgent(ctx, presetKey, "sandbox-compat-agent");
  ctx.agents.register(agent);
  return {
    ctx,
    agent,
    seen,
    replaceTarget(name, definition): void {
      targetDisposers.get(name)?.();
      targetDisposers.set(name, presetScope.ctx.tools.register(definition));
    },
  };
}

function properties(definition: ToolDefinition): Record<string, unknown> {
  return definition.parameters.properties as Record<string, unknown>;
}

test("projects escalation fields from the live session policy", async () => {
  const { ctx, agent } = await harness();
  try {
    for (const name of ["write", "edit"]) {
      assert.equal(properties(ctx.tools.get(name, agent)!).sandbox_permissions, undefined);
      assert.equal(properties(ctx.tools.get(name, agent)!).justification, undefined);
    }

    setSandboxMode(agent.session, "workspace-write");
    setApprovalPolicy(agent.session, "ask");
    assert.deepEqual(
      (properties(ctx.tools.get("write", agent)!).sandbox_permissions as { enum: string[] }).enum,
      ["danger-full-access"],
    );

    setSandboxMode(agent.session, "read-only");
    assert.deepEqual(
      (properties(ctx.tools.get("write", agent)!).sandbox_permissions as { enum: string[] }).enum,
      ["workspace-write", "danger-full-access"],
    );

    setApprovalPolicy(agent.session, "never");
    assert.equal(properties(ctx.tools.get("write", agent)!).sandbox_permissions, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("normalizes only redundant same-mode escalation arguments", async () => {
  const { ctx, agent, seen } = await harness();
  try {
    const result = await ctx.tools.execute({
      callId: CallId("same-mode"),
      name: "write",
      arguments: {
        value: "x",
        sandbox_permissions: "danger-full-access",
        justification: "the session already grants it",
      },
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(seen, [{ value: "x" }]);
    assert.deepEqual(
      normalizeEscalationArguments(
        {
          sandbox_permissions: "workspace-write",
          justification: "this is a downgrade",
        },
        "danger-full-access",
      ),
      {
        sandbox_permissions: "workspace-write",
        justification: "this is a downgrade",
      },
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test("projects the exact-scope schema into the Code Mode SDK", async () => {
  const { ctx, agent } = await harness();
  try {
    await ctx.plugin(FakeRuntime);
    const restore = agent.ctx.tools.presentAs("code");
    const sdk = (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(
      (section) => section.name === "tools:sdk",
    )?.text;
    restore();
    assert.match(sdk ?? "", /write: \{/u);
    assert.doesNotMatch(sdk ?? "", /sandbox_permissions|justification/u);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("mirrors exact-scope restrictions and restores projected tools", async () => {
  const { ctx, agent } = await harness();
  try {
    const lift = agent.ctx.tools.restrict({ allow: ["edit"] });
    assert.equal(ctx.tools.get("write", agent), undefined);
    lift();
    assert.equal(properties(ctx.tools.get("write", agent)!).sandbox_permissions, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("re-resolves a target replaced after the agent is registered", async () => {
  const instance = await harness();
  const { ctx, agent, seen } = instance;
  const replacementSeen: unknown[] = [];
  try {
    instance.replaceTarget("write", targetTool("write", replacementSeen));
    const result = await ctx.tools.execute({
      callId: CallId("replacement"),
      name: "write",
      arguments: { value: "new" },
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    assert.deepEqual(seen, []);
    assert.deepEqual(replacementSeen, [{ value: "new" }]);
    assert.equal(properties(ctx.tools.get("write", agent)!).sandbox_permissions, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test("removes impossible escalation advice from filesystem denials", async () => {
  const { ctx, agent } = await harness({
    executeWrite: () => Promise.reject(new FsDeniedError()),
  });
  try {
    const result = await ctx.tools.execute({
      callId: CallId("denied"),
      name: "write",
      arguments: { value: "x" },
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, true);
    if (!result.isError) throw new Error("expected a denied tool result");
    assert.doesNotMatch(result.error.message, /escalation available/u);
    assert.doesNotMatch(
      result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
      /escalation available/u,
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test("pure projection is immutable and uses only viable wider modes", () => {
  const source = {
    type: "object",
    properties: {
      value: { type: "string" },
      sandbox_permissions: {
        type: "string",
        enum: ["workspace-write", "danger-full-access"],
      },
      justification: { type: "string" },
    },
  };
  const hidden = projectEscalationParameters(source, []);
  assert.equal((hidden.properties as Record<string, unknown>).sandbox_permissions, undefined);
  assert.deepEqual(viableEscalationTargets("workspace-write", "ask"), ["danger-full-access"]);
  assert.deepEqual(source.properties.sandbox_permissions.enum, [
    "workspace-write",
    "danger-full-access",
  ]);
});
