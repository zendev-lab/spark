import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import type { ProjectRef, TaskRef, TaskResourceAllocation } from "@zendev-lab/spark-core";
import { loadSessionGoal } from "@zendev-lab/spark-loop";
import type { SparkTaskExecutionSessionRelation } from "@zendev-lab/spark-protocol";
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
            successCriteria: [`Evidence record captures ${title} result and command output.`],
            evidenceRequired: [`Evidence record containing ${title} command and result.`],
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
    for (const [index, call] of calls
      .filter((candidate) => candidate.method === "session.create")
      .entries()) {
      expect(call.input.taskExecution).toMatchObject({
        projectRef: project.ref,
        taskRef: tasks[index]!.ref,
        runRef: records[index]!.runRef,
        sessionGoalId: records[index]!.goalId,
        subgoalRef: safeSubgoals[index]!.ref,
        attempt: 1,
      });
    }
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

  it.each([
    { continuity: "reuse_within_revision" as const, reusesSession: true },
    { continuity: "fresh" as const, reusesSession: false },
  ])(
    "$continuity selects the expected Session across bounded retries",
    async ({ continuity, reusesSession }) => {
      const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-continuity-"));
      roots.push(cwd);
      const graph = new TaskGraph();
      const project = graph.createProject({ title: "Retry", description: "Retry" });
      const task = graph.createTask({
        projectRef: project.ref,
        title: "Retry task",
        description: "Retry task",
        kind: "research",
        roleRef: "role:builtin-explorer",
        executionPolicy: {
          continuity,
          isolation: "isolated_results",
          comparison: "single_side",
          resources: { gpuCount: 1 },
          concurrencyKeys: ["results:retry-task"],
          maxAttempts: 2,
        },
        plan: normalizeTaskPlan(
          {
            objective: "Retry task",
            successCriteria: ["A bounded retry records inspectable evidence."],
            evidenceRequired: ["Evidence record from the retry."],
            steps: ["Run the bounded retry and report the outcome."],
          },
          "Retry task",
          "Retry task",
        ),
      });
      graph.setTaskStatus(task.ref, "ready");
      await defaultTaskGraphStore(cwd).save(graph);
      const resourceAllocation: TaskResourceAllocation = {
        leaseId: "resource:retry",
        nodeId: "node-8",
        groups: [{ side: "single_side", gpuIds: ["3"] }],
        gpuIds: ["3"],
        concurrencyKeys: ["results:retry-task"],
        exclusiveNode: false,
        allocatedAt: "2026-07-29T00:00:00.000Z",
      };
      const sessions = new Map<string, SparkTaskExecutionSessionRelation>();
      let invocation = 0;
      const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
        if (method === "session.get") {
          const sessionId = String(input.sessionId);
          return {
            sessionId,
            scope: { kind: "workspace", workspaceId: "ws_repro" },
            workspaceId: "ws_repro",
            status: "ready",
            cwd,
            relation: sessions.get(sessionId),
            bindings: [],
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          };
        }
        if (method === "session.create") {
          const sessionId = String(input.sessionId);
          if (sessions.has(sessionId)) {
            throw new SparkDaemonRemoteError("session exists", { code: "session_exists" });
          }
          sessions.set(sessionId, {
            kind: "task_execution",
            ...(input.taskExecution as Omit<SparkTaskExecutionSessionRelation, "kind">),
          });
          return {
            sessionId,
            scope: { kind: "workspace", workspaceId: "ws_repro" },
            workspaceId: "ws_repro",
            status: "ready",
            cwd,
            relation: sessions.get(sessionId),
            bindings: [],
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          };
        }
        if (method === "turn.submit") {
          invocation += 1;
          return {
            invocationId: `inv_${invocation}`,
            status: "queued",
            acceptedAt: "2026-07-29T00:00:00.000Z",
          };
        }
        throw new Error(`unexpected daemon method: ${method}`);
      }) as typeof requestSparkDaemon;

      const first = await dispatchManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        ownerSessionId: "sess_owner",
        projectRef: project.ref,
        taskRefs: [task.ref],
        registry: new RoleRegistry(),
        resourceAllocations: { [task.ref]: resourceAllocation },
        daemonRequest,
      });
      await defaultTaskGraphStore(cwd).update(
        (next) => {
          const run = next.runs(project.ref).at(-1)!;
          next.recordRun({
            ...run,
            status: "failed",
            failureKind: "runtime_error",
            finishedAt: "2026-07-29T00:01:00.000Z",
          });
          next.releaseTaskClaim(task.ref);
          next.setTaskStatus(task.ref, "ready");
        },
        { createIfMissing: false },
      );
      const second = await dispatchManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        ownerSessionId: "sess_owner",
        projectRef: project.ref,
        taskRefs: [task.ref],
        registry: new RoleRegistry(),
        resourceAllocations: { [task.ref]: resourceAllocation },
        daemonRequest,
      });

      expect(second[0]?.attempt).toBe(2);
      expect(second[0]?.sessionId === first[0]?.sessionId).toBe(reusesSession);
      expect(second[0]?.goalId === first[0]?.goalId).toBe(reusesSession);
      const persisted = await defaultTaskGraphStore(cwd).load();
      expect(persisted?.runs(project.ref).at(-1)?.resourceAllocation).toEqual(resourceAllocation);
    },
  );

  it("requests timeout cancellation before releasing a managed resource lease", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-timeout-"));
    roots.push(cwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Timeout", description: "Timeout" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Timeout task",
      description: "Timeout task",
      kind: "research",
      roleRef: "role:builtin-explorer",
      executionPolicy: {
        continuity: "reuse_within_revision",
        isolation: "isolated_results",
        comparison: "single_side",
        resources: { gpuCount: 1 },
        concurrencyKeys: ["results:timeout-task"],
        timeoutMs: 1,
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Timeout task",
          successCriteria: ["Evidence record captures Timeout task result and command output."],
          evidenceRequired: ["Evidence record containing timeout command and result."],
          steps: ["Run Timeout task probe and record its observable result."],
        },
        "Timeout task",
        "Timeout task",
      ),
    });
    graph.setTaskStatus(task.ref, "ready");
    await defaultTaskGraphStore(cwd).save(graph);
    let invocationStatus: "running" | "cancelled" = "running";
    let cancelCalls = 0;
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
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
          invocationId: "inv_timeout",
          status: "queued",
          acceptedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "turn.status") {
        return {
          invocationId: "inv_timeout",
          status: invocationStatus,
          acceptedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "turn.cancel") {
        cancelCalls += 1;
        return {
          invocationId: "inv_timeout",
          status: invocationStatus,
          cancelRequested: true,
        };
      }
      throw new Error(`unexpected daemon method: ${method}`);
    }) as typeof requestSparkDaemon;

    await dispatchManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      ownerSessionId: "sess_owner",
      projectRef: project.ref,
      taskRefs: [task.ref],
      registry: new RoleRegistry(),
      daemonRequest,
    });
    await defaultTaskGraphStore(cwd).update(
      (next) => {
        const run = next.runs(project.ref).at(-1)!;
        next.recordRun({ ...run, startedAt: "2020-01-01T00:00:00.000Z" });
      },
      { createIfMissing: false },
    );
    const cancelling = await reconcileManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      projectRef: project.ref,
      daemonRequest,
    });
    expect(cancelling.terminal).toBe(0);
    expect(cancelCalls).toBe(1);
    let persisted = await defaultTaskGraphStore(cwd).load();
    expect(persisted?.runs(project.ref).at(-1)).toMatchObject({
      status: "running",
      timeoutRequestedAt: expect.any(String),
    });

    invocationStatus = "cancelled";
    const settled = await reconcileManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      projectRef: project.ref,
      daemonRequest,
    });
    expect(settled).toMatchObject({ terminal: 1, failed: 1 });
    persisted = await defaultTaskGraphStore(cwd).load();
    expect(persisted?.runs(project.ref).at(-1)).toMatchObject({
      status: "failed",
      failureKind: "runtime_timeout",
    });
    expect(persisted?.getTask(task.ref).status).toBe("failed");
  });
});
