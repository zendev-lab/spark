import assert from "node:assert/strict";
import { test } from "vitest";

import { parseSparkWebBindArgs, sparkWebBrowserAuthority } from "./bind.ts";
import { sparkWebRequestTrustError, tokensMatch, tokenFromRequest } from "./auth.ts";
import { isAllowedSparkWebRpcMethod } from "./rpc-allowlist.ts";
import { invokeSparkWebRpc, sanitizeSparkWebRpcInput, SparkWebRpcForbiddenError } from "./rpc.ts";
import { collectSessionLiveEvents, formatSseFrame, sessionSnapshotCursor } from "./sse.ts";

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

test("SSE collector emits whole-value snapshots and turn events", async () => {
  const snapshot = {
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
    messages: [],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
  };
  const events = await collectSessionLiveEvents({
    sessionId: "sess_1",
    invoke: async (method, input) => {
      if (method === "session.snapshot") return snapshot as never;
      if (method === "turn.stream") {
        assert.equal((input as { invocationId: string }).invocationId, "inv_abc123");
        return {
          invocationId: "inv_abc123",
          events: [
            {
              invocationId: "inv_abc123",
              sequence: 1,
              kind: "assistant.delta",
              payload: { text: "ok" },
              createdAt: "2026-08-19T00:00:01.000Z",
            },
          ],
          nextCursor: 1,
          hasMore: false,
        } as never;
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  assert.equal(events[0]?.event, "spark.session.snapshot");
  assert.equal(events[1]?.event, "spark.turn.event");
  assert.match(formatSseFrame(events[0]!), /^event: spark.session.snapshot\n/u);
  assert.equal(sessionSnapshotCursor(snapshot as never).includes("sess_1"), true);
});
