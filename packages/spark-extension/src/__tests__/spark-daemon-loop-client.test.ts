import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SparkDaemonRemoteError,
  SparkDaemonUnavailableError,
} from "@zendev-lab/spark-daemon-client";

const { ensureSparkDaemonRunningMock, requestSparkDaemonMock } = vi.hoisted(() => ({
  ensureSparkDaemonRunningMock: vi.fn(),
  requestSparkDaemonMock: vi.fn(),
}));

vi.mock("@zendev-lab/spark-daemon-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zendev-lab/spark-daemon-client")>()),
  ensureSparkDaemonRunning: ensureSparkDaemonRunningMock,
  requestSparkDaemon: requestSparkDaemonMock,
}));

import { sparkDaemonLoopControl } from "../extension/spark-daemon-loop-client.ts";

const ownerInput = { sessionId: "pi-session", cwd: "/workspace/demo" };
const ownerSession = {
  sessionId: ownerInput.sessionId,
  scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
  workspaceId: "workspace-1",
  cwd: ownerInput.cwd,
  status: "ready" as const,
  bindings: [],
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
};

describe("Spark daemon Pi owner compatibility", () => {
  beforeEach(() => {
    ensureSparkDaemonRunningMock.mockReset().mockResolvedValue(undefined);
    requestSparkDaemonMock.mockReset();
  });

  it("accepts the facade remote-error class for an existing persistent session", async () => {
    requestSparkDaemonMock.mockImplementation(async (method: string) => {
      if (method === "workspace.ensure-local") return { id: "workspace-1" };
      if (method === "session.create") {
        throw new SparkDaemonRemoteError("session_exists", { code: "session_exists" });
      }
      if (method === "session.get") return ownerSession;
      throw new Error(`unexpected daemon method: ${method}`);
    });

    await expect(sparkDaemonLoopControl.ensureOwnerSession?.(ownerInput)).resolves.toBeUndefined();
    expect(ensureSparkDaemonRunningMock).toHaveBeenCalledOnce();
    expect(requestSparkDaemonMock.mock.calls.map(([method]) => method)).toEqual([
      "workspace.ensure-local",
      "session.create",
      "session.get",
    ]);
  });

  it("does not register owner state when daemon startup fails", async () => {
    const unavailable = new Error("daemon failed to start");
    ensureSparkDaemonRunningMock.mockRejectedValue(unavailable);

    await expect(sparkDaemonLoopControl.ensureOwnerSession?.(ownerInput)).rejects.toBe(unavailable);
    expect(requestSparkDaemonMock).not.toHaveBeenCalled();
  });

  it("does not misclassify facade unavailable errors as an existing session", async () => {
    const unavailable = new SparkDaemonUnavailableError("daemon unavailable");
    requestSparkDaemonMock
      .mockResolvedValueOnce({ id: "workspace-1" })
      .mockRejectedValueOnce(unavailable);

    await expect(sparkDaemonLoopControl.ensureOwnerSession?.(ownerInput)).rejects.toBe(unavailable);
    expect(requestSparkDaemonMock).toHaveBeenCalledTimes(2);
  });

  it("does not infer session existence from a remote error message", async () => {
    const remote = new SparkDaemonRemoteError("session already exists", {
      code: "internal_error",
    });
    requestSparkDaemonMock
      .mockResolvedValueOnce({ id: "workspace-1" })
      .mockRejectedValueOnce(remote);

    await expect(sparkDaemonLoopControl.ensureOwnerSession?.(ownerInput)).rejects.toBe(remote);
    expect(requestSparkDaemonMock).toHaveBeenCalledTimes(2);
  });
});
