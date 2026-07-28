import { expect, test, vi } from "vitest";
import type { SparkDriverView } from "@zendev-lab/spark-protocol";
import {
  ensureActiveReproDriver,
  type SparkReproDriverHealth,
} from "../packages/spark-extension/src/extension/spark-repro-tool-registration.ts";
import { createSparkSessionRepro } from "../packages/spark-extension/src/extension/spark-session-repro.ts";
import type { SparkDaemonDriverControl } from "../packages/spark-extension/src/extension/spark-daemon-driver-client.ts";
import type { SparkToolContext } from "../packages/spark-extension/src/extension/spark-tool-registration.ts";

function driver(status: SparkDriverView["status"]): SparkDriverView {
  return {
    driverId: "repro-driver",
    kind: "repro",
    ownerSessionId: "session-test",
    status,
    continuity: "session",
    attempt: 0,
  };
}

function control(existing?: SparkDriverView) {
  const start = vi.fn(async () => ({
    driver: driver("scheduled"),
    observedAt: "2026-07-28T00:00:00.000Z",
  }));
  const value: SparkDaemonDriverControl = {
    start,
    list: vi.fn(async () => ({
      drivers: existing ? [existing] : [],
      observedAt: "2026-07-28T00:00:00.000Z",
    })),
    stop: vi.fn(),
    restart: vi.fn(),
    wake: vi.fn(),
    schedule: vi.fn(),
    ensureOwnerSession: vi.fn(),
  };
  return { value, start };
}

function context(): SparkToolContext {
  return {
    cwd: "/workspace",
    sessionId: "session-test",
  };
}

function repro() {
  return { ...createSparkSessionRepro("session:test"), reproId: "repro-driver" };
}

test("active repro recreates a missing daemon driver", async () => {
  const { value, start } = control();
  const health = await ensureActiveReproDriver(context(), value, repro());

  expect(health).toMatchObject<SparkReproDriverHealth>({
    status: "scheduled",
    recovered: true,
  });
  expect(start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      driverId: "repro-driver",
      kind: "repro",
      ownerSessionId: "session-test",
      continuity: "session",
      cwd: "/workspace",
    }),
  );
});

test.each(["scheduled", "running", "retry_wait", "dormant", "blocked"] as const)(
  "active repro preserves an existing %s daemon driver",
  async (status) => {
    const existing = driver(status);
    const { value, start } = control(existing);
    const health = await ensureActiveReproDriver(context(), value, repro());

    expect(health).toEqual({ status, recovered: false, driver: existing });
    expect(start).not.toHaveBeenCalled();
  },
);

test("explicit repro start reschedules a dormant daemon driver", async () => {
  const { value, start } = control(driver("dormant"));
  const health = await ensureActiveReproDriver(context(), value, repro(), {
    forceSchedule: true,
    reason: "explicit repro start",
  });

  expect(health).toMatchObject({ status: "scheduled", recovered: true });
  expect(start).toHaveBeenCalledOnce();
});

test("daemon transport failures are visible and do not claim recovery", async () => {
  const { value, start } = control();
  value.list = vi.fn(async () => {
    throw new Error("protocol mismatch");
  });

  await expect(ensureActiveReproDriver(context(), value, repro())).resolves.toEqual({
    status: "unreachable",
    recovered: false,
    error: "protocol mismatch",
  });
  expect(start).not.toHaveBeenCalled();
});
