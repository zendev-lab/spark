import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SparkDaemonLoopTickTask } from "../core/types.ts";
import type { SparkInvocationStore } from "./invocations.ts";
import type { SparkLoopStore } from "./loops.ts";

export interface SparkLoopStoreContractHarness {
  db: DatabaseSync;
  invocations: SparkInvocationStore;
  loops: SparkLoopStore;
  close(): void;
}

export function runSparkLoopStoreContract(
  createHarness: () => SparkLoopStoreContractHarness,
): void {
  describe("SparkLoopStore contract", () => {
    it("coalesces a due Loop while its owner Session is busy", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "loop-one",
          ownerSessionId: "session-one",
          cwd: "/workspace",
          prompt: "tick",
          dueAt: "2026-07-23T00:00:00.000Z",
        });
        const busy = harness.invocations.submit({
          sessionId: "session-one",
          prompt: "foreground",
          now: "2026-07-23T00:00:00.000Z",
        });
        expect(await harness.loops.materializeDue("2026-07-23T00:00:01.000Z")).toBeUndefined();
        expect(harness.loops.require("loop-one").status).toBe("scheduled");
        harness.invocations.requestCancellation(
          busy.invocationId,
          "foreground complete",
          "2026-07-23T00:00:02.000Z",
        );
        expect(
          (await harness.loops.materializeDue("2026-07-23T00:00:03.000Z"))?.invocation?.task,
        ).toMatchObject({
          type: "loop.tick",
          loopId: "loop-one",
          ownerSessionId: "session-one",
        });
        expect(await harness.loops.materializeDue("2026-07-23T00:00:04.000Z")).toBeUndefined();
      } finally {
        harness.close();
      }
    });

    it("does not let one busy owner starve another owner's due Loop", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "busy-owner-loop",
          ownerSessionId: "busy-owner",
          cwd: "/workspace",
          prompt: "busy tick",
          dueAt: "2026-07-23T00:00:00.000Z",
        });
        harness.loops.start({
          loopId: "free-owner-loop",
          ownerSessionId: "free-owner",
          cwd: "/workspace",
          prompt: "free tick",
          dueAt: "2026-07-23T00:00:01.000Z",
        });
        harness.invocations.submit({
          sessionId: "busy-owner",
          prompt: "foreground",
          now: "2026-07-23T00:00:00.000Z",
        });

        expect(
          (await harness.loops.materializeDue("2026-07-23T00:00:02.000Z"))?.invocation?.sourceRef,
        ).toBe("free-owner-loop");
        expect(harness.loops.require("busy-owner-loop")).toMatchObject({
          status: "scheduled",
          dueAt: "2026-07-23T00:00:00.000Z",
        });
      } finally {
        harness.close();
      }
    });

    it("allows at most one active Loop per Session", () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "goal-loop",
          ownerSessionId: "owner",
          binding: { goalId: "goal-1" },
          cwd: "/workspace",
          prompt: "goal tick",
        });
        harness.loops.start({
          loopId: "repro-loop",
          ownerSessionId: "owner",
          binding: { reproId: "repro-1" },
          cwd: "/workspace",
          prompt: "repro tick",
        });
        expect(harness.loops.require("goal-loop").status).toBe("stopped");
        expect(harness.loops.require("repro-loop").status).toBe("scheduled");
      } finally {
        harness.close();
      }
    });

    it("materializes one generation-fenced loop.tick", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "repro-loop",
          ownerSessionId: "owner",
          binding: { reproId: "repro-1" },
          cwd: "/workspace",
          prompt: "tick",
        });
        const submitted = (await harness.loops.materializeDue())!;
        const task = submitted.invocation!.task as SparkDaemonLoopTickTask;
        expect(task).toMatchObject({
          type: "loop.tick",
          loopId: "repro-loop",
          generation: 1,
          binding: { reproId: "repro-1" },
        });
        expect(harness.loops.require("repro-loop")).toMatchObject({
          status: "running",
          cycleStep: "invoke",
        });
        expect(() =>
          harness.loops.schedule({ loopId: "repro-loop", generation: 2, delayMs: 1000 }),
        ).toThrow(/LOOP_GENERATION_CONFLICT/u);
      } finally {
        harness.close();
      }
    });

    it("settles a successful tick dormant without replaying it", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "bare-loop",
          ownerSessionId: "owner",
          cwd: "/workspace",
          prompt: "tick",
        });
        await harness.loops.materializeDue();
        const invocation = harness.invocations.claimNext("worker")!;
        const settled = harness.loops.completeTick(
          invocation,
          invocation.task as SparkDaemonLoopTickTask,
          { status: "succeeded" },
        );
        expect(settled.loop).toMatchObject({ status: "dormant", generation: 2 });
        expect(await harness.loops.materializeDue()).toBeUndefined();
      } finally {
        harness.close();
      }
    });

    it("keeps an explicit generation schedule when the old tick completes", async () => {
      const harness = createHarness();
      try {
        const { invocation, task } = await runningTick(harness, "loop-cas", "session-cas");
        expect(
          harness.loops.schedule(
            { loopId: task.loopId, generation: task.generation, delayMs: 5_000 },
            "2026-07-23T00:00:02.000Z",
          ),
        ).toMatchObject({
          generation: 1,
          status: "running",
          cycleStep: "invoke",
        });

        expect(
          harness.loops.completeTick(invocation, task, {
            status: "succeeded",
            now: "2026-07-23T00:00:03.000Z",
          }).loop,
        ).toMatchObject({
          generation: 2,
          status: "scheduled",
          dueAt: "2026-07-23T00:00:07.000Z",
        });
        expect(() =>
          harness.loops.schedule(
            { loopId: task.loopId, generation: task.generation, delayMs: 1_000 },
            "2026-07-23T00:00:04.000Z",
          ),
        ).toThrow(/LOOP_GENERATION_CONFLICT/u);
      } finally {
        harness.close();
      }
    });

    it("reconciles a terminal invocation left beside an unsettled running Loop", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-terminal", "session-terminal");
        harness.invocations.complete(tick.invocation.invocationId, {
          status: "succeeded",
          now: "2026-07-23T00:00:00.000Z",
        });

        expect(harness.loops.reconcileTerminalTicks("2026-07-23T00:00:01.000Z")).toEqual([
          expect.objectContaining({
            loopId: "loop-terminal",
            generation: 2,
            status: "dormant",
          }),
        ]);
      } finally {
        harness.close();
      }
    });

    it("retries safe failures and blocks unknown or cancelled outcomes", async () => {
      const harness = createHarness();
      try {
        const retryTick = await runningTick(harness, "loop-retry", "session-retry");
        expect(
          harness.loops.completeTick(retryTick.invocation, retryTick.task, {
            status: "failed",
            errorCode: "EXECUTOR_TIMEOUT",
            now: "2026-07-23T00:00:00.000Z",
          }).loop,
        ).toMatchObject({
          status: "retry_wait",
          attempt: 1,
          dueAt: "2026-07-23T00:00:30.000Z",
        });
        harness.loops.stop("loop-retry", "continue failure assertions");

        const unknown = await runningTick(harness, "loop-unknown", "session-unknown");
        expect(
          harness.loops.completeTick(unknown.invocation, unknown.task, {
            status: "failed",
            errorMessage: "outcome unknown",
          }).loop,
        ).toMatchObject({ status: "blocked", attempt: 0 });

        const cancelled = await runningTick(harness, "loop-abort", "session-abort");
        expect(
          harness.loops.completeTick(cancelled.invocation, cancelled.task, {
            status: "cancelled",
            cancelReason: "user abort",
          }).loop,
        ).toMatchObject({ status: "blocked", reason: "manual abort" });
      } finally {
        harness.close();
      }
    });

    it("authors a driver_tick child Session instead of a hidden execution alias", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "loop-fresh",
          ownerSessionId: "owner-session",
          continuity: "fresh",
          cwd: "/workspace",
          prompt: "fresh tick",
          now: "2026-07-23T00:00:00.000Z",
        });
        const invocation = (await harness.loops.materializeDue())!.invocation!;
        expect(invocation.task).toMatchObject({
          type: "loop.tick",
          sessionId: expect.stringMatching(/^driver_tick_[0-9a-f]{24}_1_[0-9a-f]{12}$/u),
          ownerSessionId: "owner-session",
          sessionLifetime: "driver_tick",
          reset: true,
        });
        const executionSessionId = (invocation.task as SparkDaemonLoopTickTask).sessionId;
        expect(invocation.sessionId).toBe(executionSessionId);
        const running = harness.invocations.claimNext("fresh-worker")!;
        harness.loops.completeTick(running, running.task as SparkDaemonLoopTickTask, {
          status: "succeeded",
          result: { sessionPath: `/daemon/private/${executionSessionId}.jsonl` },
          now: "2026-07-23T00:00:00.000Z",
        });
        expect(
          harness.db
            .prepare("SELECT 1 FROM loop_hidden_sessions WHERE execution_session_id = ?")
            .get(executionSessionId),
        ).toBeUndefined();
      } finally {
        harness.close();
      }
    });

    it("creates a new driver Session incarnation after a terminal restart", () => {
      const harness = createHarness();
      try {
        const first = harness.loops.start({
          loopId: "loop-driver-restart",
          ownerSessionId: "owner-driver-restart",
          sessionLifetime: "driver",
          cwd: "/workspace",
          prompt: "first driver",
        });
        harness.loops.stop(first.loopId, "first incarnation complete");
        const restarted = harness.loops.start({
          loopId: first.loopId,
          ownerSessionId: first.ownerSessionId,
          sessionLifetime: "driver",
          cwd: "/workspace",
          prompt: "second driver",
        });

        expect(restarted.driverSessionId).not.toBe(first.driverSessionId);
        expect(restarted.driverSessionId).toMatch(/^driver_[0-9a-f]{24}_3$/u);
      } finally {
        harness.close();
      }
    });

    it("preserves a live driver only while the Loop owner remains unchanged", () => {
      const harness = createHarness();
      try {
        const first = harness.loops.start({
          loopId: "loop-driver-transfer",
          ownerSessionId: "owner-driver-before",
          sessionLifetime: "driver",
          cwd: "/workspace",
          prompt: "first owner",
        });
        const continued = harness.loops.start({
          loopId: first.loopId,
          ownerSessionId: first.ownerSessionId,
          sessionLifetime: "driver",
          cwd: "/workspace",
          prompt: "same owner",
        });
        const transferred = harness.loops.start({
          loopId: first.loopId,
          ownerSessionId: "owner-driver-after",
          sessionLifetime: "driver",
          cwd: "/workspace",
          prompt: "second owner",
        });

        expect(continued.driverSessionId).toBe(first.driverSessionId);
        expect(transferred.driverSessionId).not.toBe(continued.driverSessionId);
        expect(transferred).toMatchObject({
          ownerSessionId: "owner-driver-after",
          generation: 3,
        });
      } finally {
        harness.close();
      }
    });

    it("consumes a manual wake prompt exactly once", async () => {
      const harness = createHarness();
      try {
        harness.loops.start({
          loopId: "loop-wake",
          ownerSessionId: "owner-wake",
          cwd: "/workspace",
          prompt: "base objective",
        });
        harness.loops.stop("loop-wake", "manual wait");
        harness.loops.wake("loop-wake", {
          prompt: "one-shot instruction",
          now: "2026-07-23T00:00:00.000Z",
        });
        expect(
          (await harness.loops.materializeDue("2026-07-23T00:00:00.000Z"))?.invocation?.task,
        ).toMatchObject({ prompt: "one-shot instruction" });
        expect(harness.loops.require("loop-wake").prompt).toBe("base objective");
        expect(harness.loops.require("loop-wake").wakePrompt).toBeUndefined();
      } finally {
        harness.close();
      }
    });

    it("garbage-collects migrated legacy hidden Sessions and retains failed removals", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-fresh-gc", "owner-fresh-gc", "fresh");
        const executionSessionId = tick.task.sessionId;
        harness.loops.completeTick(tick.invocation, tick.task, {
          status: "succeeded",
          result: { sessionPath: `/daemon/private/${executionSessionId}.jsonl` },
          now: "2026-07-23T00:00:00.000Z",
        });
        harness.db
          .prepare(
            `INSERT INTO loop_hidden_sessions
              (execution_session_id, loop_id, generation, invocation_id, status, session_path,
               created_at, archived_at, gc_after)
             VALUES (?, ?, ?, ?, 'archived', ?, ?, ?, ?)`,
          )
          .run(
            executionSessionId,
            tick.task.loopId,
            tick.task.generation,
            tick.invocation.invocationId,
            `/daemon/private/${executionSessionId}.jsonl`,
            "2026-07-23T00:00:00.000Z",
            "2026-07-23T00:00:00.000Z",
            "2026-07-24T00:00:00.000Z",
          );
        expect(
          await harness.loops.gcHiddenSessions("2026-07-24T00:00:00.000Z", async () => {
            throw new Error("filesystem busy");
          }),
        ).toMatchObject({ examined: 1, deleted: 0, errors: [{ message: "filesystem busy" }] });
        const removed: string[] = [];
        expect(
          await harness.loops.gcHiddenSessions("2026-07-24T00:00:01.000Z", async (path) => {
            removed.push(path);
          }),
        ).toEqual({ examined: 1, deleted: 1, errors: [] });
        expect(removed).toEqual([`/daemon/private/${executionSessionId}.jsonl`]);
      } finally {
        harness.close();
      }
    });

    it("requests cancellation when a running Loop is stopped", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-stop", "owner-stop");
        harness.loops.stop("loop-stop", "user stopped the loop");
        expect(harness.loops.require("loop-stop").status).toBe("stopped");
        expect(harness.invocations.require(tick.invocation.invocationId)).toMatchObject({
          status: "running",
          cancelReason: "user stopped the loop",
        });
      } finally {
        harness.close();
      }
    });
  });
}

async function runningTick(
  harness: SparkLoopStoreContractHarness,
  loopId: string,
  ownerSessionId: string,
  continuity: "session" | "fresh" = "session",
): Promise<{
  invocation: NonNullable<ReturnType<SparkInvocationStore["claimNext"]>>;
  task: SparkDaemonLoopTickTask;
}> {
  harness.loops.start({
    loopId,
    ownerSessionId,
    continuity,
    cwd: "/workspace",
    prompt: "tick",
  });
  await harness.loops.materializeDue();
  const invocation = harness.invocations.claimNext("worker")!;
  return { invocation, task: invocation.task as SparkDaemonLoopTickTask };
}
