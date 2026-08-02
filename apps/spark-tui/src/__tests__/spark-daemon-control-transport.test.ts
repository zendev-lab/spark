import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("@zendev-lab/spark-daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zendev-lab/spark-daemon-client")>()),
  requestSparkDaemon: mocks.request,
}));

import { requestSparkDaemonControl } from "../cli/daemon.ts";

const paths = {
  runtimeDir: "/tmp/spark-control-transport",
  socketPath: "/tmp/spark-control-transport/daemon.sock",
  pidFile: "/tmp/spark-control-transport/daemon.pid",
  lockPath: "/tmp/spark-control-transport/daemon.lock",
};
const client = {
  paths,
  startService: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("daemon control transport migration", () => {
  it("delegates protocol selection and pre-dispatch fallback to the unified facade", async () => {
    mocks.request.mockResolvedValueOnce({ source: "daemon-client" });

    await expect(
      requestSparkDaemonControl("side-thread.ensure", { parentSessionId: "parent" }, client),
    ).resolves.toEqual({ source: "daemon-client" });
    expect(mocks.request).toHaveBeenCalledWith(
      "side-thread.ensure",
      { parentSessionId: "parent" },
      {
        paths: { runtimeDir: paths.runtimeDir },
        legacySocketPath: paths.socketPath,
      },
    );
  });

  it("propagates a post-connect facade failure without adding another retry path", async () => {
    mocks.request.mockRejectedValueOnce(new Error("connection closed after dispatch"));

    await expect(
      requestSparkDaemonControl(
        "side-thread.reset",
        { parentSessionId: "parent", expectedGeneration: 1, mode: "contextual" },
        client,
      ),
    ).rejects.toThrow("connection closed after dispatch");
    expect(mocks.request).toHaveBeenCalledOnce();
  });

  it("preserves the caller-provided control request injection seam", async () => {
    const controlRequest = vi.fn().mockResolvedValueOnce({
      parentSessionId: "parent",
      sessionId: "side",
      generation: 1,
      mode: "contextual",
      status: "idle",
    });

    await expect(
      requestSparkDaemonControl(
        "side-thread.snapshot",
        { parentSessionId: "parent" },
        { ...client, controlRequest },
      ),
    ).resolves.toEqual({
      parentSessionId: "parent",
      sessionId: "side",
      generation: 1,
      mode: "contextual",
      status: "idle",
      pendingTurns: [],
      exchanges: [],
      hasMore: false,
      projectionTruncated: false,
    });
    expect(controlRequest).toHaveBeenCalledWith("side-thread.snapshot", {
      parentSessionId: "parent",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("validates injected control responses against the method contract", async () => {
    const controlRequest = vi.fn().mockResolvedValueOnce({ source: "not-a-snapshot" });

    await expect(
      requestSparkDaemonControl(
        "side-thread.snapshot",
        { parentSessionId: "parent" },
        { ...client, controlRequest },
      ),
    ).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
