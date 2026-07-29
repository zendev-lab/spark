import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import type { ProjectRef, TaskRef } from "@zendev-lab/spark-core";
import { loadSessionGoal } from "@zendev-lab/spark-loop";
import { createSparkSessionRepro } from "@zendev-lab/spark-repro";
import { RoleRegistry } from "@zendev-lab/spark-roles";
import { defaultTaskGraphStore, normalizeTaskPlan, TaskGraph } from "@zendev-lab/spark-tasks";
import {
  dispatchManagedTaskSessions,
  reconcileManagedTaskSessions,
} from "./spark-task-session-dispatch.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Task Session dispatch", () => {
  it("creates one daemon Session Goal and execution binding per allowlisted Task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-dispatch-"));
    roots.push(cwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Repro", description: "Repro" });
    const tasks = ["Trace reference", "Probe resource envelope"].map((title) =>
      graph.createTask({
        projectRef: project.ref,
        title,
        description: title,
        kind: "research",
        roleRef: "role:builtin-explorer",
        plan: normalizeTaskPlan(
          {
            objective: title,
            contextRefs: [],
            constraints: [],
            nonGoals: [],
            successCriteria: [`Evidence artifact records ${title} result and command output.`],
            evidenceRequired: [`Evidence artifact containing ${title} command and result.`],
            steps: [`Run ${title} probe and record its observable result.`],
            openQuestions: [],
            askRefs: [],
            riskLevel: "normal",
          },
          title,
          title,
        ),
      }),
    );
    for (const task of tasks) graph.setTaskStatus(task.ref, "ready");
    await defaultTaskGraphStore(cwd).save(graph);
    const repro = createSparkSessionRepro("sess_owner");
    const safeSubgoals = repro.subgoals
      .filter((subgoal) => subgoal.authority === "safe_local")
      .slice(0, tasks.length)
      .map((subgoal, index) => ({ ...subgoal, taskRef: tasks[index]!.ref }));
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      if (method === "session.get") {
        return {
          sessionId: String(input.sessionId),
          scope: { kind: "workspace", workspaceId: "ws_repro" },
          workspaceId: "ws_repro",
          status: "ready",
          cwd,
          bindings: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "session.create") {
        return {
          sessionId: String(input.sessionId),
          scope: { kind: "workspace", workspaceId: "ws_repro" },
          workspaceId: "ws_repro",
          status: "ready",
          cwd,
          role: String(input.role),
          title: String(input.role),
          relation: {
            kind: "task_execution",
            ...(input.taskExecution as Record<string, unknown>),
          },
          bindings: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "turn.submit") {
        return {
          invocationId: `inv_${calls.length}`,
          status: "queued",
          acceptedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "turn.status") {
        return {
          invocationId: String(input.invocationId),
          status: "succeeded",
          acceptedAt: "2026-07-29T00:00:00.000Z",
          completedAt: "2026-07-29T00:01:00.000Z",
        };
      }
      throw new Error(`unexpected daemon method: ${method}`);
    }) as typeof requestSparkDaemon;

    const records = await dispatchManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      ownerSessionId: "sess_owner",
      projectRef: project.ref as ProjectRef,
      taskRefs: tasks.map((task) => task.ref as TaskRef),
      registry: new RoleRegistry(),
      subgoals: safeSubgoals,
      daemonRequest,
    });

    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.sessionId)).size).toBe(2);
    const persisted = await defaultTaskGraphStore(cwd).load();
    expect(persisted?.runs(project.ref)).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      const run = persisted?.runs(project.ref).find((candidate) => candidate.ref === record.runRef);
      expect(run).toMatchObject({
        taskRef: tasks[index]!.ref,
        status: "running",
        execution: {
          ownerSessionId: "sess_owner",
          executionSessionId: record.sessionId,
          sessionGoalId: record.goalId,
          subgoalRef: safeSubgoals[index]!.ref,
          jobId: record.jobId,
          attempt: 1,
          invocationId: expect.stringMatching(/^inv_/u),
        },
      });
      await expect(loadSessionGoal(cwd, { sessionId: record.sessionId })).resolves.toMatchObject({
        goalId: record.goalId,
        objective: safeSubgoals[index]!.goal,
        status: "active",
      });
    }
    expect(calls.filter((call) => call.method === "session.create")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "turn.submit")).toHaveLength(2);

    const afterDispatch = await defaultTaskGraphStore(cwd).load();
    afterDispatch!.setTaskStatus(tasks[0]!.ref, "done");
    await defaultTaskGraphStore(cwd).save(afterDispatch!);
    const reconciled = await reconcileManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      projectRef: project.ref,
      subgoals: safeSubgoals,
      daemonRequest,
    });
    expect(reconciled).toMatchObject({
      inspected: 2,
      terminal: 2,
      succeeded: 1,
      blocked: 1,
    });
    const finalGraph = await defaultTaskGraphStore(cwd).load();
    expect(
      Object.fromEntries(
        finalGraph?.runs(project.ref).map((run) => [run.taskRef, run.status]) ?? [],
      ),
    ).toEqual({
      [tasks[0]!.ref]: "succeeded",
      [tasks[1]!.ref]: "blocked",
    });
    expect(safeSubgoals.every((subgoal) => subgoal.status !== "done")).toBe(true);
  });
});
