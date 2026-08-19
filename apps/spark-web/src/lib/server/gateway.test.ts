import assert from "node:assert/strict";
import { test } from "vitest";

import { assertLoopbackBindHost, isLoopbackBindHost, parseSparkWebBindArgs } from "./bind.ts";
import { tokensMatch, tokenFromRequest } from "./auth.ts";
import { isAllowedSparkWebRpcMethod } from "./rpc-allowlist.ts";
import { invokeSparkWebRpc, SparkWebRpcForbiddenError } from "./rpc.ts";
import { collectSessionLiveEvents, formatSseFrame, sessionSnapshotCursor } from "./sse.ts";

test("loopback bind accepts localhost and rejects 0.0.0.0", () => {
  assert.equal(isLoopbackBindHost("127.0.0.1"), true);
  assert.equal(isLoopbackBindHost("localhost"), true);
  assert.equal(isLoopbackBindHost("0.0.0.0"), false);
  assert.throws(() => assertLoopbackBindHost("0.0.0.0"), /refuses non-loopback/);
  assert.throws(() => parseSparkWebBindArgs(["--host", "0.0.0.0"]), /refuses non-loopback/);
  assert.deepEqual(parseSparkWebBindArgs(["--port", "4311", "--no-open"]), {
    host: "127.0.0.1",
    port: 4311,
    open: false,
    argv: [],
  });
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
