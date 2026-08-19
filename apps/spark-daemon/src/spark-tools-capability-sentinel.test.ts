import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stableId, type SparkHostLoopContext } from "@zendev-lab/spark-core";
import {
  clearSessionGoal,
  loadSessionGoal,
  loadSessionLoop,
  setSessionGoal,
} from "@zendev-lab/spark-loop";
import {
  sparkLoopConditionReceiptSchema,
  type SparkLoopConditionReceipt,
  type SparkSessionReproWorkView,
} from "@zendev-lab/spark-protocol";
import sparkExtension from "@zendev-lab/spark-extension/extension";
import { describe, expect, it, vi } from "vitest";

import type { SparkDaemonLoopEvaluationTask, SparkDaemonLoopTickTask } from "./core/types.ts";
import { reconcileLoopGoalSettlements } from "./spark/loop-goal-settlements.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { SparkLoopStore } from "./store/loops.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

type HostApi = Parameters<typeof sparkExtension>[0];
type TestHostApi = HostApi &
  Pick<
    import("@zendev-lab/spark-core").SparkHostAPI,
    "getActiveTools" | "getAllTools" | "setActiveTools"
  >;
type Tool = Parameters<NonNullable<HostApi["registerTool"]>>[0];
type Command = Parameters<HostApi["registerCommand"]>[1];
type ToolResult = Awaited<ReturnType<Tool["execute"]>>;
type ToolContext = Parameters<Tool["execute"]>[4];

interface SentinelMetrics {
  surfaceCalls: number;
  roleRuns: number;
  reviewerCalls: number;
  loopSchedules: number;
  loopStops: number;
}

interface SentinelHarness {
  dir: string;
  db: DatabaseSync;
  invocations: SparkInvocationStore;
  loops: SparkLoopStore;
  ctx: ToolContext;
  metrics: SentinelMetrics;
  execute(name: string, params: Record<string, unknown>): Promise<ToolResult>;
  executeCommand(name: string, args: string): Promise<void>;
  bindLoopContext(loopId: string): SparkHostLoopContext;
  close(): Promise<void>;
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

describe("zero-token capability sentinels", () => {
  it("completes a public Goal only through an Evidence-backed daemon settlement", async () => {
    const harness = await createHarness();
    try {
      const started = await harness.execute("goal", {
        action: "start",
        objective: "Complete the deterministic Goal sentinel",
      });
      expect(started.isError).toBeUndefined();

      const goal = await loadSessionGoal(harness.dir, harness.ctx);
      expect(goal).toMatchObject({
        objective: "Complete the deterministic Goal sentinel",
        status: "active",
      });
      assert.ok(goal);
      expect(harness.loops.require(goal.goalId)).toMatchObject({
        binding: { goalId: goal.goalId },
        status: "scheduled",
      });

      await completeGoalLoopToPendingSettlement(harness, goal.goalId, "evidence:sentinel-goal");

      expect((await loadSessionGoal(harness.dir, harness.ctx))?.status).toBe("active");
      expect(harness.loops.require(goal.goalId).status).toBe("completed");
      expect(harness.loops.listGoalSettlements()).toHaveLength(1);
      expect(await reconcileLoopGoalSettlements(harness.loops)).toBe(1);
      expect(await reconcileLoopGoalSettlements(harness.loops)).toBe(0);
      expect(await loadSessionGoal(harness.dir, harness.ctx)).toMatchObject({
        goalId: goal.goalId,
        status: "complete",
        completedReason: "Goal sentinel passed trusted review.",
        lastReviewEvidenceRef: "evidence:sentinel-goal",
      });
      expect(await harness.loops.materializeDue("2099-01-02T00:00:00.000Z")).toBeUndefined();

      expectInvocationCounts(harness.db, { tick: 1, evaluate: 1 });
      expectZeroTokenBudget(harness, { maxSurfaceCalls: 1, maxInvocations: 2 });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("rejects a stale Goal settlement after the durable Goal identity changes", async () => {
    const harness = await createHarness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await harness.execute("goal", {
        action: "start",
        objective: "Original Goal sentinel",
      });
      const original = await loadSessionGoal(harness.dir, harness.ctx);
      assert.ok(original);

      await completeGoalLoopToPendingSettlement(
        harness,
        original.goalId,
        "evidence:stale-goal-review",
      );
      await clearSessionGoal(harness.dir, harness.ctx);
      await setSessionGoal(harness.dir, harness.ctx, {
        goalId: "replacement-goal-sentinel",
        objective: "Replacement Goal sentinel",
        source: "explicit",
      });

      expect(await reconcileLoopGoalSettlements(harness.loops, { retryErrors: true })).toBe(0);
      expect(await loadSessionGoal(harness.dir, harness.ctx)).toMatchObject({
        goalId: "replacement-goal-sentinel",
        objective: "Replacement Goal sentinel",
        status: "active",
      });
      expect(
        harness.db
          .prepare(
            "SELECT status, attempt_count AS attemptCount FROM loop_goal_settlements WHERE loop_id = ?",
          )
          .get(original.goalId),
      ).toEqual({ status: "error", attemptCount: 1 });

      expectInvocationCounts(harness.db, { tick: 1, evaluate: 1 });
      expectZeroTokenBudget(harness, { maxSurfaceCalls: 1, maxInvocations: 2 });
    } finally {
      errorSpy.mockRestore();
      await harness.close();
    }
  }, 30_000);

  it("starts, schedules, inspects, and clears an open-ended Loop without completion authority", async () => {
    const harness = await createHarness();
    try {
      await harness.executeCommand("loop", "start Run the bounded Loop sentinel");

      const loop = await loadSessionLoop(harness.dir, harness.ctx);
      expect(loop).toMatchObject({
        objective: "Run the bounded Loop sentinel",
        status: "active",
      });
      assert.ok(loop);
      expect(harness.loops.require(loop.loopId)).toMatchObject({
        binding: {},
        status: "scheduled",
      });

      const advanced = await harness.loops.materializeDue(FAR_FUTURE);
      expect(advanced?.invocation?.task).toMatchObject({
        type: "loop.tick",
        loopId: loop.loopId,
      });
      const tickInvocation = harness.invocations.claimNext("sentinel-loop-worker", FAR_FUTURE);
      assert.ok(tickInvocation);
      const tickTask = tickInvocation.task as SparkDaemonLoopTickTask;
      harness.bindLoopContext(loop.loopId);

      const scheduled = await harness.execute("loop", {
        action: "schedule",
        delayMs: 1_000,
        reason: "bounded sentinel cadence",
      });
      expect(scheduled.isError).toBeUndefined();
      expect(harness.metrics.loopSchedules).toBe(1);
      expect(harness.loops.require(loop.loopId)).toMatchObject({
        status: "running",
        cycleStep: "invoke",
      });

      const settled = harness.loops.completeTick(tickInvocation, tickTask, {
        status: "succeeded",
        result: { summary: "bounded Loop sentinel tick" },
        now: "2099-01-01T00:00:01.000Z",
      });
      expect(settled.loop).toMatchObject({
        status: "scheduled",
        generation: 2,
        dueAt: "2099-01-01T00:00:01.000Z",
      });
      expect(settled.loop.status).not.toBe("completed");

      const status = await harness.execute("loop", { action: "status" });
      expect(text(status)).toContain("Run the bounded Loop sentinel");

      const cleared = await harness.execute("loop", {
        action: "clear",
        reason: "sentinel complete without Loop completion",
      });
      expect(cleared.isError).toBeUndefined();
      expect(await loadSessionLoop(harness.dir, harness.ctx)).toBeUndefined();
      expect(harness.loops.require(loop.loopId).status).toBe("stopped");
      expect(harness.metrics.loopStops).toBe(1);

      expectInvocationCounts(harness.db, { tick: 1, evaluate: 0 });
      expectZeroTokenBudget(harness, { maxSurfaceCalls: 4, maxInvocations: 1 });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("starts, inspects, and stops Repro through its canonical public tool", async () => {
    const harness = await createHarness();
    try {
      const started = await harness.execute("repro", {
        action: "start",
        objective: "Run the bounded Repro sentinel",
        reproId: "capability-sentinel-repro",
      });
      expect(started.isError).toBeUndefined();
      expect(started.details).toMatchObject({
        status: "active",
        reproId: "capability-sentinel-repro",
        progress: { accepted: 0, total: 5 },
      });
      expect(
        harness.loops.list({ loopId: "capability-sentinel-repro", includeTerminal: true }),
      ).toEqual([]);

      const status = await harness.execute("repro", { action: "status" });
      expect(status.isError).toBeUndefined();
      expect(status.details).toMatchObject({
        status: "active",
        reproId: "capability-sentinel-repro",
      });
      expect(text(status)).toContain("implementation:running");

      const stopped = await harness.execute("repro", { action: "stop" });
      expect(stopped.isError).toBeUndefined();
      expect(stopped.details).toMatchObject({ status: "stopped" });
      expect(
        harness.loops.list({ loopId: "capability-sentinel-repro", includeTerminal: true }),
      ).toEqual([]);

      const inactive = await harness.execute("repro", { action: "status" });
      expect(inactive.details).toMatchObject({ status: "stopped" });

      expectInvocationCounts(harness.db, { tick: 0, evaluate: 0 });
      expectZeroTokenBudget(harness, { maxSurfaceCalls: 4, maxInvocations: 0 });
    } finally {
      await harness.close();
    }
  }, 30_000);
});

async function createHarness(): Promise<SentinelHarness> {
  const dir = await mkdtemp(join(tmpdir(), "spark-capability-sentinel-"));
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  const loops = new SparkLoopStore(db, invocations);
  const tools = new Map<string, Tool>();
  const commands = new Map<string, Command>();
  const metrics: SentinelMetrics = {
    surfaceCalls: 0,
    roleRuns: 0,
    reviewerCalls: 0,
    loopSchedules: 0,
    loopStops: 0,
  };
  const sessionFile = join(dir, ".pi-sessions", "main.json");
  let reproProjection: SparkSessionReproWorkView | undefined;
  const ctx: ToolContext = {
    cwd: dir,
    sessionId: `session:${stableId(sessionFile)}`,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => "capability-sentinel-leaf",
    },
    hasUI: true,
    ui: {
      notify() {},
      setWidget() {},
      setStatus() {},
      confirm: async () => true,
      input: async () => undefined,
      select: async () => undefined,
    },
    runRole: async () => {
      metrics.roleRuns += 1;
      throw new Error("capability sentinels must not invoke a model role");
    },
  };
  const host: TestHostApi = {
    reproControl: {
      async start(input) {
        const next = sentinelReproProjection(input.reproId ?? "repro:sentinel", input.objective);
        const changed = reproProjection === undefined;
        reproProjection ??= next;
        return { repro: reproProjection, changed };
      },
      async status() {
        return { ...(reproProjection ? { repro: reproProjection } : {}) };
      },
      async stop() {
        if (!reproProjection) throw new Error("no Repro is owned by this Session");
        reproProjection = { ...reproProjection, status: "stopped" };
        return { repro: reproProjection, changed: true };
      },
    },
    loopControl: {
      async start(input: Parameters<SparkLoopStore["start"]>[0]) {
        return loops.mutationResult(loops.start(input));
      },
      async list(input: Parameters<SparkLoopStore["list"]>[0]) {
        return loops.listResult(input);
      },
      async stop(input: { loopId: string; reason?: string }) {
        return loops.mutationResult(loops.stop(input.loopId, input.reason));
      },
      async restart(input: { loopId: string; reason?: string }) {
        return loops.mutationResult(loops.restart(input.loopId, input.reason));
      },
      async wake(input: { loopId: string; prompt?: string; reason?: string }) {
        return loops.mutationResult(
          loops.wake(input.loopId, { prompt: input.prompt, reason: input.reason }),
        );
      },
      async schedule(input: Parameters<SparkLoopStore["schedule"]>[0]) {
        return loops.mutationResult(loops.schedule(input));
      },
    },
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    registerInternalTool: (tool: Tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerShortcut() {},
    on() {},
    sendMessage() {},
    getActiveTools: () => [...tools.keys()],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    setActiveTools() {},
    createReviewerRunner: () => ({
      review: async () => {
        metrics.reviewerCalls += 1;
        throw new Error("capability sentinels use deterministic daemon receipts, not reviewers");
      },
    }),
  };
  sparkExtension(host);

  const harness: SentinelHarness = {
    dir,
    db,
    invocations,
    loops,
    ctx,
    metrics,
    async execute(name, params) {
      const tool = tools.get(name);
      assert.ok(tool, `missing public tool: ${name}`);
      metrics.surfaceCalls += 1;
      return tool.execute(
        `sentinel-${name}-${metrics.surfaceCalls}`,
        params,
        new AbortController().signal,
        () => undefined,
        ctx,
      );
    },
    async executeCommand(name, args) {
      const command = commands.get(name);
      assert.ok(command, `missing public command: /${name}`);
      metrics.surfaceCalls += 1;
      await command.handler(args, ctx);
    },
    bindLoopContext(loopId) {
      const view = loops.require(loopId);
      const daemonLoop: SparkHostLoopContext = {
        loopId,
        binding: view.binding,
        generation: view.generation,
        ownerSessionId: view.ownerSessionId,
        async schedule(input) {
          metrics.loopSchedules += 1;
          const current = loops.require(loopId);
          const updated = loops.schedule(
            {
              loopId,
              generation: current.generation,
              ...input,
            },
            FAR_FUTURE,
          );
          daemonLoop.generation = updated.generation;
          return updated;
        },
        async stop(input) {
          metrics.loopStops += 1;
          const updated = loops.stop(loopId, input?.reason);
          daemonLoop.generation = updated.generation;
          return updated;
        },
      };
      ctx.loop = daemonLoop;
      return daemonLoop;
    },
    async close() {
      db.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    },
  };
  return harness;
}

function sentinelReproProjection(reproId: string, objective: string): SparkSessionReproWorkView {
  const lane = (name: "implementation" | "exactness" | "formalize") => ({
    sessionId: `session:repro-${name}`,
    taskRef: `task:repro-${name}` as const,
    roleRef: `role:repro-${name}` as const,
  });
  return {
    version: 10 as const,
    reproId,
    status: "active" as const,
    objective,
    workItemId: `work:${reproId}`,
    lanes: {
      implementation: lane("implementation"),
      exactness: lane("exactness"),
      formalize: lane("formalize"),
    },
    checkpoint: {
      checkpointId: "checkpoint:implementation",
      kind: "implementation" as const,
      lane: "implementation" as const,
      status: "running" as const,
      sessionId: "session:repro-implementation",
      taskRef: "task:repro-implementation" as const,
      runRef: "run:repro-implementation" as const,
      attempt: 1,
      evidenceRefs: [],
    },
    progress: { accepted: 0, total: 5 as const },
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
}

async function completeGoalLoopToPendingSettlement(
  harness: SentinelHarness,
  loopId: string,
  evidenceRef: `evidence:${string}`,
): Promise<void> {
  const advanced = await harness.loops.materializeDue(FAR_FUTURE);
  expect(advanced?.invocation?.task).toMatchObject({ type: "loop.tick" });
  const tickInvocation = harness.invocations.claimNext("sentinel-tick-worker", FAR_FUTURE);
  assert.ok(tickInvocation);
  const tickTask = tickInvocation.task as SparkDaemonLoopTickTask;
  expect(tickTask.loopId).toBe(loopId);
  harness.loops.completeTick(tickInvocation, tickTask, {
    status: "succeeded",
    result: { summary: "deterministic sentinel tick" },
    now: "2099-01-01T00:00:01.000Z",
  });

  const reviewAdvanced = await harness.loops.materializeDue("2099-01-01T00:00:01.000Z");
  expect(reviewAdvanced?.invocation?.task).toMatchObject({ type: "loop.evaluate" });
  const reviewInvocation = harness.invocations.claimNext(
    "sentinel-review-worker",
    "2099-01-01T00:00:01.000Z",
  );
  assert.ok(reviewInvocation);
  const reviewTask = reviewInvocation.task as SparkDaemonLoopEvaluationTask;
  expect(reviewTask.loop.loopId).toBe(loopId);
  harness.loops.completeEvaluation(reviewInvocation, reviewTask, {
    status: "succeeded",
    result: {
      receipts: [goalReceipt(evidenceRef)],
      decision: { action: "complete" },
    },
    now: "2099-01-01T00:00:02.000Z",
  });
}

function goalReceipt(evidenceRef: `evidence:${string}`): SparkLoopConditionReceipt {
  return sparkLoopConditionReceiptSchema.parse({
    receiptId: `receipt_${evidenceRef.slice("evidence:".length)}`,
    checkpoint: "after_tick",
    selector: "builtin:goal-reviewer",
    inputSummary: { sentinel: true },
    definitionDigest: "capability-sentinel-goal-review",
    verdict: "achieved",
    reason: "Goal sentinel passed trusted review.",
    blockers: [],
    evidenceRefs: [evidenceRef],
    evaluatedAt: "2099-01-01T00:00:02.000Z",
  });
}

function expectInvocationCounts(
  db: DatabaseSync,
  expected: { tick: number; evaluate: number },
): void {
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.tick'").get(),
  ).toEqual({ count: expected.tick });
  expect(
    db
      .prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.evaluate'")
      .get(),
  ).toEqual({ count: expected.evaluate });
}

function expectZeroTokenBudget(
  harness: SentinelHarness,
  budget: { maxSurfaceCalls: number; maxInvocations: number },
): void {
  const invocationCount = harness.db.prepare("SELECT COUNT(*) AS count FROM invocations").get() as {
    count: number;
  };
  const usageCount = harness.db.prepare("SELECT COUNT(*) AS count FROM usage_executions").get() as {
    count: number;
  };
  expect(harness.metrics.surfaceCalls).toBeLessThanOrEqual(budget.maxSurfaceCalls);
  expect(invocationCount.count).toBeLessThanOrEqual(budget.maxInvocations);
  expect(harness.metrics.roleRuns).toBe(0);
  expect(harness.metrics.reviewerCalls).toBe(0);
  expect(usageCount.count).toBe(0);
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}
