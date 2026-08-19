import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { TaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  SparkWidgetController,
  type SparkWidgetControllerDeps,
} from "./spark-widget-controller.ts";

test("widget refresh surfaces dynamic workflow read failures", async () => {
  const readFailure = new Error("dynamic workflow store is corrupt");
  const deps: SparkWidgetControllerDeps = {
    ensureLocalSparkDirectory: async () => undefined,
    defaultTaskGraphStore: () => new TaskGraphStore(join(tmpdir(), "unused-projects.json")),
    loadSparkGraph: async () => null,
    ensureSparkGraphInvariants: () => false,
    saveSparkGraphAndTodos: async () => undefined,
    sparkSessionKey: () => "session:test",
    sparkSessionOwnerKey: () => "session:test",
    activeSparkRoleRunProcessesForCwd: () => [],
    defaultSparkWorkflowRunStore: () => ({
      reconcile: async () => ({
        version: 1,
        manager: { status: "idle", updatedAt: "2026-08-10T00:00:00.000Z" },
        runs: [],
      }),
      status: async () => ({
        manager: { status: "idle", updatedAt: "2026-08-10T00:00:00.000Z" },
        recentRuns: [],
        running: 0,
        succeeded: 0,
        failed: 0,
        stale: 0,
        timedOut: 0,
        acknowledged: 0,
        actionable: 0,
        nextSteps: [],
      }),
    }),
    listDynamicWorkflowRuns: async () => {
      throw readFailure;
    },
    loadTodoDisplayNumberState: async () => ({ version: 1, next: 1, numbers: {} }),
    saveTodoDisplayNumberState: async () => undefined,
    loadIndependentTodos: async () => [],
    currentSparkProject: async () => undefined,
    loadSessionGoal: async () => undefined,
    loadSessionLoop: async () => undefined,
    clearSessionLoop: async () => undefined,
    loadSparkMode: async () => ({ mode: "execute" }),
    sparkActiveMode: (mode) => ({ mode }),
    renderSparkProjectKindDisplay: () => undefined,
    isPlaceholderProjectTitle: () => false,
    latestRunsByTaskRef: () => new Map(),
    taskPlanSummary: () => undefined,
    deriveTaskRoleLabel: () => undefined,
    isClaimOwnedBySession: () => false,
    taskClaimedBy: () => undefined,
    assignTodoDisplayNumber: () => 1,
    taskTodoDisplayKey: (taskRef, todoId) => `${taskRef}:${todoId}`,
    independentTodoDisplayKey: (todo) => String(todo.id ?? todo.content),
  };

  await expect(new SparkWidgetController(deps).refresh("/workspace")).rejects.toBe(readFailure);
});
