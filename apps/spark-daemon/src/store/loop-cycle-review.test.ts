import { DatabaseSync } from "node:sqlite";
import {
  sparkLoopConditionReceiptSchema,
  type SparkLoopConditionReceipt,
} from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkDaemonLoopEvaluationTask, SparkDaemonLoopTickTask } from "../core/types.ts";
import { SparkInvocationStore } from "./invocations.ts";
import {
  SparkLoopStore,
  type SparkLoopWorkflowDefinitionSnapshot,
  type SparkLoopWorkflowResolver,
} from "./loops.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("durable Loop cycle review", () => {
  it("hot-loads Workflow policy at cycle boundaries and increments generation on change", async () => {
    let snapshot: SparkLoopWorkflowDefinitionSnapshot = {
      digest: "workflow-v1",
      policy: workflowSkipPolicy(1_000),
    };
    let resolveCount = 0;
    const { db, loops } = harness({
      async resolve() {
        resolveCount += 1;
        return snapshot;
      },
    });
    loops.start({
      loopId: "workflow-hot-load",
      ownerSessionId: "workflow-owner",
      binding: {
        goalId: "goal-workflow-hot-load",
        workflowRunId: "workflow-run-1",
        workflowSelector: "workspace:release-check",
      },
      cwd: "/workspace",
      prompt: "advance workflow",
      dueAt: "2026-08-04T00:00:00.000Z",
    });

    const first = await loops.materializeDue("2026-08-04T00:00:00.000Z");
    expect(first?.loop).toMatchObject({
      status: "scheduled",
      workflowDefinitionDigest: "workflow-v1",
      dueAt: "2026-08-04T00:00:01.000Z",
    });
    expect(first?.loop.policy.completion?.selector).toBe("builtin:goal-reviewer");
    snapshot = { digest: "workflow-v2", policy: workflowSkipPolicy(2_000) };
    const second = await loops.materializeDue("2026-08-04T00:00:01.000Z");
    expect(second?.loop).toMatchObject({
      status: "scheduled",
      workflowDefinitionDigest: "workflow-v2",
      generation: 4,
      dueAt: "2026-08-04T00:00:03.000Z",
    });
    expect(second?.loop.checkpoint?.workflowDefinitionDigest).toBe("workflow-v2");
    expect(resolveCount).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 0 });
  });

  it("freezes a Workflow digest while retrying the same checkpoint", async () => {
    let resolveCount = 0;
    const { loops } = harness({
      async resolve() {
        resolveCount += 1;
        return {
          digest: `workflow-v${resolveCount}`,
          policy: {
            cadenceMs: 30_000,
            retry: { maxAttempts: 1, delaysMs: [1_000] },
            beforeTick: [
              {
                id: "transient",
                when: { kind: "evaluator", selector: "extension:not-registered", input: {} },
                then: { action: "proceed" },
              },
            ],
            afterTick: [],
          },
        };
      },
    });
    loops.start({
      loopId: "workflow-frozen",
      ownerSessionId: "workflow-frozen-owner",
      binding: { workflowSelector: "workspace:release-check" },
      cwd: "/workspace",
      prompt: "advance workflow",
      dueAt: "2026-08-04T00:00:00.000Z",
    });

    const first = await loops.materializeDue("2026-08-04T00:00:00.000Z");
    const second = await loops.materializeDue("2026-08-04T00:00:01.000Z");

    expect(first?.loop.checkpoint?.workflowDefinitionDigest).toBe("workflow-v1");
    expect(second?.loop.checkpoint?.workflowDefinitionDigest).toBe("workflow-v1");
    expect(second?.loop.status).toBe("blocked");
    expect(resolveCount).toBe(1);
  });

  it("fails closed before invocation when a bound Workflow is invalid", async () => {
    const { db, loops } = harness({
      async resolve() {
        throw new Error("WORKFLOW.md has an unknown field");
      },
    });
    loops.start({
      loopId: "workflow-invalid",
      ownerSessionId: "workflow-invalid-owner",
      binding: { workflowSelector: "workspace:invalid" },
      cwd: "/workspace",
      prompt: "must not run",
      dueAt: "2026-08-04T00:00:00.000Z",
    });

    const advanced = await loops.materializeDue("2026-08-04T00:00:00.000Z");

    expect(advanced?.loop).toMatchObject({ status: "blocked" });
    expect(advanced?.loop.reason).toContain("failed closed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 0 });
  });

  it("skips before_tick without creating an invocation or token usage", async () => {
    const { db, loops } = harness();
    loops.start({
      loopId: "skip-loop",
      ownerSessionId: "skip-owner",
      cwd: "/workspace",
      prompt: "must not run",
      dueAt: "2026-08-04T00:00:00.000Z",
      policy: {
        beforeTick: [
          {
            id: "workspace-not-ready",
            when: { kind: "expression", expression: { op: "literal", value: true } },
            then: { action: "skip", delayMs: 30_000 },
          },
        ],
      },
    });

    const advanced = await loops.materializeDue("2026-08-04T00:00:00.000Z");

    expect(advanced?.invocation).toBeUndefined();
    expect(advanced?.loop).toMatchObject({
      status: "scheduled",
      dueAt: "2026-08-04T00:00:30.000Z",
      counters: { skippedCount: 1, llmRequestsAvoided: 1, tickCount: 0 },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM usage_executions").get()).toEqual({
      count: 0,
    });
  });

  it("retries a failing before_tick evaluator at the same checkpoint then blocks", async () => {
    const { db, loops } = harness();
    loops.start({
      loopId: "condition-error",
      ownerSessionId: "condition-owner",
      cwd: "/workspace",
      prompt: "must not run",
      dueAt: "2026-08-04T00:00:00.000Z",
      policy: {
        retry: { maxAttempts: 1, delaysMs: [1_000] },
        beforeTick: [
          {
            id: "trusted-readiness",
            when: { kind: "evaluator", selector: "extension:not-registered", input: {} },
            then: { action: "proceed" },
          },
        ],
      },
    });

    const first = await loops.materializeDue("2026-08-04T00:00:00.000Z");
    const cycleId = first?.loop.checkpoint?.cycleId;
    expect(first?.loop).toMatchObject({
      status: "retry_wait",
      cycleStep: "before_tick",
      dueAt: "2026-08-04T00:00:01.000Z",
      counters: { conditionRetryCount: 1, tickCount: 0 },
    });
    const exhausted = await loops.materializeDue("2026-08-04T00:00:01.000Z");
    expect(exhausted?.loop).toMatchObject({
      status: "blocked",
      counters: { conditionRetryCount: 2, tickCount: 0 },
    });
    expect(exhausted?.loop.cycleStep).toBeUndefined();
    expect(exhausted?.loop.checkpoint?.cycleId).toBe(cycleId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM invocations").get()).toEqual({ count: 0 });
  });

  it("retries only after_tick after a successful main tick", async () => {
    const { db, invocations, loops } = harness();
    const tick = await runningGoalTick(loops, invocations, "retry-review");
    loops.completeTick(tick.invocation, tick.task, {
      status: "succeeded",
      result: { summary: "main tick committed" },
      now: "2026-08-04T00:00:01.000Z",
    });
    const firstReview = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:01.000Z");

    loops.completeEvaluation(firstReview.invocation, firstReview.task, {
      status: "failed",
      errorCode: "REVIEWER_TRANSIENT",
      errorMessage: "review provider unavailable",
      now: "2026-08-04T00:00:02.000Z",
    });

    expect(loops.require("retry-review")).toMatchObject({
      status: "retry_wait",
      cycleStep: "after_tick",
      counters: { tickCount: 1, conditionRetryCount: 1 },
    });
    const secondReview = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:32.000Z");
    expect(secondReview.task.checkpoint.tick?.invocationId).toBe(tick.invocation.invocationId);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.tick'").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.evaluate'")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("recovers between a successful main tick and after_tick evaluation", async () => {
    const { db, invocations, loops } = harness();
    const tick = await runningGoalTick(loops, invocations, "restart-before-review");
    loops.completeTick(tick.invocation, tick.task, {
      status: "succeeded",
      result: { summary: "main tick committed" },
      now: "2026-08-04T00:00:01.000Z",
    });

    expect(() => loops.reconcileTerminalTicks("2026-08-04T00:00:02.000Z")).not.toThrow();
    const review = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:02.000Z");

    expect(review.task.checkpoint.tick?.invocationId).toBe(tick.invocation.invocationId);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.tick'").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM invocations WHERE source_kind = 'loop.evaluate'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("atomically completes an Evidence-backed Goal Loop and records settlement intent", async () => {
    const { invocations, loops } = harness();
    const tick = await runningGoalTick(loops, invocations, "complete-goal");
    loops.completeTick(tick.invocation, tick.task, {
      status: "succeeded",
      now: "2026-08-04T00:00:01.000Z",
    });
    const review = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:01.000Z");

    loops.completeEvaluation(review.invocation, review.task, {
      status: "succeeded",
      result: {
        receipts: [receipt({ verdict: "achieved", evidenceRefs: ["evidence:review-pass"] })],
        decision: { action: "complete" },
      },
      now: "2026-08-04T00:00:02.000Z",
    });

    expect(loops.require("complete-goal")).toMatchObject({
      status: "completed",
      counters: { tickCount: 1 },
    });
    expect(loops.require("complete-goal").cycleStep).toBeUndefined();
    expect(loops.listGoalSettlements()).toEqual([
      expect.objectContaining({
        loopId: "complete-goal",
        goalId: "goal-complete-goal",
        generation: 2,
        status: "pending",
      }),
    ]);
    expect(await loops.materializeDue("2026-08-05T00:00:00.000Z")).toBeUndefined();
  });

  it("blocks a Goal completion decision backed only by a bare boolean verdict", async () => {
    const { invocations, loops } = harness();
    const tick = await runningGoalTick(loops, invocations, "untrusted-complete");
    loops.completeTick(tick.invocation, tick.task, {
      status: "succeeded",
      now: "2026-08-04T00:00:01.000Z",
    });
    const review = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:01.000Z");

    loops.completeEvaluation(review.invocation, review.task, {
      status: "succeeded",
      result: {
        receipts: [receipt({ verdict: "achieved", evidenceRefs: [] })],
        decision: { action: "complete" },
      },
      now: "2026-08-04T00:00:02.000Z",
    });

    expect(loops.require("untrusted-complete")).toMatchObject({
      status: "blocked",
      error: "achieved requires trusted Evidence-backed receipt",
    });
    expect(loops.listGoalSettlements()).toEqual([]);
  });

  it("injects reviewer remaining work into the next tick", async () => {
    const { invocations, loops } = harness();
    const tick = await runningGoalTick(loops, invocations, "continue-goal");
    loops.completeTick(tick.invocation, tick.task, {
      status: "succeeded",
      now: "2026-08-04T00:00:01.000Z",
    });
    const review = await evaluationInvocation(loops, invocations, "2026-08-04T00:00:01.000Z");
    loops.completeEvaluation(review.invocation, review.task, {
      status: "succeeded",
      result: {
        receipts: [
          receipt({
            verdict: "not_achieved",
            remainingWork: "run the target validation",
            blockers: ["target_validation_missing"],
            evidenceRefs: ["evidence:partial-review"],
          }),
        ],
        decision: { action: "schedule", delayMs: 30_000 },
      },
      now: "2026-08-04T00:00:02.000Z",
    });

    const next = await loops.materializeDue("2026-08-04T00:00:32.000Z");
    expect(next?.invocation?.task).toMatchObject({ type: "loop.tick" });
  });
});

function harness(workflows?: SparkLoopWorkflowResolver) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  return { db, invocations, loops: new SparkLoopStore(db, invocations, undefined, workflows) };
}

function workflowSkipPolicy(delayMs: number): SparkLoopWorkflowDefinitionSnapshot["policy"] {
  return {
    cadenceMs: 30_000,
    retry: { maxAttempts: 3, delaysMs: [30_000] },
    beforeTick: [
      {
        id: "not-ready",
        when: { kind: "expression", expression: { op: "literal", value: true } },
        then: { action: "skip", delayMs },
      },
    ],
    afterTick: [],
  };
}

async function runningGoalTick(
  loops: SparkLoopStore,
  invocations: SparkInvocationStore,
  loopId: string,
) {
  loops.start({
    loopId,
    ownerSessionId: `owner-${loopId}`,
    binding: { goalId: `goal-${loopId}` },
    cwd: "/workspace",
    prompt: "continue goal",
    now: "2026-08-04T00:00:00.000Z",
    policy: { completion: { selector: "builtin:goal-reviewer", input: {} } },
  });
  await loops.materializeDue("2026-08-04T00:00:00.000Z");
  const invocation = invocations.claimNext("tick-worker", "2026-08-04T00:00:00.000Z")!;
  return { invocation, task: invocation.task as SparkDaemonLoopTickTask };
}

async function evaluationInvocation(
  loops: SparkLoopStore,
  invocations: SparkInvocationStore,
  now: string,
) {
  const advanced = await loops.materializeDue(now);
  expect(advanced?.invocation?.task).toMatchObject({ type: "loop.evaluate" });
  const invocation = invocations.claimNext("review-worker", now)!;
  return { invocation, task: invocation.task as SparkDaemonLoopEvaluationTask };
}

function receipt(
  input: Partial<SparkLoopConditionReceipt> & Pick<SparkLoopConditionReceipt, "verdict">,
): SparkLoopConditionReceipt {
  return sparkLoopConditionReceiptSchema.parse({
    receiptId: "receipt_test",
    checkpoint: "after_tick",
    selector: "builtin:goal-reviewer",
    inputSummary: { goal: true },
    definitionDigest: "definition-digest",
    verdict: input.verdict,
    reason: input.reason ?? "review result",
    remainingWork: input.remainingWork,
    blockers: input.blockers ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    evaluatedAt: "2026-08-04T00:00:02.000Z",
  });
}
