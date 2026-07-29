import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkDaemonClient } from "./daemon-client.js";
import {
  startSparkDaemonSessionHeartbeat,
  type SparkDaemonSessionHeartbeatEvent,
} from "./session-heartbeat.js";

import {
  heartbeatClientWithResults as clientWithResults,
  heartbeatLeaseResult as leaseResult,
  heartbeatReleasedResult as releasedResult,
  heartbeatTestAttachInput as attachInput,
} from "./session-heartbeat.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Spark daemon session heartbeat manager", () => {
  it("keeps timer-driven heartbeats single-flight across one hundred intervals", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    let heartbeatCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "workspace.client.attach") return leaseResult("fence-1");
      if (method === "workspace.client.heartbeat") {
        active += 1;
        maxActive = Math.max(maxActive, active);
        heartbeatCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return leaseResult("fence-1");
      }
      if (method === "workspace.client.release") return releasedResult("fence-1");
      throw new Error(`Unexpected method: ${method}`);
    });
    const handle = await startSparkDaemonSessionHeartbeat({
      attach: attachInput,
      client: { request } as SparkDaemonClient,
      heartbeatIntervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(heartbeatCount).toBe(100);
    expect(maxActive).toBe(1);
    await handle.stop();
  });

  it("backs off after a transient heartbeat failure and reattaches with a new fence", async () => {
    vi.useFakeTimers();
    const events: SparkDaemonSessionHeartbeatEvent[] = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce(leaseResult("fence-1"))
      .mockRejectedValueOnce(new Error("daemon restarting"))
      .mockResolvedValueOnce(leaseResult("fence-2"))
      .mockResolvedValueOnce(releasedResult("fence-2"));
    const handle = await startSparkDaemonSessionHeartbeat({
      attach: attachInput,
      client: { request } as SparkDaemonClient,
      heartbeatIntervalMs: 20,
      retryBaseDelayMs: 5,
      retryMaxDelayMs: 20,
      onEvent: (event) => events.push(event),
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(events[1]).toMatchObject({ type: "retry", attempt: 1, delayMs: 5 });
    await vi.advanceTimersByTimeAsync(5);

    expect(handle.lease).toMatchObject({
      clientId: "surface-1",
      sessionId: "session-1",
      leaseFence: "fence-2",
    });
    expect(request.mock.calls).toEqual([
      ["workspace.client.attach", attachInput],
      [
        "workspace.client.heartbeat",
        { clientId: "surface-1", leaseFence: "fence-1", leaseTtlMs: 60_000 },
      ],
      ["workspace.client.attach", attachInput],
    ]);
    expect(events.map((event) => event.type)).toEqual(["attached", "retry", "reattached"]);
    await handle.stop();
    expect(request).toHaveBeenLastCalledWith("workspace.client.release", {
      clientId: "surface-1",
      leaseFence: "fence-2",
    });
  });

  it("stops scheduling immediately and releases at most once", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(leaseResult("fence-1"))
      .mockResolvedValueOnce(releasedResult("fence-1"));
    const handle = await startSparkDaemonSessionHeartbeat({
      attach: attachInput,
      client: { request } as SparkDaemonClient,
      heartbeatIntervalMs: 10,
    });

    const firstStop = handle.stop();
    const secondStop = handle.stop();
    await expect(Promise.all([firstStop, secondStop])).resolves.toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("workspace.client.release", {
      clientId: "surface-1",
      leaseFence: "fence-1",
    });
    await handle.heartbeat();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when attach returns an unfenced or mismatched session lease", async () => {
    const unfenced = leaseResult(undefined);
    const mismatched = leaseResult("fence-1", { sessionId: "session-other" });

    await expect(
      startSparkDaemonSessionHeartbeat({
        attach: attachInput,
        client: clientWithResults(unfenced),
      }),
    ).rejects.toThrow("unfenced session lease");
    await expect(
      startSparkDaemonSessionHeartbeat({
        attach: attachInput,
        client: clientWithResults(mismatched),
      }),
    ).rejects.toThrow("different sessionId");
  });

  it("releases the replacement fence when stop races an in-flight reattach", async () => {
    let attachCount = 0;
    let resolveReattach: ((result: ReturnType<typeof leaseResult>) => void) | undefined;
    const reattachResult = new Promise<ReturnType<typeof leaseResult>>((resolve) => {
      resolveReattach = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "workspace.client.attach") {
        attachCount += 1;
        return attachCount === 1 ? leaseResult("fence-1") : await reattachResult;
      }
      if (method === "workspace.client.heartbeat") throw new Error("daemon restarting");
      if (method === "workspace.client.release") return releasedResult("fence-2");
      throw new Error(`Unexpected method: ${method}`);
    });
    const handle = await startSparkDaemonSessionHeartbeat({
      attach: attachInput,
      client: { request } as SparkDaemonClient,
      heartbeatIntervalMs: 60_000,
    });

    await handle.heartbeat();
    const reattaching = handle.heartbeat();
    await vi.waitFor(() => expect(attachCount).toBe(2));
    const stopping = handle.stop();
    resolveReattach?.(leaseResult("fence-2"));
    await Promise.all([reattaching, stopping]);

    expect(request).toHaveBeenLastCalledWith("workspace.client.release", {
      clientId: "surface-1",
      leaseFence: "fence-2",
    });
  });

  it("reports a failed release and leaves expiry to the daemon TTL", async () => {
    const events: SparkDaemonSessionHeartbeatEvent[] = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce(leaseResult("fence-1"))
      .mockRejectedValueOnce(new Error("daemon unavailable"));
    const handle = await startSparkDaemonSessionHeartbeat({
      attach: attachInput,
      client: { request } as SparkDaemonClient,
      onEvent: (event) => events.push(event),
    });

    await expect(handle.stop()).rejects.toThrow("daemon unavailable");
    expect(events.at(-1)).toMatchObject({
      type: "release_failed",
      lease: { leaseFence: "fence-1" },
    });
    await expect(handle.stop()).rejects.toThrow("daemon unavailable");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
