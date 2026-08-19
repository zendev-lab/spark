import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ToolConfig } from "@zendev-lab/spark-core";
import { SparkSessionMailStore, sanitizeSessionMailScope } from "./index.ts";
import type {
  SparkSessionProjection,
  SparkSessionSendRequest,
  SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import { registerSparkSessionTool } from "./extension.ts";
import type { SparkSessionToolContext } from "./action-tool.ts";
import { workspaceSessionRecord } from "../../../test/support/session-fixtures.ts";

const NOW = "2026-07-13T00:00:00.000Z";

type SessionToolResult = Awaited<ReturnType<ToolConfig["execute"]>>;

async function sessionSendRpc(
  mailStore: SparkSessionMailStore,
  params: SparkSessionSendRequest,
  submitted?: SparkTurnSubmitResult,
) {
  const sent = await mailStore.send({
    toSessionId: params.toSessionId,
    fromSessionId: params.fromSessionId,
    kind: params.kind,
    intent: params.intent,
    payload: params.payload,
    idempotencyKey: params.idempotencyKey,
    body: params.body,
    source: params.source,
    ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.originBinding ? { originBinding: params.originBinding } : {}),
  });
  const message = submitted
    ? await mailStore.recordRequestAdmission(params.toSessionId, sent.message.id, submitted)
    : sent.message;
  return {
    message,
    filePath: sent.path,
    created: sent.created,
    executionTriggered: Boolean(submitted),
    target: sessionRecord(params.toSessionId),
    ...(submitted ? { submitted } : {}),
  };
}

test("session tool exposes explicit spawn/fork lifecycle and mail", () => {
  const tool = registerTestTool({
    request: async () => assert.fail("request should not run during registration"),
  });
  const schema = JSON.stringify(tool.parameters);
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
  assert.equal("scope" in properties, false);
  assert.ok("onActive" in properties);
  assert.match(JSON.stringify(properties.onActive), /queue/u);
  assert.match(JSON.stringify(properties.onActive), /interrupt/u);
  assert.ok("wake" in properties);
  for (const action of [
    "list",
    "get",
    "spawn",
    "fork",
    "bind",
    "unbind",
    "archive",
    "restore",
    "close",
    "send",
    "lookup",
    "wait",
    "inbox",
    "read",
    "ack",
  ]) {
    assert.match(schema, new RegExp(action));
  }
  assert.doesNotMatch(schema, /\bcreate\b/u);
  assert.doesNotMatch(schema, /\bcall\b/u);
  assert.equal("instruction" in properties, false);
  assert.equal("roleBinding" in properties, false);
  assert.ok("roleRef" in properties);
  assert.deepEqual(tool.resolvePolicy?.({ action: "list" }), {
    effect: "read",
    executionMode: "parallel",
    domains: ["sessions"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  });
  assert.deepEqual(tool.resolvePolicy?.({ action: "lookup" }), {
    effect: "read",
    executionMode: "parallel",
    domains: ["sessions"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  });
  assert.deepEqual(tool.resolvePolicy?.({ action: "wait" }), {
    effect: "read",
    executionMode: "parallel",
    domains: ["sessions"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  });
  assert.deepEqual(tool.resolvePolicy?.({ action: "spawn" }), {
    effect: "external_write",
    executionMode: "sequential",
    domains: ["sessions"],
    modes: ["plan", "execute"],
    approval: "none",
  });
  assert.match(tool.description, /Canonical scoped Session capability/u);
  assert.ok(tool.promptGuidelines?.length);
});

test("session tool routes managed actions through daemon RPC and classifies surfaces", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const records = new Map<string, SparkSessionProjection>([
    ["session:a", sessionRecord("session:a")],
    [
      "session:b",
      {
        ...sessionRecord("session:b"),
        activity: "running",
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            externalKey: "infoflow:user:b",
            boundAt: NOW,
          },
        ],
      },
    ],
  ]);
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    const input = (params ?? {}) as Record<string, unknown>;
    if (method === "workspace.ensure-local") return { id: "workspace:test" } as T;
    if (method === "session.list") return [...records.values()] as T;
    if (method === "session.get") return records.get(String(input.sessionId)) as T;
    if (method === "session.spawn" || method === "session.fork") {
      const record = {
        ...sessionRecord(method === "session.spawn" ? "session:spawned" : "session:forked", {
          title: typeof input.name === "string" ? input.name : undefined,
        }),
        roleBinding: { kind: "explicit" as const, roleRef: String(input.roleRef) },
        lineage: {
          kind: "child" as const,
          parentSessionId: String(input.supervisorSessionId),
          origin: { kind: "session" as const },
        },
      };
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.bind") {
      const current = records.get(String(input.sessionId))!;
      const record = {
        ...current,
        bindings: [
          {
            kind: "channel" as const,
            adapter: "infoflow" as const,
            externalKey: String(input.externalKey),
            boundAt: NOW,
          },
        ],
      };
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.unbind") {
      const current = records.get(String(input.sessionId))!;
      const record = { ...current, bindings: [] };
      records.set(record.sessionId, record);
      return record as T;
    }
    if (method === "session.archive") {
      const current = records.get(String(input.sessionId))!;
      const record = { ...current, placement: "archived" as const };
      records.set(record.sessionId, record);
      return record as T;
    }
    return assert.fail(`unexpected RPC method: ${method}`);
  };
  const tool = registerTestTool({ request });
  const ctx = context("session:a");

  const listed = await execute(tool, ctx, { action: "list", limit: 2 });
  const listedSessions = (
    listed.details as {
      sessions: Array<{
        sessionId: string;
        surface: string;
        activity: string;
        channelAdapters: string[];
      }>;
    }
  ).sessions;
  assert.deepEqual(
    listedSessions.map((session) => [session.sessionId, session.surface, session.activity]),
    [
      ["session:a", "local", "idle"],
      ["session:b", "channel", "running"],
    ],
  );
  const channelOnly = await execute(tool, ctx, {
    action: "list",
    surface: "channel",
    adapter: "infoflow",
  });
  assert.deepEqual(
    (channelOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );
  const runningOnly = await execute(tool, ctx, { action: "list", activity: "running" });
  assert.deepEqual(
    (runningOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );
  const page = await execute(tool, ctx, { action: "list", offset: 1, limit: 1 });
  assert.deepEqual(
    (page.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    ["session:b"],
  );

  const selected = await execute(tool, ctx, { action: "get" });
  assert.equal(
    (selected.details as { session: { sessionId: string } }).session.sessionId,
    "session:a",
  );

  const spawned = await execute(tool, ctx, {
    action: "spawn",
    roleRef: "role:project-verifier",
    name: "Verification",
  });
  assert.equal(
    (spawned.details as { session: { sessionId: string } }).session.sessionId,
    "session:spawned",
  );
  assert.equal((spawned.details as { executionTriggered: boolean }).executionTriggered, false);
  assert.deepEqual(calls.find((call) => call.method === "session.spawn")?.params, {
    supervisorSessionId: "session:a",
    roleRef: "role:project-verifier",
    name: "Verification",
  });
  const forked = await execute(tool, ctx, {
    action: "fork",
    roleRef: "role:project-verifier",
    cwd: "/workspace/test-copy",
    cwdArtifactRef: "artifact:git-change-copy",
  });
  assert.equal(
    (forked.details as { session: { sessionId: string } }).session.sessionId,
    "session:forked",
  );
  assert.equal((forked.details as { executionTriggered: boolean }).executionTriggered, false);
  assert.deepEqual(calls.find((call) => call.method === "session.fork")?.params, {
    supervisorSessionId: "session:a",
    roleRef: "role:project-verifier",
    cwd: "/workspace/test-copy",
    cwdArtifactRef: "artifact:git-change-copy",
  });

  await execute(tool, ctx, {
    action: "bind",
    sessionId: "session:spawned",
    externalKey: "infoflow:user:u1",
  });
  await execute(tool, ctx, {
    action: "unbind",
    sessionId: "session:spawned",
    externalKey: "infoflow:user:u1",
  });
  const archived = await execute(tool, ctx, {
    action: "archive",
    sessionId: "session:spawned",
  });
  assert.equal(
    (archived.details as { session: { placement: string } }).session.placement,
    "archived",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "workspace.ensure-local",
      "session.list",
      "workspace.ensure-local",
      "session.list",
      "workspace.ensure-local",
      "session.list",
      "workspace.ensure-local",
      "session.list",
      "session.get",
      "session.spawn",
      "session.fork",
      "session.bind",
      "session.unbind",
      "session.archive",
    ],
  );
});

test("channel sessions can inspect same-workspace local and channel sessions", async () => {
  const channelCurrent: SparkSessionProjection = {
    ...sessionRecord("session:channel"),
    bindings: [
      {
        kind: "channel",
        adapter: "infoflow",
        externalKey: "infoflow:group:channel",
        boundAt: NOW,
      },
    ],
  };
  const localTarget = sessionRecord("session:local");
  const channelPeer: SparkSessionProjection = {
    ...sessionRecord("session:channel-peer"),
    bindings: [
      {
        kind: "channel",
        adapter: "qqbot",
        externalKey: "qqbot:group:peer",
        boundAt: NOW,
      },
    ],
  };
  const otherWorkspace: SparkSessionProjection = {
    ...sessionRecord("session:other-workspace"),
    scope: { kind: "workspace", workspaceId: "workspace:other" },
    lineage: {
      kind: "child",
      parentSessionId: "sess_admin_workspace_other",
      origin: { kind: "session" },
    },
  };
  const records = new Map(
    [channelCurrent, localTarget, channelPeer, otherWorkspace].map((record) => [
      record.sessionId,
      record,
    ]),
  );
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "session.get") {
      return records.get(String((params as { sessionId?: string }).sessionId)) as T;
    }
    if (method === "session.list") return [...records.values()] as T;
    return assert.fail(`unexpected RPC method: ${method}`);
  };
  const tool = registerTestTool({ request });
  const ctx = { ...context(channelCurrent.sessionId), sessionSurface: "channel" as const };

  const listed = await execute(tool, ctx, { action: "list" });
  assert.deepEqual(
    (listed.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    [channelCurrent.sessionId, localTarget.sessionId, channelPeer.sessionId],
  );
  assert.deepEqual(calls.find((call) => call.method === "session.list")?.params, {
    scope: { kind: "workspace", workspaceId: "workspace:test" },
    includeArchived: false,
  });

  const selected = await execute(tool, ctx, {
    action: "get",
    sessionId: localTarget.sessionId,
  });
  assert.equal(
    (selected.details as { session: { sessionId: string } }).session.sessionId,
    localTarget.sessionId,
  );
  const selectedChannel = await execute(tool, ctx, {
    action: "get",
    sessionId: channelPeer.sessionId,
  });
  assert.equal(
    (selectedChannel.details as { session: { surface: string } }).session.surface,
    "channel",
  );
  await assert.rejects(
    () => execute(tool, ctx, { action: "get", sessionId: otherWorkspace.sessionId }),
    /must be sessions in the current workspace/u,
  );
  await assert.rejects(
    () => execute(tool, ctx, { action: "list", scope: "daemon" }),
    /their own workspace only/u,
  );
  const channelOnly = await execute(tool, ctx, { action: "list", surface: "channel" });
  assert.deepEqual(
    (channelOnly.details as { sessions: Array<{ sessionId: string }> }).sessions.map(
      (session) => session.sessionId,
    ),
    [channelCurrent.sessionId, channelPeer.sessionId],
  );

  for (const action of ["spawn", "fork", "bind", "unbind", "archive"] as const) {
    await assert.rejects(
      () => execute(tool, ctx, { action }),
      new RegExp(`cannot use session action=${action}`, "u"),
    );
  }
});

test("legacy create and call actions are unknown and never reach the daemon", async () => {
  const request = async () => assert.fail("legacy actions must not reach the daemon");
  const tool = registerTestTool({ request });
  for (const action of ["create", "call"]) {
    await assert.rejects(
      () => execute(tool, context("session:caller"), { action }),
      /session\.action must be list, get, spawn, fork/u,
    );
  }
});

test("session request delegates durable admission context to the daemon", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir, now: () => Date.parse(NOW) });
    const requestBody = "\n  Run the focused regression tests  \n";
    await mailStore.send({
      toSessionId: "session:worker",
      fromSessionId: "session:older",
      kind: "notification",
      intent: "work.context",
      body: "Older unread context",
    });
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "session.get") {
        return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
      }
      if (method === "session.send") {
        const input = params as SparkSessionSendRequest;
        const admitted = await sessionSendRpc(mailStore, input, {
          invocationId: "inv_requestturn",
          status: "queued",
          acceptedAt: NOW,
        });
        const stored = await mailStore.list(input.toSessionId);
        assert.equal(stored.length, 2, "daemon admission must persist before returning");
        const requestMail = stored.find((message) => message.body === requestBody);
        assert.ok(requestMail);
        assert.equal(input.body, requestBody);
        assert.deepEqual(input.origin, {
          surface: "local",
          host: "tui",
        });
        assert.equal(input.wake, false);
        return admitted as T;
      }
      return assert.fail(`unexpected RPC method: ${method}`);
    };
    const tool = registerTestTool({ request });

    const requested = await execute(
      tool,
      { ...context("session:caller"), sessionSource: "tui" },
      {
        action: "send",
        kind: "request",
        toSessionId: "session:worker",
        message: requestBody,
      },
      "call-request-work",
    );
    const details = requested.details as {
      created: boolean;
      executionTriggered: boolean;
      message: { id: string; kind: string; intent: string };
      submitted: { invocationId: string };
    };
    assert.equal(details.created, true);
    assert.equal(details.executionTriggered, true);
    assert.equal(details.message.kind, "request");
    assert.equal(details.message.intent, "work.request");
    assert.equal(details.submitted.invocationId, "inv_requestturn");
    assert.match(toolText(requested), /invocation inv_requestturn was accepted/u);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["session.get", "session.send"],
    );

    await assert.rejects(
      () =>
        execute(tool, context("session:caller"), {
          action: "send",
          toSessionId: "session:worker",
          kind: "inform",
          message: "Invalid legacy kind",
        }),
      /kind must be request or notification/u,
    );
    await assert.rejects(
      () =>
        execute(tool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:worker",
          payload: { task: "payload-only is not a user turn" },
        }),
      /request requires a non-empty message body/u,
    );

    const channelTool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        assert.equal(method, "session.get");
        const sessionId = String((params as { sessionId?: string }).sessionId);
        return {
          ...sessionRecord(sessionId),
          bindings: [
            {
              kind: "channel",
              adapter: "qqbot",
              externalKey: "qqbot:c2c:worker",
              boundAt: NOW,
            },
          ],
        } as T;
      },
    });
    await assert.rejects(
      () =>
        execute(channelTool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:channel-worker",
          message: "Invalid channel target",
        }),
      /request targets must be local sessions/u,
    );

    const archivedTool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        assert.equal(method, "session.get");
        const sessionId = String((params as { sessionId?: string }).sessionId);
        return { ...sessionRecord(sessionId), placement: "archived" } as T;
      },
    });
    await assert.rejects(
      () =>
        execute(archivedTool, context("session:caller"), {
          action: "send",
          kind: "request",
          toSessionId: "session:archived-worker",
          message: "Invalid archived target",
        }),
      /cannot request archived Session/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session request remains one-way and wait polls the durable invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-success-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const calls: Array<{ method: string; params: unknown }> = [];
    let statusReads = 0;
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "session.send") {
          return (await sessionSendRpc(mailStore, params as SparkSessionSendRequest, {
            invocationId: "inv_requestsuccess",
            status: "queued",
            acceptedAt: NOW,
          })) as T;
        }
        if (method === "turn.status") {
          statusReads += 1;
          return {
            invocationId: "inv_requestsuccess",
            sessionId: "session:worker",
            status: statusReads === 1 ? "running" : "succeeded",
            createdAt: NOW,
            updatedAt: NOW,
            ...(statusReads === 1 ? {} : { finishedAt: NOW }),
            eventCursor: statusReads,
          } as T;
        }
        if (method === "turn.result") {
          return {
            invocationId: "inv_requestsuccess",
            status: "succeeded",
            assistantText: "The build is green.",
            finishedAt: NOW,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      sleep: async () => undefined,
    });

    const sent = await execute(
      tool,
      {
        ...context("session:caller"),
        sessionSource: "daemon",
        invocationId: "inv_parent",
      },
      {
        action: "send",
        kind: "request",
        toSessionId: "session:worker",
        message: "Is the build green?",
      },
      "call-request-success",
    );
    assert.equal(
      (sent.details as { submitted: { invocationId: string } }).submitted.invocationId,
      "inv_requestsuccess",
    );
    const result = await execute(
      tool,
      context("session:caller"),
      {
        action: "wait",
        invocationId: "inv_requestsuccess",
        timeoutMs: 1_000,
      },
      "call-request-wait",
    );

    assert.equal(toolText(result), "The build is green.");
    const details = result.details as {
      blocking: boolean;
      waitTimedOut: boolean;
      answer: string;
      invocationId: string;
    };
    assert.equal(details.blocking, true);
    assert.equal(details.waitTimedOut, false);
    assert.equal(details.answer, "The build is green.");
    assert.equal(details.invocationId, "inv_requestsuccess");
    const sendRequest = calls.find((call) => call.method === "session.send")
      ?.params as SparkSessionSendRequest;
    assert.deepEqual(
      {
        toSessionId: sendRequest.toSessionId,
        fromSessionId: sendRequest.fromSessionId,
        body: sendRequest.body,
        idempotencyKey: sendRequest.idempotencyKey,
        origin: sendRequest.origin,
        wake: sendRequest.wake,
        parentInvocationId: sendRequest.parentInvocationId,
      },
      {
        toSessionId: "session:worker",
        fromSessionId: "session:caller",
        body: "Is the build green?",
        idempotencyKey: 'session.tool:["session:caller","call-request-success"]',
        origin: { surface: "local", host: "daemon" },
        wake: false,
        parentInvocationId: "inv_parent",
      },
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ["session.get", "session.send", "turn.status", "turn.status", "turn.result"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session request reports terminal failure without retrying or throwing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-failure-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "session.send") {
          return (await sessionSendRpc(mailStore, params as SparkSessionSendRequest, {
            invocationId: "inv_requestfailed",
            status: "queued",
            acceptedAt: NOW,
          })) as T;
        }
        if (method === "turn.status") {
          return {
            invocationId: "inv_requestfailed",
            sessionId: "session:worker",
            status: "failed",
            createdAt: NOW,
            updatedAt: NOW,
            finishedAt: NOW,
            error: { code: "EXECUTION_FAILED", message: "worker failed" },
            eventCursor: 2,
          } as T;
        }
        if (method === "turn.result") {
          return {
            invocationId: "inv_requestfailed",
            status: "failed",
            error: { code: "EXECUTION_FAILED", message: "worker failed", retryable: false },
            finishedAt: NOW,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
    });

    const result = await execute(tool, context("session:caller"), {
      action: "wait",
      invocationId: "inv_requestfailed",
    });

    assert.match(toolText(result), /inv_requestfailed failed: worker failed/u);
    assert.equal((result.details as { waitTimedOut: boolean }).waitTimedOut, false);
    assert.equal(
      (result.details as { result: { error: { retryable: boolean } } }).result.error.retryable,
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session request timeout stops only the sender wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-timeout-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    let now = 0;
    let submitCount = 0;
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "session.send") {
          submitCount += 1;
          return (await sessionSendRpc(mailStore, params as SparkSessionSendRequest, {
            invocationId: "inv_requesttimeout",
            status: "queued",
            acceptedAt: NOW,
          })) as T;
        }
        if (method === "turn.status") {
          return {
            invocationId: "inv_requesttimeout",
            sessionId: "session:worker",
            status: "running",
            createdAt: NOW,
            updatedAt: NOW,
            eventCursor: 1,
          } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await execute(tool, context("session:caller"), {
      action: "send",
      kind: "request",
      toSessionId: "session:worker",
      message: "Keep working after I stop waiting",
    });
    const timedOut = await execute(tool, context("session:caller"), {
      action: "wait",
      invocationId: "inv_requesttimeout",
      timeoutMs: 1_000,
    });
    assert.match(toolText(timedOut), /stopped waiting after 1000ms/u);
    assert.match(toolText(timedOut), /continues asynchronously/u);
    assert.equal((timedOut.details as { waitTimedOut: boolean }).waitTimedOut, true);
    assert.equal((timedOut.details as { status: { status: string } }).status.status, "running");
    assert.equal(submitCount, 1);

    await assert.rejects(
      () =>
        execute(tool, context("session:invalid-timeout"), {
          action: "send",
          kind: "request",
          wait: "completed",
          toSessionId: "session:other",
          message: "Reject before persistence",
          timeoutMs: 999,
        }),
      /session send no longer accepts wait/u,
    );
    await assert.rejects(
      () =>
        execute(tool, context("session:invalid-timeout"), {
          action: "wait",
          invocationId: "inv_requesttimeout",
          timeoutMs: 999,
        }),
      /request timeoutMs must be between 1000 and 300000/u,
    );
    assert.equal((await mailStore.list("session:other")).length, 0);

    const delegated = await execute(tool, context("session:nested"), {
      action: "send",
      kind: "request",
      toSessionId: "session:other",
      message: "Delegate asynchronously",
    });
    assert.match(toolText(delegated), /invocation inv_requesttimeout was accepted/u);
    assert.equal(submitCount, 2);
    assert.equal((await mailStore.list("session:other")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session request preserves durable recovery data when queue acceptance fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-request-failure-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId?: string }).sessionId)) as T;
        }
        if (method === "session.send") {
          const input = params as SparkSessionSendRequest;
          await sessionSendRpc(mailStore, input);
          throw new Error("queue unavailable");
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
    });

    await assert.rejects(
      () =>
        execute(
          tool,
          context("session:caller"),
          {
            action: "send",
            kind: "request",
            toSessionId: "session:worker",
            message: "Persist even when queueing fails",
          },
          "call-request-failure",
        ),
      /queue unavailable/u,
    );
    const [stored] = await mailStore.list("session:worker");
    assert.equal(stored?.body, "Persist even when queueing fails");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("channel sessions may request work only from local sessions in their workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-channel-request-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const channelCurrent: SparkSessionProjection = {
      ...sessionRecord("session:channel"),
      bindings: [
        {
          kind: "channel",
          adapter: "infoflow",
          externalKey: "infoflow:user:channel",
          boundAt: NOW,
        },
      ],
    };
    const localTarget = sessionRecord("session:local");
    const channelTarget: SparkSessionProjection = {
      ...sessionRecord("session:channel-target"),
      bindings: [
        {
          kind: "channel",
          adapter: "qqbot",
          externalKey: "qqbot:c2c:target",
          boundAt: NOW,
        },
      ],
    };
    const records = new Map(
      [channelCurrent, localTarget, channelTarget].map((record) => [record.sessionId, record]),
    );
    const calls: string[] = [];
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push(method);
      if (method === "session.get") {
        return records.get(String((params as { sessionId?: string }).sessionId)) as T;
      }
      if (method === "session.send") {
        return (await sessionSendRpc(mailStore, params as SparkSessionSendRequest, {
          invocationId: "inv_channelrequest",
          status: "queued",
          acceptedAt: NOW,
        })) as T;
      }
      return assert.fail(`unexpected RPC method: ${method}`);
    };
    const tool = registerTestTool({ request });
    const ctx = {
      ...context(channelCurrent.sessionId),
      sessionSurface: "channel" as const,
      channelBinding: {
        workspaceId: "workspace:test",
        adapter: "infoflow" as const,
        adapterId: "infoflow-main",
        externalKey: "infoflow:user:channel",
        recipient: "user:channel",
      },
    };

    const requested = await execute(tool, ctx, {
      action: "send",
      kind: "request",
      toSessionId: localTarget.sessionId,
      intent: "work.request",
      message: "Handle this now",
    });
    assert.equal((requested.details as { executionTriggered: boolean }).executionTriggered, true);
    assert.deepEqual(calls, ["session.get", "session.get", "session.send"]);

    await assert.rejects(
      () =>
        execute(tool, ctx, {
          action: "send",
          kind: "request",
          toSessionId: channelTarget.sessionId,
          message: "Do not execute on a channel session",
        }),
      /request targets must be local sessions/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session send rejects the removed question mode", async () => {
  const tool = registerTestTool({
    request: async () => assert.fail("question rejection must happen before daemon RPC"),
  });

  await assert.rejects(
    () =>
      execute(tool, context("session:caller"), {
        action: "send",
        kind: "question",
        toSessionId: "session:target",
        message: "Do not persist this",
      }),
    /session kind must be request or notification/u,
  );
});
test("session mail writes are delegated to the daemon-owned RPC store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-daemon-store-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const calls: string[] = [];
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push(method);
        if (method === "session.get") {
          return sessionRecord(String((params as { sessionId: string }).sessionId)) as T;
        }
        if (method === "session.send") {
          return (await sessionSendRpc(mailStore, params as SparkSessionSendRequest)) as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
    });
    const ctx = { ...context("session:a"), sparkStateRoot: "/ignored-by-client" };
    await execute(tool, ctx, {
      action: "send",
      toSessionId: "session:b",
      intent: "work.progress",
      message: "Half complete",
    });
    const stored = await new SparkSessionMailStore({ sparkHome: dir }).list("session:b");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.fromSessionId, "session:a");
    assert.deepEqual(calls, ["session.get", "session.send"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session inbox is current-session private and supports read and ack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-inbox-tool-"));
  try {
    const mailStore = new SparkSessionMailStore({ sparkHome: dir });
    const incoming = await mailStore.send({
      toSessionId: "session:a",
      fromSessionId: "session:b",
      kind: "notification",
      intent: "work.progress",
      payload: { percent: 50 },
      body: "Half complete",
      source: "tool",
    });
    const tool = registerTestTool({
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        const input = params as { sessionId: string; messageId?: string; includeAcked?: boolean };
        if (method === "session.inbox") {
          return {
            messages: await mailStore.list(input.sessionId, {
              includeAcked: input.includeAcked,
            }),
          } as T;
        }
        if (method === "session.mail.read") {
          return { message: await mailStore.read(input.sessionId, input.messageId!) } as T;
        }
        if (method === "session.mail.ack") {
          return { message: await mailStore.ack(input.sessionId, input.messageId!) } as T;
        }
        return assert.fail(`unexpected RPC method: ${method}`);
      },
    });
    const ctx = context("session:a");

    await assert.rejects(
      () => execute(tool, ctx, { action: "inbox", sessionId: "session:b" }),
      /another session's inbox is private/u,
    );
    const listed = await execute(tool, ctx, { action: "inbox" });
    assert.equal((listed.details as { messages: unknown[] }).messages.length, 1);

    const read = await execute(tool, ctx, {
      action: "read",
      messageId: incoming.message.id,
    });
    assert.equal((read.details as { message: { status: string } }).message.status, "read");

    const acked = await execute(tool, ctx, {
      action: "ack",
      messageId: incoming.message.id,
    });
    assert.equal((acked.details as { message: { status: string } }).message.status, "acked");

    const empty = await execute(tool, ctx, { action: "inbox" });
    assert.equal((empty.details as { messages: unknown[] }).messages.length, 0);

    const paged = await execute(tool, ctx, { action: "inbox", offset: 10, limit: 1 });
    assert.equal((paged.details as { offset: number }).offset, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session mailbox paths isolate ids that collide under the legacy sanitizer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-paths-"));
  try {
    const store = new SparkSessionMailStore({ sparkHome: dir });
    assert.notEqual(store.mailboxPath("session:a"), store.mailboxPath("session-a"));
    await store.send({
      toSessionId: "session:a",
      fromSessionId: "session:sender",
      body: "colon target",
    });
    await store.send({
      toSessionId: "session-a",
      fromSessionId: "session:sender",
      body: "dash target",
    });
    assert.deepEqual(
      (await store.list("session:a")).map((message) => message.body),
      ["colon target"],
    );
    assert.deepEqual(
      (await store.list("session-a")).map((message) => message.body),
      ["dash target"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session mailbox reads and migrates legacy v1 paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-legacy-"));
  try {
    const sessionId = "session:legacy";
    const legacyDir = join(dir, "session-mail", "v1", sanitizeSessionMailScope(sessionId));
    const legacyPath = join(legacyDir, "mailbox.json");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        toSessionId: sessionId,
        messages: [
          {
            id: "mail:legacy",
            toSessionId: sessionId,
            fromSessionId: "session:sender",
            kind: "inform",
            subject: null,
            body: "legacy message",
            createdAt: NOW,
            readAt: null,
            ackedAt: null,
            source: "cli",
          },
        ],
      })}\n`,
      "utf8",
    );
    const store = new SparkSessionMailStore({ sparkHome: dir, now: () => Date.parse(NOW) });
    const [legacy] = await store.list(sessionId);
    assert.equal(legacy?.kind, "notification");
    assert.equal(legacy?.intent, "session.mail");
    await store.read(sessionId, "mail:legacy");
    await rm(legacyPath, { force: true });
    assert.equal((await store.get(sessionId, "mail:legacy")).readAt, NOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session mailbox serializes concurrent sends without losing messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-mail-concurrency-"));
  try {
    const store = new SparkSessionMailStore({ sparkHome: dir });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.send({
          toSessionId: "session:target",
          fromSessionId: `session:sender-${index}`,
          kind: "notification",
          intent: "load.test",
          payload: { index },
          idempotencyKey: `load:${index}`,
        }),
      ),
    );
    const messages = await store.list("session:target");
    assert.equal(messages.length, 20);
    assert.equal(new Set(messages.map((message) => message.id)).size, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function registerTestTool(
  deps: NonNullable<Parameters<typeof registerSparkSessionTool>[1]>["deps"],
): ToolConfig {
  const tools = new Map<string, ToolConfig>();
  registerSparkSessionTool(
    { registerTool: (config) => tools.set(config.name, config as ToolConfig) },
    { deps },
  );
  const tool = tools.get("session");
  assert.ok(tool);
  assert.deepEqual([...tools.keys()], ["session"]);
  return tool;
}

async function execute(
  tool: ToolConfig,
  ctx: SparkSessionToolContext,
  params: Record<string, unknown>,
  toolCallId = `call-${String(params.action)}`,
): Promise<SessionToolResult> {
  return await tool.execute(
    toolCallId,
    params,
    new AbortController().signal,
    () => undefined,
    ctx as never,
  );
}

function context(sessionId: string): SparkSessionToolContext {
  return {
    cwd: "/workspace/test",
    sessionId,
  };
}

function sessionRecord(
  sessionId: string,
  options: { title?: string } = {},
): SparkSessionProjection {
  return workspaceSessionRecord({
    sessionId,
    workspaceId: "workspace:test",
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...(options.title ? { name: options.title } : {}),
  });
}

function toolText(result: SessionToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}
