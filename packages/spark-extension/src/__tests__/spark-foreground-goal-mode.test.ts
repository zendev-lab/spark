import assert from "node:assert/strict";
import { test } from "vitest";

import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  foregroundUnfinishedTaskPhase,
  suggestForegroundGoalPhase,
} from "../extension/spark-foreground-goal-mode.ts";

const projectRef = "proj:test" as ProjectRef;

function graphWith(input: {
  ready?: Array<{ status: string; kind: string }>;
  tasks?: Array<{ status: string; kind: string }>;
}): TaskGraph {
  return {
    readyTasks: () => input.ready ?? [],
    tasks: () => input.tasks ?? [],
  } as unknown as TaskGraph;
}

test("foreground goal phase continues concrete unfinished implement work instead of replanning", () => {
  const graph = graphWith({ tasks: [{ status: "pending", kind: "implement" }] });

  assert.equal(suggestForegroundGoalPhase(graph, projectRef, "按 GOAL.md 要求复现"), "implement");
});

test("foreground goal phase plans research/review unfinished work", () => {
  assert.equal(foregroundUnfinishedTaskPhase([{ kind: "research" }, { kind: "review" }]), "plan");
});

test("foreground goal phase plans only when no project or no unfinished frontier needs planning", () => {
  assert.equal(suggestForegroundGoalPhase(graphWith({}), undefined, "复现"), "plan");
  assert.equal(suggestForegroundGoalPhase(graphWith({}), projectRef, "规划一下"), "plan");
});
