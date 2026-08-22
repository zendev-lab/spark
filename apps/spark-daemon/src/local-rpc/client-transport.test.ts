import { SparkDaemonConnectedTransportError } from "@zendev-lab/spark-daemon-client";
import { describe, expect, it, vi } from "vitest";
import { localRpcRequest } from "./client-transport.ts";
import { LocalRpcUnavailableError } from "./types.ts";

const requestSparkDaemon = vi.hoisted(() => vi.fn());

vi.mock("@zendev-lab/spark-daemon-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zendev-lab/spark-daemon-client")>();
  return { ...actual, requestSparkDaemon };
});

describe("local RPC client transport", () => {
  it("preserves connected transport failures as retryable availability errors", async () => {
    requestSparkDaemon.mockRejectedValueOnce(
      new SparkDaemonConnectedTransportError(
        "daemon.status",
        "Spark daemon oRPC transport failed: connection closed during restart handoff",
      ),
    );

    const failure = await localRpcRequest(
      { runtimeDir: "/tmp/spark-runtime" } as never,
      "daemon.status",
      {},
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LocalRpcUnavailableError);
    expect(failure).toMatchObject({
      message: "Spark daemon oRPC transport failed: connection closed during restart handoff",
    });
    expect(requestSparkDaemon).toHaveBeenCalledOnce();
  });
});
