import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const transportMocks = vi.hoisted(() => ({
  createOrpc: vi.fn(),
  requestLegacy: vi.fn(),
}));

vi.mock("./daemon-local-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./daemon-local-rpc.js")>();
  return {
    ...actual,
    requestSparkDaemonLocalRpc: transportMocks.requestLegacy,
  };
});

vi.mock("./daemon-local-rpc-orpc.js", () => ({
  createSparkDaemonOrpcClient: transportMocks.createOrpc,
}));

import {
  createSparkDaemonClient,
  requestSparkDaemon,
  SparkDaemonPreDispatchUnavailableError,
  SparkDaemonProtocolMismatchError,
  SparkDaemonRemoteError,
  SparkDaemonRpcError,
} from "./daemon-client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("protocol-aware Spark daemon client", () => {
  it("falls back to legacy only when oRPC setup fails before dispatch", async () => {
    transportMocks.createOrpc.mockRejectedValueOnce(new Error("ENOENT"));
    transportMocks.requestLegacy.mockResolvedValueOnce({
      observedAt: "2026-07-27T00:00:00.000Z",
      token: "must-be-stripped",
      origins: [
        {
          serverUrl: "https://spark.example.test",
          parked: false,
          desired: true,
          runnable: true,
          workspaceCount: 1,
          profile: { token: "must-also-be-stripped" },
        },
      ],
    });
    const controller = new AbortController();

    await expect(
      requestSparkDaemon(
        "uplink.status",
        {},
        {
          orpcSocketPath: "/tmp/new-orpc.sock",
          legacySocketPath: "/tmp/old-legacy.sock",
          connectTimeoutMs: 123,
          responseTimeoutMs: 456,
          maxResponseBytes: 789,
          signal: controller.signal,
        },
      ),
    ).resolves.toEqual({
      observedAt: "2026-07-27T00:00:00.000Z",
      origins: [
        {
          serverUrl: "https://spark.example.test",
          parked: false,
          desired: true,
          runnable: true,
          workspaceCount: 1,
        },
      ],
    });

    expect(transportMocks.createOrpc).toHaveBeenCalledWith({
      socketPath: "/tmp/new-orpc.sock",
      connectTimeoutMs: 123,
      maxResponseBytes: 789,
      signal: controller.signal,
    });
    expect(transportMocks.requestLegacy).toHaveBeenCalledWith(
      "uplink.status",
      {},
      {
        socketPath: "/tmp/old-legacy.sock",
        connectTimeoutMs: 123,
        responseTimeoutMs: 456,
        maxResponseBytes: 789,
        signal: controller.signal,
      },
    );
  });

  it("diagnoses malformed legacy output as a protocol mismatch without another request", async () => {
    transportMocks.createOrpc.mockRejectedValueOnce(new Error("ENOENT"));
    transportMocks.requestLegacy.mockResolvedValueOnce({
      observedAt: "not-an-iso-date",
      origins: [],
    });

    const failure = await requestSparkDaemon("uplink.status", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SparkDaemonProtocolMismatchError);
    expect(failure).toMatchObject({ method: "uplink.status" });
    expect((failure as Error).message).toContain("did not match client protocol");
    expect((failure as Error).message).toContain("Restart or update the daemon");
    expect(transportMocks.createOrpc).toHaveBeenCalledOnce();
    expect(transportMocks.requestLegacy).toHaveBeenCalledOnce();
  });

  it("never routes daemon-owned tool execution through the legacy transport", async () => {
    transportMocks.createOrpc.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(
      requestSparkDaemon("git.execute", {
        cwd: "/tmp/workspace",
        toolCallId: "call-1",
        operationId: "git:call-1",
        params: { action: "inspect" },
      }),
    ).rejects.toBeInstanceOf(SparkDaemonPreDispatchUnavailableError);
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
  });

  it("never routes oRPC-only prompt history through the legacy transport", async () => {
    transportMocks.createOrpc.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(
      requestSparkDaemon("session.prompt-history", {
        sessionId: "session-1",
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(SparkDaemonPreDispatchUnavailableError);
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
  });

  it("never routes the oRPC-only Session retry target through the legacy transport", async () => {
    transportMocks.createOrpc.mockRejectedValueOnce(new Error("ENOENT"));

    await expect(
      requestSparkDaemon("session.retry-target", {
        sessionId: "session-1",
      }),
    ).rejects.toBeInstanceOf(SparkDaemonPreDispatchUnavailableError);
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
  });

  it("does not replay a remote failure after oRPC has connected", async () => {
    const remoteFailure = new ORPCError("CONFLICT", {
      message: "mutation rejected",
      data: { revision: 4 },
    });
    const handle = connectedHandle(vi.fn().mockRejectedValueOnce(remoteFailure));
    transportMocks.createOrpc.mockResolvedValueOnce(handle);

    const failure = await requestSparkDaemon("daemon.stop", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SparkDaemonRemoteError);
    expect(failure).toMatchObject({
      message: "mutation rejected",
      payload: {
        revision: 4,
        message: "mutation rejected",
        code: "CONFLICT",
        status: 409,
        defined: false,
        data: { revision: 4 },
      },
    });
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("diagnoses malformed connected output as a protocol mismatch", async () => {
    const schemaFailure = Object.assign(new Error("invalid daemon response"), {
      name: "ZodError",
      issues: [{ path: ["process", "protocolVersion"] }],
    });
    const handle = connectedHandle(vi.fn().mockRejectedValueOnce(schemaFailure));
    transportMocks.createOrpc.mockResolvedValueOnce(handle);

    const failure = await requestSparkDaemon("daemon.status", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SparkDaemonProtocolMismatchError);
    expect(failure).toMatchObject({ method: "daemon.status", cause: schemaFailure });
    expect((failure as Error).message).toContain("client protocol");
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([
    Object.assign(new Error("Spark daemon oRPC connection closed before a response."), {
      name: "AbortError",
    }),
    new Error("Socket MessagePort frame exceeded 64 bytes."),
  ])("fails closed after a post-connect transport failure: %s", async (failure) => {
    const handle = connectedHandle(vi.fn().mockRejectedValueOnce(failure));
    transportMocks.createOrpc.mockResolvedValueOnce(handle);

    const normalized = await requestSparkDaemon(
      "daemon.status",
      {},
      { maxResponseBytes: 64 },
    ).catch((error: unknown) => error);
    expect(normalized).toBeInstanceOf(SparkDaemonRpcError);
    expect(normalized).toMatchObject({
      message: `Spark daemon oRPC transport failed: ${failure.message}`,
      cause: failure,
    });
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight oRPC call without replaying it", async () => {
    const invoke = vi.fn().mockReturnValue(new Promise(() => {}));
    const handle = connectedHandle(invoke);
    const controller = new AbortController();
    transportMocks.createOrpc.mockResolvedValueOnce(handle);

    const result = requestSparkDaemon(
      "daemon.status",
      {},
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[2]).toMatchObject({
      signal: expect.objectContaining({ aborted: true }),
    });
  });

  it("does not open either transport for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestSparkDaemon("daemon.status", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transportMocks.createOrpc).not.toHaveBeenCalled();
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
  });

  it("enforces the response timeout after connect without legacy replay", async () => {
    vi.useFakeTimers();
    const handle = connectedHandle(vi.fn().mockReturnValue(new Promise(() => {})));
    transportMocks.createOrpc.mockResolvedValueOnce(handle);

    const result = requestSparkDaemon(
      "daemon.status",
      {},
      {
        responseTimeoutMs: 25,
      },
    );
    const failure = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    await expect(failure).resolves.toBeInstanceOf(SparkDaemonRpcError);
    await expect(failure).resolves.toMatchObject({
      message: "Timed out waiting for daemon oRPC response after 25 ms.",
    });
    expect(transportMocks.requestLegacy).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("merges factory defaults while allowing per-request socket overrides", async () => {
    const handle = connectedHandle(vi.fn().mockResolvedValueOnce("typed-result"));
    transportMocks.createOrpc.mockResolvedValueOnce(handle);
    const client = createSparkDaemonClient({
      orpcSocketPath: "/tmp/default-orpc.sock",
      responseTimeoutMs: 5_000,
      maxResponseBytes: 1024,
    });

    await expect(
      client.request(
        "daemon.status",
        {},
        {
          orpcSocketPath: "/tmp/override-orpc.sock",
        },
      ),
    ).resolves.toBe("typed-result");
    expect(transportMocks.createOrpc).toHaveBeenCalledWith({
      socketPath: "/tmp/override-orpc.sock",
      maxResponseBytes: 1024,
    });
  });
});

function connectedHandle(invoke: ReturnType<typeof vi.fn>) {
  return {
    client: {},
    port: {},
    invoke,
    close: vi.fn(),
  };
}
