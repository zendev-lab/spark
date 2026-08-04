import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskPlan } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { registerSparkPlanTasksTool } from "./spark-plan-tasks-tool-registration.ts";
import { registerSparkTodoTools } from "./spark-todo-tool-registration.ts";
import {
  saveCurrentProjectRef,
  sparkSessionKey,
  sparkStateCwd,
} from "./session-state.ts";
import type {
  SparkRegisteredToolConfig,
  SparkToolContext,
} from "./spark-tool-registration.ts";

function testContext(cwd: string): SparkToolContext {
  const sessionId = "session:task-contract";
  return {
    cwd,
    sessionId,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "session.json"),
      isPersisted: () => true,
    },
  };
}

function executionReadyPlan(item: string): TaskPlan {
  return {
    objective: `Implement and verify ${item}`,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`pnpm test verifies ${item} with exit code 0.`],
    evidenceRequired: [`Evidence records the ${item} command, output, and exit code.`],
    items: [
      {
        id: `${item.replaceAll(" ", "-")}-item`,
        title: item,
        status: "in_progress",
        notes: [],
        blockedBy: [],
        evidenceRefs: [],
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      },
    ],
    steps: [item],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

function capturePlanTool(): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkPlanTasksTool(
    (registered) => {
      tool = registered;
    },
    { refreshSparkWidget: async () => undefined },
  );
  expect(tool).toBeTruthy();
  return tool!;
}

function capturePlanUpdateTool(): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkTodoTools(
    (registered) => {
      if (registered.name === "impl_update_task_plan_items") tool = registered;
    },
    { refreshSparkWidget: async () => undefined },
  );
  expect(tool).toBeTruthy();
  return tool!;
}

describe("task tool mutation boundaries", () => {
  for (const status of ["done", "failed", "cancelled"] as const) {
    it(`does not let task planning manufacture status=${status}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `spark-plan-terminal-${status}-`));
      try {
        const ctx = testContext(cwd);
        const stateCwd = sparkStateCwd(cwd, ctx);
        const store = defaultTaskGraphStore(stateCwd);
        const graph = new TaskGraph();
        const project = graph.createProject({
          title: "Terminal planning boundary",
          description: "Terminal state is owned by finish authority",
        });
        await store.save(graph);
        await saveCurrentProjectRef(cwd, ctx, project.ref);

        const result = await capturePlanTool().execute(
          "plan-terminal",
          {
            tasks: [
              {
                name: `terminal-${status}`,
                title: `Terminal ${status}`,
                description: `Attempt to bypass finish with ${status}`,
                kind: "implement",
                status,
                plan: executionReadyPlan(`validate terminal ${status}`),
              },
            ],
          },
          new AbortController().signal,
          () => undefined,
          ctx,
        );

        expect(result.details).toMatchObject({ error: "terminal_status_not_allowed" });
        expect((await store.load())?.tasks(project.ref)).toEqual([]);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it("refuses an ambiguous title prefix without updating either claimed task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-prefix-ambiguity-"));
    try {
      const ctx = testContext(cwd);
      const sessionKey = sparkSessionKey(ctx);
      const stateCwd = sparkStateCwd(cwd, ctx);
      const store = defaultTaskGraphStore(stateCwd);
      const graph = new TaskGraph();
      const project = graph.createProject({
        title: "Selector ambiguity",
        description: "A mutation must identify exactly one task",
      });
      const alpha = graph.createTask({
        projectRef: project.ref,
        name: "validate-api-alpha",
        title: "Validate API alpha",
        description: "Validate the alpha path",
        kind: "implement",
        status: "running",
        plan: executionReadyPlan("validate alpha endpoint"),
      });
      const beta = graph.createTask({
        projectRef: project.ref,
        name: "validate-api-beta",
        title: "Validate API beta",
        description: "Validate the beta path",
        kind: "implement",
        status: "running",
        plan: executionReadyPlan("validate beta endpoint"),
      });
      graph.claimTask(alpha.ref, {
        kind: "main",
        claimedBy: sessionKey,
        sessionId: sessionKey,
        leaseMs: 60_000,
      });
      graph.claimTask(beta.ref, {
        kind: "role-run",
        claimedBy: `${sessionKey}/beta-run`,
        sessionId: sessionKey,
        runName: "beta-run",
        leaseMs: 60_000,
      });
      graph.setCurrentTask(project.ref, alpha.ref);
      await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref, alpha.ref);

      const result = await capturePlanUpdateTool().execute(
        "ambiguous-plan-update",
        {
          task: "Validate API",
          ops: [{ op: "done", item: "validate alpha endpoint" }],
        },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      expect(result.details).toMatchObject({ error: "no_matching_claimed_task" });
      const persisted = await store.load();
      expect(persisted?.getTask(alpha.ref).plan.items?.[0]?.status).toBe("in_progress");
      expect(persisted?.getTask(beta.ref).plan.items?.[0]?.status).toBe("in_progress");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
