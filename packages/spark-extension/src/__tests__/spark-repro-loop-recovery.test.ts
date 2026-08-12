import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  sparkLoopCountersSchema,
  sparkLoopPolicySchema,
  type SparkLoopView,
} from "@zendev-lab/spark-protocol";
import {
  ensureActiveReproLoop,
  type SparkReproLoopHealth,
} from "../extension/spark-repro-tool-registration.ts";
import { createSparkSessionRepro } from "../extension/spark-session-repro.ts";
import type { SparkDaemonLoopControl } from "../extension/spark-daemon-loop-client.ts";
import type { SparkToolContext } from "../extension/spark-tool-registration.ts";

function loopView(status: SparkLoopView["status"]): SparkLoopView {
  return {
    loopId: "repro-loop",
    binding: { reproId: "repro-loop" },
    ownerSessionId: "session-test",
    status,
    sessionLifetime: "driver",
    continuity: "session",
    generation: 1,
    policy: sparkLoopPolicySchema.parse({}),
    counters: sparkLoopCountersSchema.parse({}),
    attempt: 0,
  };
}

function control(existing?: SparkLoopView) {
  const start = vi.fn(async () => ({
    loop: loopView("scheduled"),
    observedAt: "2026-07-28T00:00:00.000Z",
  }));
  const value: SparkDaemonLoopControl = {
    start,
    list: vi.fn(async () => ({
      loops: existing ? [existing] : [],
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
  const cwd = mkdtempSync(join(tmpdir(), "spark-repro-loop-recovery-"));
  tempDirs.push(cwd);
  return {
    cwd,
    sessionId: "session-test",
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repro() {
  return { ...createSparkSessionRepro("session:test"), reproId: "repro-loop" };
}

test("active repro recreates a missing daemon loop", async () => {
  const { value, start } = control();
  const health = await ensureActiveReproLoop(context(), value, repro());

  expect(health).toMatchObject<SparkReproLoopHealth>({
    status: "scheduled",
    recovered: true,
  });
  expect(start).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      loopId: "repro-loop",
      binding: {
        goalId: expect.any(String),
        workflowRunId: "workflow-run:repro-loop",
        workflowSelector: "builtin:repro",
        reproId: "repro-loop",
      },
      ownerSessionId: "session-test",
      sessionLifetime: "driver",
      cwd: expect.stringContaining("spark-repro-loop-recovery-"),
    }),
  );
});

test.each(["scheduled", "running", "retry_wait", "dormant", "blocked"] as const)(
  "active repro migrates an existing %s daemon loop to unified bindings",
  async (status) => {
    const existing = loopView(status);
    const { value, start } = control(existing);
    const health = await ensureActiveReproLoop(context(), value, repro());

    expect(health).toMatchObject({ status: "scheduled", recovered: true });
    expect(start).toHaveBeenCalledOnce();
  },
);

test("active repro does not recover an explicitly stopped daemon loop", async () => {
  const existing = loopView("stopped");
  const { value, start } = control(existing);

  const health = await ensureActiveReproLoop(context(), value, repro());

  expect(health).toEqual({ status: "stopped", recovered: false, loop: existing });
  expect(start).not.toHaveBeenCalled();
});

test.each(["dormant", "stopped"] as const)(
  "explicit repro start reschedules a %s daemon loop",
  async (status) => {
    const { value, start } = control(loopView(status));
    const health = await ensureActiveReproLoop(context(), value, repro(), {
      forceSchedule: true,
      reason: "explicit repro start",
    });

    expect(health).toMatchObject({ status: "scheduled", recovered: true });
    expect(start).toHaveBeenCalledOnce();
  },
);

test("daemon transport failures are visible and do not claim recovery", async () => {
  const { value, start } = control();
  value.list = vi.fn(async () => {
    throw new Error("protocol mismatch");
  });

  await expect(ensureActiveReproLoop(context(), value, repro())).resolves.toEqual({
    status: "unreachable",
    recovered: false,
    error: "protocol mismatch",
  });
  expect(start).not.toHaveBeenCalled();
});
