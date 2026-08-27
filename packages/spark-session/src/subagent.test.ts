import assert from "node:assert/strict";
import { test } from "vitest";

import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";

import {
  apply,
  createSparkSessionStoreSubagentHost,
  createSparkSessionSubagentProviders,
  inject,
  name,
  roleRefFromDshRequest,
  type SparkSubagentHost,
  type SparkSubagentRegistry,
  type SparkSubagentSendRequest,
  type SparkSubagentStartRequest,
  type SparkSubagentStartResult,
  type SparkSessionSubagentProvider,
} from "./subagent.ts";

function recordingHost(
  children: SparkSubagentStartRequest[] = [],
  sends: SparkSubagentSendRequest[] = [],
): SparkSubagentHost {
  return {
    async createChild(input) {
      children.push(input);
      return {
        sessionId: `sess_${children.length}`,
        roleRef: input.roleRef,
        mode: input.mode,
      } satisfies SparkSubagentStartResult;
    },
    async send(input) {
      sends.push(input);
      return { sessionId: input.sessionId, invocationId: `inv_${sends.length}` };
    },
  };
}

function fakeRegistry(): {
  registry: SparkSubagentRegistry;
  providers: Map<string, SparkSessionSubagentProvider>;
} {
  const providers = new Map<string, SparkSessionSubagentProvider>();
  return {
    providers,
    registry: {
      registerProvider(provider) {
        providers.set(provider.name, provider);
        return () => {
          providers.delete(provider.name);
        };
      },
    },
  };
}

test("registers spawn and fork providers on the official HOST", () => {
  const children: SparkSubagentStartRequest[] = [];
  const providers = createSparkSessionSubagentProviders(recordingHost(children));
  assert.deepEqual(
    providers.map((provider) => [provider.name, provider.inheritsParentContext]),
    [
      ["spawn", false],
      ["fork", true],
    ],
  );
  assert.equal(providers[0]?.capabilities.persona, true);
  assert.equal("prepareContinuable" in providers[0]!, false);
});

test("spawn start creates a Role-bound child and sends the prompt", async () => {
  const children: SparkSubagentStartRequest[] = [];
  const sends: SparkSubagentSendRequest[] = [];
  const [spawn] = createSparkSessionSubagentProviders(recordingHost(children, sends));
  const run = await spawn!.start({
    parent: { session: { id: " sess_admin " } },
    persona: "reviewer",
    label: " Audit ",
    prompt: [{ type: "text", text: " Review the diff. " }],
  });
  const settled = await run.result;
  assert.equal(String(run.id), "sess_1");
  assert.equal(run.localAgent, undefined);
  assert.equal(settled.stopReason, "completed");
  assert.match(settled.output[0]?.text ?? "", /session create\+send/);
  assert.match(settled.output[0]?.text ?? "", /inv_1/);
  assert.deepEqual(children, [
    {
      parentSessionId: "sess_admin",
      roleRef: "role:builtin-reviewer",
      mode: "spawn",
      name: "Audit",
    },
  ]);
  assert.deepEqual(sends, [
    {
      parentSessionId: "sess_admin",
      sessionId: "sess_1",
      body: "Review the diff.",
    },
  ]);
});

test("fork start keeps fork mode and maps a missing persona to builtin executor", async () => {
  const children: SparkSubagentStartRequest[] = [];
  const sends: SparkSubagentSendRequest[] = [];
  const providers = createSparkSessionSubagentProviders(recordingHost(children, sends));
  const fork = providers[1]!;
  await fork.start({ parent: { session: { id: "sess_admin" } } });
  assert.equal(children[0]?.mode, "fork");
  assert.equal(children[0]?.roleRef, "role:builtin-executor");
  assert.equal(sends.length, 0);
});

test("rejects a human persona and an empty parent identity before calling the host", async () => {
  const children: SparkSubagentStartRequest[] = [];
  const [spawn] = createSparkSessionSubagentProviders(recordingHost(children));
  await assert.rejects(
    async () => await spawn!.start({ parent: { session: { id: "sess_admin" } }, persona: "you" }),
    { name: "SparkSubagentError", code: "invalid_role_ref" },
  );
  await assert.rejects(
    async () => await spawn!.start({ parent: { session: { id: "  " } }, persona: "executor" }),
    { name: "SparkSubagentError", code: "invalid_parent_session" },
  );
  assert.equal(children.length, 0);
});

test("apply() registers providers onto ctx.subagents", async () => {
  const children: SparkSubagentStartRequest[] = [];
  const { registry, providers } = fakeRegistry();
  const ctx = new Context();
  ctx.provide("subagents", registry);
  apply(ctx, { host: recordingHost(children) });
  assert.equal(name, "spark-session-subagent");
  assert.deepEqual(inject, ["subagents"]);
  assert.deepEqual([...providers.keys()], ["spawn", "fork"]);
  const run = await providers.get("spawn")!.start({
    parent: { session: { id: "sess_admin" } },
    persona: "explorer",
  });
  assert.equal(String(run.id), "sess_1");
  await ctx.fiber.dispose();
});

test("DSH SessionStore host spawns a live child and send appends the prompt", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const host = createSparkSessionStoreSubagentHost(ctx);
  const parent = ctx.sessions.create();
  const started = await host.createChild({
    parentSessionId: String(parent.id),
    roleRef: "role:builtin-executor",
    mode: "spawn",
  });
  const child = ctx.sessions.get(SessionId(started.sessionId));
  assert.equal(started.mode, "spawn");
  assert.equal(child?.header.origin, "subagent");
  assert.equal(String(child?.header.parentSession), String(parent.id));
  await host.send({
    parentSessionId: String(parent.id),
    sessionId: started.sessionId,
    body: "Review the diff.",
  });
  assert.equal(
    child?.events.some(
      (event) =>
        event.type === "user/message" && JSON.stringify(event.data).includes("Review the diff."),
    ),
    true,
  );
  await ctx.fiber.dispose();
});

test("roleRefFromDshRequest maps persona aliases onto Role refs", () => {
  assert.equal(roleRefFromDshRequest({}), "role:builtin-executor");
  assert.equal(roleRefFromDshRequest({ persona: "explorer" }), "role:builtin-explorer");
  assert.equal(
    roleRefFromDshRequest({ persona: "role:builtin-reviewer" }),
    "role:builtin-reviewer",
  );
});
