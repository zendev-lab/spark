import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SparkGitDraftTarget } from "@zendev-lab/spark-core";
import type { SparkDaemonLoopTickTask } from "../core/types.ts";
import type { SparkInvocationStore } from "./invocations.ts";
import { loopUpdateEvent, SparkLoopStore } from "./loops.ts";

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

    it("binds one exact Git Draft target per active driver incarnation", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-draft-bind", "owner-draft-bind");
        const first = gitDraftTarget("artifact:first", "/workspace/first", "/repo/.git");
        const changedPath = gitDraftTarget("artifact:first", "/workspace/changed", "/repo/.git");
        const changedCommonDir = gitDraftTarget(
          "artifact:first",
          "/workspace/first",
          "/other/.git",
        );
        const changedRemote = {
          ...first,
          repository: "other/repo",
          remoteUrls: ["git@github.com:other/repo.git"],
          pushUrls: ["git@github.com:other/repo.git"],
        };
        const second = gitDraftTarget("artifact:second", "/workspace/second", "/repo/.git");

        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            tick.task,
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(false);

        expect(
          harness.loops.bindGitDraftTarget(tick.task, tick.invocation.invocationId, first),
        ).toBe(true);
        expect(
          harness.loops.bindGitDraftTarget(tick.task, tick.invocation.invocationId, first),
        ).toBe(true);
        expect(
          harness.loops.bindGitDraftTarget(tick.task, tick.invocation.invocationId, second),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(tick.task, tick.invocation.invocationId, first),
        ).toBe(true);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            tick.task,
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(true);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            tick.task,
            tick.invocation.invocationId,
            changedPath,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            tick.task,
            tick.invocation.invocationId,
            second,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(
            tick.task,
            tick.invocation.invocationId,
            changedPath,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(
            tick.task,
            tick.invocation.invocationId,
            changedCommonDir,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(
            tick.task,
            tick.invocation.invocationId,
            changedRemote,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(
            { ...tick.task, binding: { goalId: "forged-goal" } },
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftTarget(
            { ...tick.task, driverSessionId: "driver_forged" },
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            { ...tick.task, binding: { goalId: "forged-goal" } },
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            { ...tick.task, driverSessionId: "driver_forged" },
            tick.invocation.invocationId,
            first,
          ),
        ).toBe(false);
        expect(harness.loops.require(tick.task.loopId).driverGitDraftTarget).toEqual(first);
        const persisted = harness.loops.require(tick.task.loopId);
        expect(JSON.stringify(harness.loops.mutationResult(persisted))).not.toContain(
          "driverGitDraftTarget",
        );
        expect(JSON.stringify(loopUpdateEvent(persisted))).not.toContain("driverGitDraftTarget");
      } finally {
        harness.close();
      }
    });

    it("preserves a Git Draft target across a normal wake and store reopen", async () => {
      const harness = createHarness();
      try {
        const firstTick = await runningTick(harness, "loop-draft-wake", "owner-draft-wake");
        const target = gitDraftTarget("artifact:wake", "/workspace/wake", "/repo/.git");
        expect(
          harness.loops.bindGitDraftTarget(
            firstTick.task,
            firstTick.invocation.invocationId,
            target,
          ),
        ).toBe(true);
        harness.loops.completeTick(firstTick.invocation, firstTick.task, {
          status: "succeeded",
          now: "2026-07-23T00:00:00.000Z",
        });
        const driverSessionId = harness.loops.require(firstTick.task.loopId).driverSessionId;
        const woken = harness.loops.wake(firstTick.task.loopId, {
          reason: "normal continuation",
          now: "2026-07-23T00:00:01.000Z",
        });
        expect(woken).toMatchObject({ driverSessionId, driverGitDraftTarget: target });

        const reopened = new SparkLoopStore(harness.db, harness.invocations);
        const submitted = await reopened.materializeDue("2026-07-23T00:00:01.000Z");
        const invocation = harness.invocations.claimNext("reopened-worker")!;
        const task = submitted?.invocation?.task as SparkDaemonLoopTickTask;
        expect(reopened.authorizeGitDraftTarget(task, invocation.invocationId, target)).toBe(true);
        expect(
          reopened.authorizeGitDraftArtifactTarget(task, invocation.invocationId, target),
        ).toBe(true);
      } finally {
        harness.close();
      }
    });

    it("invalidates Git Draft authority on stop, restart, and owner replacement", async () => {
      const harness = createHarness();
      try {
        const firstTick = await runningTick(
          harness,
          "loop-draft-invalidate",
          "owner-draft-invalidate",
        );
        const target = gitDraftTarget("artifact:invalidate", "/workspace/invalidate", "/repo/.git");
        expect(
          harness.loops.bindGitDraftTarget(
            firstTick.task,
            firstTick.invocation.invocationId,
            target,
          ),
        ).toBe(true);
        harness.loops.stop(firstTick.task.loopId, "stop driver");
        expect(
          harness.loops.authorizeGitDraftTarget(
            firstTick.task,
            firstTick.invocation.invocationId,
            target,
          ),
        ).toBe(false);
        expect(
          harness.loops.authorizeGitDraftArtifactTarget(
            firstTick.task,
            firstTick.invocation.invocationId,
            target,
          ),
        ).toBe(false);

        const restarted = harness.loops.restart(firstTick.task.loopId, "new incarnation");
        expect(restarted.driverSessionId).not.toBe(firstTick.task.driverSessionId);
        expect(restarted.driverGitDraftTarget).toBeUndefined();

        const restartedAdvance = await harness.loops.materializeDue();
        const restartedInvocation = harness.invocations.claimNext("restart-worker")!;
        const restartedTask = restartedAdvance?.invocation?.task as SparkDaemonLoopTickTask;
        expect(
          harness.loops.bindGitDraftTarget(restartedTask, restartedInvocation.invocationId, target),
        ).toBe(true);
        harness.loops.start({
          loopId: "replacement-loop",
          ownerSessionId: restartedTask.ownerSessionId,
          cwd: "/workspace",
          prompt: "replacement",
        });
        expect(harness.loops.require(restartedTask.loopId).driverGitDraftTarget).toBeUndefined();
        expect(
          harness.loops.authorizeGitDraftTarget(
            restartedTask,
            restartedInvocation.invocationId,
            target,
          ),
        ).toBe(false);
      } finally {
        harness.close();
      }
    });

    it("rotates the driver incarnation when a terminal Loop is woken", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-terminal-wake", "owner-terminal-wake");
        const target = gitDraftTarget("artifact:terminal", "/workspace/terminal", "/repo/.git");
        expect(
          harness.loops.bindGitDraftTarget(tick.task, tick.invocation.invocationId, target),
        ).toBe(true);
        const stopped = harness.loops.stop(tick.task.loopId, "terminal");
        const woken = harness.loops.wake(tick.task.loopId, { reason: "explicit wake" });
        expect(woken.driverSessionId).not.toBe(stopped.driverSessionId);
        expect(woken.driverGitDraftTarget).toBeUndefined();
      } finally {
        harness.close();
      }
    });

    it("revokes an active invocation and target on explicit restart", async () => {
      const harness = createHarness();
      try {
        const tick = await runningTick(harness, "loop-active-restart", "owner-active-restart");
        const target = gitDraftTarget("artifact:active", "/workspace/active", "/repo/.git");
        expect(
          harness.loops.bindGitDraftTarget(tick.task, tick.invocation.invocationId, target),
        ).toBe(true);

        const restarted = harness.loops.restart(tick.task.loopId, "explicit restart");

        expect(restarted.driverSessionId).not.toBe(tick.task.driverSessionId);
        expect(restarted.driverGitDraftTarget).toBeUndefined();
        expect(
          harness.loops.authorizeGitDraftTarget(tick.task, tick.invocation.invocationId, target),
        ).toBe(false);
        expect(harness.invocations.get(tick.invocation.invocationId)?.cancelReason).toBe(
          "explicit restart",
        );
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

function gitDraftTarget(
  artifactRef: string,
  worktreePath: string,
  commonGitDir: string,
): SparkGitDraftTarget {
  return {
    artifactRef,
    worktreePath,
    commonGitDir,
    repository: "acme/app",
    remoteUrls: ["git@github.com:acme/app.git"],
    pushUrls: ["git@github.com:acme/app.git"],
    gitConfigDigest: `sha256:${"0".repeat(64)}`,
  } as SparkGitDraftTarget;
}
