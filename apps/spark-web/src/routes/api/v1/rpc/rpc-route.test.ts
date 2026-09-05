import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";

const invokeSparkWebRpcMock = vi.hoisted(() => vi.fn());

vi.mock("$lib/server/rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/server/rpc")>();
  return { ...actual, invokeSparkWebRpc: invokeSparkWebRpcMock };
});

import { SparkWebRpcForbiddenError } from "$lib/server/rpc";
import { POST } from "./+server";

beforeEach(() => {
  invokeSparkWebRpcMock.mockReset();
});

test("projects known daemon domain errors with their protocol status, code, and message", async () => {
  const message = "No configured model is available. Configure provider credentials and retry.";
  invokeSparkWebRpcMock.mockRejectedValueOnce(
    new SparkDaemonRemoteError(message, {
      code: "model_unavailable",
      status: 599,
      credential: "sk-must-not-leak",
    }),
  );

  const response = await postJson({ method: "turn.submit", input: { sessionId: "sess_1" } });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { code: "model_unavailable", message });
});

test("leaves unclassified exceptions for SvelteKit to hide", async () => {
  const internal = new Error("database failure with password=must-not-leak");
  invokeSparkWebRpcMock.mockRejectedValueOnce(internal);

  await assert.rejects(
    () => postJson({ method: "session.list", input: {} }),
    (caught: unknown) => caught === internal,
  );
});

test("does not expose unclassified daemon remote errors", async () => {
  const internal = new SparkDaemonRemoteError("credential=must-not-leak", {
    code: "INTERNAL_SERVER_ERROR",
    status: 500,
  });
  invokeSparkWebRpcMock.mockRejectedValueOnce(internal);

  await assert.rejects(
    () => postJson({ method: "session.list", input: {} }),
    (caught: unknown) => caught === internal,
  );
});

test("does not project a typed daemon error for a method that does not declare it", async () => {
  const mismatched = new SparkDaemonRemoteError("credential=must-not-leak", {
    code: "model_unavailable",
    status: 422,
  });
  invokeSparkWebRpcMock.mockRejectedValueOnce(mismatched);

  await assert.rejects(
    () => postJson({ method: "session.list", input: {} }),
    (caught: unknown) => caught === mismatched,
  );
});

test("returns 403 with a stable code for forbidden methods", async () => {
  invokeSparkWebRpcMock.mockRejectedValueOnce(new SparkWebRpcForbiddenError("repro.start"));

  const response = await postJson({ method: "repro.start", input: {} });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    code: "forbidden",
    message: "spark web does not allow RPC method repro.start",
  });
});

test("returns 400 for malformed JSON without invoking the daemon", async () => {
  const response = await postRaw("{");

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "invalid_request",
    message: "Request body must be valid JSON",
  });
  assert.equal(invokeSparkWebRpcMock.mock.calls.length, 0);
});

test("returns 400 when the RPC method is missing", async () => {
  const response = await postJson({ input: {} });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: "invalid_request",
    message: "RPC method is required",
  });
  assert.equal(invokeSparkWebRpcMock.mock.calls.length, 0);
});

test("returns 400 for non-object bodies and non-string methods", async () => {
  for (const body of [null, [], { method: 42 }]) {
    const response = await postJson(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      code: "invalid_request",
      message: "RPC method is required",
    });
  }
  assert.equal(invokeSparkWebRpcMock.mock.calls.length, 0);
});

async function postJson(body: unknown): Promise<Response> {
  return await postRaw(JSON.stringify(body));
}

async function postRaw(body: string): Promise<Response> {
  const request = new Request("http://localhost/api/v1/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return await POST({ request } as never);
}
