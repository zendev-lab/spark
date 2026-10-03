import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionGoal, setSessionGoal } from "@zendev-lab/spark-driver";
import { afterEach, expect, it } from "vitest";
import type { SparkDaemonLoopEvaluationTask, SparkDaemonLoopTickTask } from "../core/types.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkLoopStore } from "../store/loops.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { reconcileLoopGoalSettlements } from "./loop-goal-settlements.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

it("applies an atomic Goal settlement once and never wakes the completed Loop after restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-loop-goal-settlement-"));
  roots.push(cwd);
  const ownerSessionId = "goal-owner";
  const goalId = "goal-restart-proof";
  await setSessionGoal(
    cwd,
    { sessionId: ownerSessionId },
    { goalId, objective: "Finish with durable proof", source: "explicit" },
  );
  const databasePath = join(cwd, "daemon.sqlite");
  let db = new DatabaseSync(databasePath);
  migrateSparkDaemonDatabase(db);
  let invocations = new SparkInvocationStore(db);
  let loops = new SparkLoopStore(db, invocations);
  loops.start({
    loopId: goalId,
    ownerSessionId,
    binding: { goalId },
    cwd,
    prompt: "finish the goal",
    now: "2026-08-04T00:00:00.000Z",
    policy: { completion: { selector: "builtin:goal-reviewer", input: {} } },
  });
  await loops.materializeDue("2026-08-04T00:00:00.000Z");
  const tick = invocations.claimNext("tick-worker", "2026-08-04T00:00:00.000Z")!;
  loops.completeTick(tick, tick.task as SparkDaemonLoopTickTask, {
    status: "succeeded",
    now: "2026-08-04T00:00:01.000Z",
  });
  await loops.materializeDue("2026-08-04T00:00:01.000Z");
  const evaluation = invocations.claimNext("review-worker", "2026-08-04T00:00:01.000Z")!;
  loops.completeEvaluation(evaluation, evaluation.task as SparkDaemonLoopEvaluationTask, {
    status: "succeeded",
    result: {
      receipts: [
        {
          receiptId: "receipt_restart_proof",
          checkpoint: "after_tick",
          selector: "builtin:goal-reviewer",
          inputSummary: { goalId },
          definitionDigest: "goal-review-definition",
          verdict: "achieved",
          reason: "Goal contract and Evidence passed review.",
          blockers: [],
          evidenceRefs: ["evidence:goal-review-proof"],
          evaluatedAt: "2026-08-04T00:00:02.000Z",
        },
      ],
      decision: { action: "complete" },
    },
    now: "2026-08-04T00:00:02.000Z",
  });
  expect((await loadSessionGoal(cwd, { sessionId: ownerSessionId }))?.status).toBe("active");
  expect(loops.require(goalId).status).toBe("completed");
  expect(loops.listGoalSettlements()).toHaveLength(1);
  db.close();

  db = new DatabaseSync(databasePath);
  migrateSparkDaemonDatabase(db);
  invocations = new SparkInvocationStore(db);
  loops = new SparkLoopStore(db, invocations);
  expect(await reconcileLoopGoalSettlements(loops, { retryErrors: true })).toBe(1);
  expect(await reconcileLoopGoalSettlements(loops, { retryErrors: true })).toBe(0);
  expect(await loops.materializeDue("2026-08-05T00:00:00.000Z")).toBeUndefined();
  expect(loops.require(goalId).status).toBe("completed");
  expect(await loadSessionGoal(cwd, { sessionId: ownerSessionId })).toMatchObject({
    goalId,
    status: "complete",
    completedReason: "Goal contract and Evidence passed review.",
    lastReviewEvidenceRef: "evidence:goal-review-proof",
  });
  expect(
    db
      .prepare(
        "SELECT status, attempt_count AS attemptCount FROM loop_goal_settlements WHERE loop_id = ?",
      )
      .get(goalId),
  ).toEqual({ status: "applied", attemptCount: 1 });
  db.close();
});
