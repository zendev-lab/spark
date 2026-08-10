import assert from "node:assert/strict";
import { test } from "vitest";

import {
  compactContinuationPrompt,
  continuationGoalIdFromPrompt,
  createGoal,
  createLoop,
  evaluateLoopTick,
  goalToolResponse,
  validateObjective,
} from "./index.ts";

test("spark-loop goal helpers create goals and continuation prompts", () => {
  assert.equal(validateObjective("  ship feature  "), null);
  const goal = createGoal("  ship feature  ", 123);
  assert.equal(goal.objective, "ship feature");
  assert.equal(goal.status, "active");

  const prompt = compactContinuationPrompt(goal);
  assert.equal(continuationGoalIdFromPrompt(prompt), goal.goalId);

  const response = goalToolResponse(goal);
  assert.equal(response.goal?.goalId, goal.goalId);
  assert.equal(response.goal?.status, "active");
});

test("spark-loop exposes non-completing loop primitives alongside goal helpers", () => {
  const loop = createLoop("Continue without completing", 123);
  const tick = evaluateLoopTick({ loop, now: 124, reason: "start" });

  assert.equal(tick.decision, "continue");
  assert.equal(tick.loop?.status, "active");
  assert.notEqual(tick.decision, "complete");
  assert.notEqual(tick.loop?.status, "complete");
});
