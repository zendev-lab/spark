import assert from "node:assert/strict";
import { test } from "vitest";

import { parseSparkWebBindArgs, sparkWebBrowserAuthority } from "./bind.ts";
import {
  isSparkWebReadOnlyShareRequest,
  sparkWebRequestTrustError,
  sparkWebShareRequestTrustError,
  tokensMatch,
  tokenFromRequest,
} from "./auth.ts";
import { isAllowedSparkWebRpcMethod } from "./rpc-allowlist.ts";
import {
  invokeSparkWebRpc,
  sanitizeSparkWebRpcInput,
  SparkWebRpcForbiddenError,
  type SparkWebDaemonInvoker,
} from "./rpc.ts";
import { listSparkWebSessions } from "./session-list.ts";
import {
  collectSessionLiveEvents,
  formatSseFrame,
  sessionSnapshotCursor,
  streamSessionLiveEvents,
} from "./sse.ts";

test("bind arguments default to loopback and require an explicit trusted network host", () => {
  assert.deepEqual(
    parseSparkWebBindArgs(["--host", "0.0.0.0", "--port", "4311", "--trusted-host", "spark.lan"]),
    {
      host: "0.0.0.0",
      port: 4311,
      open: true,
      trustedHosts: ["spark.lan"],
      argv: [],
    },
  );
  assert.deepEqual(parseSparkWebBindArgs(["--port", "4311", "--no-open"]), {
    host: "127.0.0.1",
    port: 4311,
    open: false,
    trustedHosts: [],
    argv: [],
  });
  assert.throws(() => parseSparkWebBindArgs(["--host", "0.0.0.0"]), /requires --trusted-host/u);
  assert.equal(sparkWebBrowserAuthority("spark.lan", 4310), "spark.lan:4310");
  assert.equal(sparkWebBrowserAuthority("spark.lan:8443", 4310), "spark.lan:8443");
  assert.equal(sparkWebBrowserAuthority("::1", 4310), "[::1]:4310");
});

test("request trust enforces Host, Origin, Fetch Metadata, and cookie mutation CSRF", () => {
  const trust = { bindHost: "0.0.0.0", bindPort: 4310, trustedHosts: ["spark.lan"] };
  assert.equal(
    sparkWebRequestTrustError({
      request: new Request("http://spark.lan:4310/api/v1/rpc", {
        method: "POST",
        headers: {
          host: "spark.lan:4310",
          origin: "http://spark.lan:4310",
          "sec-fetch-site": "same-origin",
        },
      }),
      authSource: "cookie",
      trust,
    }),
    null,
  );
  assert.match(
    sparkWebRequestTrustError({
      request: new Request("http://evil.test/api/v1/rpc", {
        method: "POST",
        headers: { host: "evil.test", origin: "http://evil.test" },
      }),
      authSource: "cookie",
      trust,
    }) ?? "",
    /Host/u,
  );
  assert.match(
    sparkWebRequestTrustError({
      request: new Request("http://spark.lan:4310/api/v1/rpc", {
        method: "POST",
        headers: { host: "spark.lan:4310" },
      }),
      authSource: "cookie",
      trust,
    }) ?? "",
    /same-origin metadata/u,
  );
  assert.equal(
    sparkWebRequestTrustError({
      request: new Request("http://spark.lan:4310/api/v1/rpc", {
        method: "POST",
        headers: { host: "spark.lan:4310" },
      }),
      authSource: "header",
      trust,
    }),
    null,
  );
});

test("cross-site document navigation is allowed only for read-only share URLs", () => {
  const trust = { bindHost: "0.0.0.0", bindPort: 4310, trustedHosts: ["spark.lan"] };
  const request = new Request("http://spark.lan:4310/share/12345678901234567890123456789012", {
    headers: {
      host: "spark.lan:4310",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  assert.equal(
    isSparkWebReadOnlyShareRequest(request, "/share/12345678901234567890123456789012"),
    true,
  );
  assert.equal(sparkWebShareRequestTrustError({ request, trust }), null);
  assert.match(
    sparkWebRequestTrustError({ request, authSource: "none", trust }) ?? "",
    /cross-site/u,
  );
  assert.equal(isSparkWebReadOnlyShareRequest(request, "/api/v1/rpc"), false);
  assert.match(
    sparkWebShareRequestTrustError({
      request: new Request(request, {
        headers: { ...Object.fromEntries(request.headers), "sec-fetch-dest": "empty" },
      }),
      trust,
    }) ?? "",
    /cross-site/u,
  );
});

test("token comparison rejects missing and mismatched values", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", null), false);
  assert.equal(tokenFromRequest({ query: "q", cookie: "c" }), "q");
  assert.equal(tokenFromRequest({ cookie: "c" }), "c");
});

test("RPC allowlist forwards known methods and rejects unknown ones", async () => {
  assert.equal(isAllowedSparkWebRpcMethod("turn.submit"), true);
  assert.equal(isAllowedSparkWebRpcMethod("workspace.register"), true);
  assert.equal(isAllowedSparkWebRpcMethod("provider.auth.login.start"), true);
  assert.equal(isAllowedSparkWebRpcMethod("provider.auth.login.status"), true);
  assert.equal(isAllowedSparkWebRpcMethod("provider.auth.login.respond"), true);
  assert.equal(isAllowedSparkWebRpcMethod("provider.auth.login.cancel"), true);
  assert.equal(isAllowedSparkWebRpcMethod("repro.start"), false);
  assert.equal(isAllowedSparkWebRpcMethod("repro.stop"), false);
  assert.equal(isAllowedSparkWebRpcMethod("file.execute"), false);
  const calls: Array<{ method: string; input: unknown }> = [];
  const result = await invokeSparkWebRpc("session.list", { limit: 10 }, async (method, input) => {
    calls.push({ method, input });
    return [{ sessionId: "sess_1" }] as never;
  });
  assert.deepEqual(calls, [{ method: "session.list", input: { limit: 10 } }]);
  assert.deepEqual(result, [{ sessionId: "sess_1" }]);
  await assert.rejects(
    () => invokeSparkWebRpc("file.execute", {}, async () => ({}) as never),
    (error: unknown) => error instanceof SparkWebRpcForbiddenError,
  );
});

test("workspace.register from web keeps only local path identity", async () => {
  assert.deepEqual(
    sanitizeSparkWebRpcInput("workspace.register", {
      localPath: "/tmp/spore",
      displayName: " Spore ",
      serverUrl: "https://hub.example",
      registrationToken: "tok_secret",
      allowInsecureHttp: true,
      workspaceSlug: "nope",
    }),
    { localPath: "/tmp/spore", displayName: "Spore" },
  );
  assert.deepEqual(sanitizeSparkWebRpcInput("workspace.register", { localPath: "/tmp/spore" }), {
    localPath: "/tmp/spore",
  });
  assert.deepEqual(sanitizeSparkWebRpcInput("workspace.list", { includeInactive: true }), {
    includeInactive: true,
  });
  const calls: Array<{ method: string; input: unknown }> = [];
  await invokeSparkWebRpc(
    "workspace.register",
    {
      localPath: "/tmp/spore",
      displayName: "Spore",
      serverUrl: "https://hub.example",
      registrationToken: "tok_secret",
    },
    async (method, input) => {
      calls.push({ method, input });
      return { id: "ws_1" } as never;
    },
  );
  assert.deepEqual(calls, [
    { method: "workspace.register", input: { localPath: "/tmp/spore", displayName: "Spore" } },
  ]);
});

test("SSE collector emits content-addressed whole-value snapshot pages", async () => {
  const snapshot = {
    snapshot: {
      sessionId: "sess_1",
      status: "running",
      updatedAt: "2026-08-19T00:00:00.000Z",
      pendingTurns: [
        {
          invocationId: "inv_abc123",
          prompt: "hi",
          status: "running",
          createdAt: "2026-08-19T00:00:00.000Z",
        },
      ],
      messages: [{ id: "message-1", role: "assistant", text: "partial" }],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    },
    history: {
      totalMessages: 1,
      loadedMessages: 1,
      hiddenMessages: 0,
      earlierMessages: 0,
      laterMessages: 0,
      hasEarlierMessages: false,
    },
  };
  const events = await collectSessionLiveEvents({
    sessionId: "sess_1",
    invoke: async (method, input) => {
      if (method === "session.snapshot-page") {
        assert.deepEqual(input, { sessionId: "sess_1", messageLimit: 32 });
        return snapshot as never;
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  assert.equal(events[0]?.event, "spark.session.snapshot");
  assert.equal(events.length, 1);
  assert.match(formatSseFrame(events[0]!), /^event: spark.session.snapshot\n/u);
  assert.match(sessionSnapshotCursor(snapshot as never), /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(
    sessionSnapshotCursor(snapshot as never),
    sessionSnapshotCursor({
      ...snapshot,
      snapshot: {
        ...snapshot.snapshot,
        messages: [{ id: "message-1", role: "assistant", text: "complete" }],
      },
    } as never),
  );
});

test("SSE snapshot polling waits for each owner response before starting the next", async () => {
  const controller = new AbortController();
  let calls = 0;
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const page = (status: "running" | "idle", updatedAt: string) => ({
    snapshot: {
      sessionId: "sess_1",
      status,
      updatedAt,
      messages: [],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    },
    history: {
      totalMessages: 0,
      loadedMessages: 0,
      hiddenMessages: 0,
      earlierMessages: 0,
      laterMessages: 0,
      hasEarlierMessages: false,
    },
  });
  const pages = [
    page("running", "2026-08-19T00:00:00.000Z"),
    page("idle", "2026-08-19T00:00:01.000Z"),
  ];
  const stream = streamSessionLiveEvents({
    sessionId: "sess_1",
    signal: controller.signal,
    intervalMs: 0,
    invoke: async () => {
      const call = calls;
      calls += 1;
      if (call === 0) await firstResponse;
      return pages[call] as never;
    },
  });

  const first = stream.next();
  await Promise.resolve();
  assert.equal(calls, 1);
  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal((await first).value?.data.snapshot.status, "running");
  assert.equal((await stream.next()).value?.data.snapshot.status, "idle");
  controller.abort();
  await stream.return(undefined);
});

test("session tree pagination retains a parent across the owner page boundary", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    sessionId: `session-${index}`,
    scope: { kind: "daemon" },
    lineage: { kind: "root" },
  }));
  const child = {
    sessionId: "session-child",
    scope: { kind: "daemon" },
    lineage: { kind: "child", parentSessionId: "session-0" },
  };
  const cursors: Array<string | undefined> = [];
  const invoke = (async (method: string, input: unknown) => {
    assert.equal(method, "session.list");
    const cursor = (input as { cursor?: string }).cursor;
    cursors.push(cursor);
    if (!cursor) return firstPage;
    if (cursor === "session-99") return [child];
    return [];
  }) as SparkWebDaemonInvoker;
  const sessions = await listSparkWebSessions({ includeArchived: true }, invoke);

  assert.deepEqual(cursors, [undefined, "session-99", "session-child"]);
  const childSession = sessions.find((session) => session.sessionId === "session-child");
  assert.equal(childSession?.lineage.kind, "child");
  if (childSession?.lineage.kind === "child") {
    assert.equal(childSession.lineage.parentSessionId, "session-0");
  }
});
