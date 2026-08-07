import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TaskPlan } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import { registerSparkPlanTasksTool } from "./spark-plan-tasks-tool-registration.ts";
import { registerSparkTodoTools } from "./spark-todo-tool-registration.ts";
import { resolveSessionClaimedTask } from "./task-claim-selection.ts";
import { preserveTaskPlanItemMetadata, terminalTaskPlanInputs } from "./task-tool-contracts.ts";
import { saveCurrentProjectRef, sparkSessionKey, sparkStateCwd } from "./session-state.ts";
import type { SparkRegisteredToolConfig, SparkToolContext } from "./spark-tool-registration.ts";

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

function capturePlanTool(
  options: { failOnPlanDecision?: boolean } = {},
): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkPlanTasksTool(
    (registered) => {
      tool = registered;
    },
    {
      refreshSparkWidget: async () => undefined,
      ...(options.failOnPlanDecision
        ? {
            decideTaskPlan: () => {
              throw new Error("dependency-only patch must not evaluate plan readiness");
            },
          }
        : {}),
    },
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
  it("keeps an exact task ref authoritative over a colliding task title", () => {
    const graph = new TaskGraph();
    const project = graph.createProject({
      title: "Strong selector precedence",
      description: "Exact identity must outrank human-readable selectors",
    });
    const target = graph.createTask({
      projectRef: project.ref,
      name: "target-task",
      title: "Target task",
      description: "The task selected by durable identity",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify exact ref precedence"),
    });
    const collision = graph.createTask({
      projectRef: project.ref,
      name: "colliding-title",
      title: target.ref,
      description: "A human-readable title that collides with another task ref",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify colliding title isolation"),
    });
    const nameCollision = graph.createTask({
      projectRef: project.ref,
      name: "colliding-name-title",
      title: target.name,
      description: "A human-readable title that collides with another task name",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify colliding name isolation"),
    });
    const prefixCollision = graph.createTask({
      projectRef: project.ref,
      name: "target-follow-up",
      title: "Target task follow-up",
      description: "A second task sharing the same human-readable prefix",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify ambiguous prefix isolation"),
    });
    const duplicateTitle = graph.createTask({
      projectRef: project.ref,
      name: "duplicate-target-title",
      title: target.title,
      description: "A second task sharing an exact human-readable title",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify duplicate title isolation"),
    });
    const extendedTitle = graph.createTask({
      projectRef: project.ref,
      name: "extended-target-title",
      title: `${prefixCollision.title} extended`,
      description: "A longer title sharing another task's exact title as its prefix",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify exact title precedence over a longer prefix"),
    });
    const outsider = graph.createTask({
      projectRef: project.ref,
      name: "outside-session",
      title: "Outside session",
      description: "A task claimed by another session",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify claim ownership filtering"),
    });
    const terminal = graph.createTask({
      projectRef: project.ref,
      name: "terminal-task",
      title: "Terminal task",
      description: "A completed task that must not be selected",
      kind: "implement",
      status: "done",
      plan: executionReadyPlan("verify terminal filtering"),
    });
    const sessionKey = "session:selector-precedence";
    graph.claimTask(target.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    graph.claimTask(collision.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/collision-run`,
      sessionId: sessionKey,
      runName: "collision-run",
      leaseMs: 60_000,
    });
    graph.claimTask(nameCollision.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/name-collision-run`,
      sessionId: sessionKey,
      runName: "name-collision-run",
      leaseMs: 60_000,
    });
    graph.claimTask(prefixCollision.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/prefix-collision-run`,
      sessionId: sessionKey,
      runName: "prefix-collision-run",
      leaseMs: 60_000,
    });
    graph.claimTask(duplicateTitle.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/duplicate-title-run`,
      sessionId: sessionKey,
      runName: "duplicate-title-run",
      leaseMs: 60_000,
    });
    graph.claimTask(extendedTitle.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/extended-title-run`,
      sessionId: sessionKey,
      runName: "extended-title-run",
      leaseMs: 60_000,
    });
    graph.claimTask(outsider.ref, {
      kind: "main",
      claimedBy: "session:other",
      sessionId: "session:other",
      leaseMs: 60_000,
    });

    expect(
      resolveSessionClaimedTask(graph, project.ref, sessionKey, `  ${target.ref}  `)?.ref,
    ).toBe(target.ref);
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, target.name)?.ref).toBe(
      target.ref,
    );
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, `@${target.name}`)?.ref).toBe(
      target.ref,
    );
    expect(
      resolveSessionClaimedTask(graph, project.ref, sessionKey, nameCollision.title)?.ref,
    ).toBe(target.ref);
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, target.title)).toBeUndefined();
    expect(
      resolveSessionClaimedTask(graph, project.ref, sessionKey, prefixCollision.title)?.ref,
    ).toBe(prefixCollision.ref);
    expect(
      resolveSessionClaimedTask(graph, project.ref, sessionKey, "Target task follow-up e")?.ref,
    ).toBe(extendedTitle.ref);
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, "Target")).toBeUndefined();
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, outsider.ref)).toBeUndefined();
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, terminal.ref)).toBeUndefined();
    graph.setCurrentTask(project.ref, target.ref);
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey)?.ref).toBe(target.ref);
    expect(resolveSessionClaimedTask(graph, project.ref, sessionKey, "   ")?.ref).toBe(target.ref);
  });

  it("classifies only completion statuses as forbidden planning inputs", () => {
    const input = (status: "pending" | "cancelled" | "done" | "failed") =>
      ({ title: status, description: status, status }) as Parameters<
        typeof terminalTaskPlanInputs
      >[0][number];

    expect(terminalTaskPlanInputs([input("pending"), input("cancelled")])).toEqual([]);
    expect(
      terminalTaskPlanInputs([input("done"), input("failed")]).map((task) => task.status),
    ).toEqual(["done", "failed"]);
  });

  it("preserves semantic metadata without copying it onto new plan items", () => {
    const previous = executionReadyPlan("preserve metadata").items?.[0];
    if (!previous) throw new Error("missing previous plan item");
    previous.description = "Retain this exact semantic description.";
    previous.evidenceRefs = ["evidence:plan-item"];
    const updated = {
      ...previous,
      status: "done" as const,
      description: undefined,
      evidenceRefs: [],
    };
    const added = {
      ...previous,
      id: "new-item",
      title: "New item",
      description: undefined,
      evidenceRefs: [],
    };
    const barePrevious = {
      ...previous,
      id: "bare-item",
      title: "Bare previous item",
      description: undefined,
      evidenceRefs: undefined,
    };
    const enriched = {
      ...barePrevious,
      status: "done" as const,
      description: "Newly supplied description.",
      evidenceRefs: ["evidence:new-metadata" as const],
    };

    expect(
      preserveTaskPlanItemMetadata([previous, barePrevious], [updated, added, enriched]),
    ).toEqual([
      {
        ...updated,
        description: previous.description,
        evidenceRefs: previous.evidenceRefs,
      },
      added,
      enriched,
    ]);
  });

  it("replaces existing-task dependencies without rewriting or reviewing its plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-dependency-only-"));
    try {
      const ctx = testContext(cwd);
      const stateCwd = sparkStateCwd(cwd, ctx);
      const store = defaultTaskGraphStore(stateCwd);
      const graph = new TaskGraph();
      const project = graph.createProject({
        title: "Dependency-only planning",
        description: "Preserve a reviewed task while changing only dependency edges.",
      });
      const target = graph.createTask({
        projectRef: project.ref,
        name: "target",
        title: "Target",
        description: "Keep every non-dependency field unchanged.",
        kind: "implement",
        status: "pending",
        plan: executionReadyPlan("preserve reviewed target plan"),
      });
      const previous = graph.createTask({
        projectRef: project.ref,
        name: "previous",
        title: "Previous dependency",
        description: "Dependency to remove.",
        status: "done",
      });
      const next = graph.createTask({
        projectRef: project.ref,
        name: "next",
        title: "Next dependency",
        description: "Dependency to add.",
        status: "pending",
      });
      graph.replaceTaskDependencies(target.ref, [previous.ref]);
      await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref);
      const beforeTask = graph.getTask(target.ref);
      const beforeTodos = graph.taskTodos(target.ref);

      const result = await capturePlanTool({ failOnPlanDecision: true }).execute(
        "dependency-only",
        { tasks: [{ name: target.name, dependsOn: [next.name] }] },
        new AbortController().signal,
        () => undefined,
        ctx,
      );

      expect(result.details).toMatchObject({
        mode: "dependency_only",
        reviewSkipped: "unchanged_plan",
        planDecisions: [],
        patches: [{ added: 1, removed: 1, unchanged: 0 }],
      });
      const persisted = await store.load();
      expect(persisted?.getTask(target.ref)).toEqual(beforeTask);
      expect(persisted?.taskTodos(target.ref)).toEqual(beforeTodos);
      expect(persisted?.dependencies(project.ref)).toEqual([
        { taskRef: target.ref, dependsOn: next.ref },
      ]);

      const cleared = await capturePlanTool({ failOnPlanDecision: true }).execute(
        "dependency-clear",
        { tasks: [{ taskRef: target.ref, dependsOn: [] }] },
        new AbortController().signal,
        () => undefined,
        ctx,
      );
      expect(cleared.details).toMatchObject({
        mode: "dependency_only",
        reviewSkipped: "unchanged_plan",
        patches: [{ added: 0, removed: 1, unchanged: 0 }],
      });
      expect((await store.load())?.dependencies(project.ref)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsafe dependency-only patches without saving graph changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-dependency-reject-"));
    try {
      const ctx = testContext(cwd);
      const stateCwd = sparkStateCwd(cwd, ctx);
      const store = defaultTaskGraphStore(stateCwd);
      const graph = new TaskGraph();
      const project = graph.createProject({
        title: "Dependency patch rejection",
        description: "Reject ambiguous or unsafe dependency updates.",
      });
      const target = graph.createTask({
        projectRef: project.ref,
        name: "target",
        title: "Duplicate title",
        description: "Target dependency patch.",
        status: "pending",
        plan: executionReadyPlan("keep target graph atomic"),
      });
      graph.createTask({
        projectRef: project.ref,
        name: "duplicate-title",
        title: target.title,
        description: "Make title selection ambiguous.",
        status: "pending",
      });
      const prerequisite = graph.createTask({
        projectRef: project.ref,
        name: "prerequisite",
        title: "Prerequisite",
        description: "Existing prerequisite.",
        status: "pending",
      });
      graph.replaceTaskDependencies(target.ref, [prerequisite.ref]);
      const cancelled = graph.createTask({
        projectRef: project.ref,
        name: "cancelled",
        title: "Cancelled",
        description: "Cancelled prerequisite.",
        status: "cancelled",
      });
      const otherProject = graph.createProject({
        title: "Other project",
        description: "Cross-project dependency source.",
      });
      const outsider = graph.createTask({
        projectRef: otherProject.ref,
        name: "outsider",
        title: "Outsider",
        description: "Outside selected project.",
      });
      await store.save(graph);
      await saveCurrentProjectRef(cwd, ctx, project.ref);
      const baseline = JSON.stringify((await store.load())?.snapshot());
      const tool = capturePlanTool({ failOnPlanDecision: true });
      const cases = [
        {
          label: "unknown target",
          task: { name: "missing-target", dependsOn: [] },
          message: /unknown task dependency patch target/,
        },
        {
          label: "unknown",
          task: { name: target.name, dependsOn: ["missing"] },
          message: /unknown dependency/,
        },
        {
          label: "self",
          task: { name: target.name, dependsOn: [target.ref] },
          message: /itself/,
        },
        {
          label: "cancelled",
          task: { name: target.name, dependsOn: [cancelled.ref] },
          message: /cancelled/,
        },
        {
          label: "cross-project",
          task: { name: target.name, dependsOn: [outsider.ref] },
          message: /cross projects/,
        },
        {
          label: "cycle",
          task: { name: prerequisite.name, dependsOn: [target.name] },
          message: /cyclic/,
        },
        {
          label: "ambiguous target",
          task: { title: target.title, dependsOn: [] },
          message: /ambiguous task dependency patch target/,
        },
      ];
      for (const scenario of cases) {
        const result = await tool.execute(
          `dependency-reject-${scenario.label}`,
          { tasks: [scenario.task] },
          new AbortController().signal,
          () => undefined,
          ctx,
        );
        expect(result.details, scenario.label).toMatchObject({
          error: "task_dependency_patch_error",
        });
        expect(result.content[0]?.text, scenario.label).toMatch(scenario.message);
        expect(JSON.stringify((await store.load())?.snapshot()), scenario.label).toBe(baseline);
      }

      await expect(
        tool.execute(
          "dependency-reject-mixed-fields",
          { tasks: [{ name: target.name, dependsOn: [], status: "pending" }] },
          new AbortController().signal,
          () => undefined,
          ctx,
        ),
      ).rejects.toThrow(/dependency-only patch only accepts/);
      expect(JSON.stringify((await store.load())?.snapshot())).toBe(baseline);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  for (const status of ["done", "failed"] as const) {
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
      expect(persisted?.getTask(alpha.ref).plan?.items?.[0]?.status).toBe("in_progress");
      expect(persisted?.getTask(beta.ref).plan?.items?.[0]?.status).toBe("in_progress");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
