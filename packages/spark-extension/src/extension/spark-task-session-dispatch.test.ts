import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceRef } from "@zendev-lab/spark-artifacts";
import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import type {
  ArtifactRef,
  ProjectRef,
  TaskRef,
  TaskResourceAllocation,
  TaskRun,
} from "@zendev-lab/spark-core";
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
      if (method === "session.archive") {
        return {
          sessionId: String(input.sessionId),
          lifecycle: "closed",
          archived: true,
        };
      }
      throw new Error(`unexpected daemon method: ${method}`);
    }) as typeof requestSparkDaemon;

    const records = await dispatchManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      ownerSessionId: "sess_owner",
      parentInvocationId: "inv_parent_repro_turn",
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
      expect(persisted?.getTask(tasks[index]!.ref).claim).toMatchObject({
        claimedBy: `session:${record.sessionId}`,
        sessionId: `session:${record.sessionId}`,
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
    for (const call of calls.filter((candidate) => candidate.method === "turn.submit")) {
      expect(call.input.parentInvocationId).toBe("inv_parent_repro_turn");
    }

    const rawTaskEvidenceRef = "evidence:task-output" as EvidenceRef;
    const afterDispatch = await defaultTaskGraphStore(cwd).load();
    afterDispatch!.attachOutputEvidence(tasks[0]!.ref, rawTaskEvidenceRef);
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
    const succeededRun = finalGraph?.runs(project.ref).find((run) => run.taskRef === tasks[0]!.ref);
    expect(succeededRun?.outputEvidenceRefs).toEqual([rawTaskEvidenceRef]);
    expect(succeededRun?.completionSummary?.summary).toContain(
      "Subgoal still requires verifier promotion",
    );
    const archiveCalls = calls.filter((call) => call.method === "session.archive");
    expect(archiveCalls).toHaveLength(1);
    expect(
      archiveCalls.find((call) => call.input.sessionId === records[0]!.sessionId)?.input.completion,
    ).toMatchObject({
      source: "domain_completion",
      status: "completed",
      code: "task_session_completed",
      summary: expect.stringContaining("Subgoal still requires verifier promotion"),
      evidenceRefs: [rawTaskEvidenceRef],
      artifactRefs: [],
      sourceInvocationIds: [records[0]!.invocationId],
    });
    expect(archiveCalls.some((call) => call.input.sessionId === records[1]!.sessionId)).toBe(false);
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
          sessionLifetime: reusesSession ? "task_revision" : "task_run",
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
      const archiveInputs: Record<string, unknown>[] = [];
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
        if (method === "turn.status") {
          return {
            invocationId: String(input.invocationId),
            status: "succeeded",
            acceptedAt: "2026-07-29T00:00:00.000Z",
            completedAt: "2026-07-29T00:01:00.000Z",
          };
        }
        if (method === "session.archive") {
          archiveInputs.push(input);
          return {
            sessionId: String(input.sessionId),
            lifecycle: "closed",
            archived: true,
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

      const completionEvidence = "evidence:retry-complete" as EvidenceRef;
      await defaultTaskGraphStore(cwd).update(
        (next) => {
          next.attachOutputEvidence(task.ref, completionEvidence);
          next.linkTaskArtifact(task.ref, "artifact:retry-change" as ArtifactRef);
          next.setTaskStatus(task.ref, "done");
        },
        { createIfMissing: false },
      );
      await reconcileManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        projectRef: project.ref,
        daemonRequest,
      });
      expect(archiveInputs).toHaveLength(1);
      expect(archiveInputs[0]?.completion).toMatchObject({
        source: "domain_completion",
        status: "completed",
        evidenceRefs: [completionEvidence],
        artifactRefs: ["artifact:retry-change"],
        sourceInvocationIds: reusesSession ? ["inv_1", "inv_2"] : ["inv_2"],
      });
    },
  );

  it("continues attempt ordinal after terminal_without_claim recovery", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-recovery-lineage-"));
    roots.push(cwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Recovery", description: "Recovery" });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Recovered task",
      description: "Recovered task",
      kind: "implement",
      roleRef: "role:builtin-worker",
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        resources: { gpuCount: 0 },
        concurrencyKeys: [],
        maxAttempts: 3,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Recover immutable attempt lineage",
          successCriteria: ["A bounded recovery records inspectable attempt lineage evidence."],
          evidenceRequired: ["Evidence record containing the recovered attempt ordinal."],
          steps: ["Run the bounded recovery and report the persisted attempt ordinal."],
        },
        "Recovered task",
        "Recovered task",
      ),
    });
    for (const [index, status] of ["blocked", "failed"].entries()) {
      const attempt = index + 1;
      graph.recordRun({
        ref: ("run:history-" + attempt) as TaskRun["ref"],
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-worker",
        runName: task.name + "-attempt-" + attempt,
        ownerSessionId: "sess_owner",
        execution: {
          ownerSessionId: "sess_owner",
          executionSessionId: "sess_task_archived_" + attempt,
          sessionGoalId: "goal-archived-" + attempt,
          jobId: "task-job:original-revision",
          attempt,
          invocationId: "inv_archived_" + attempt,
        },
        resourceAllocation: {
          leaseId: "resource:archived-" + attempt,
          nodeId: "node-old",
          groups: [],
          gpuIds: [],
          concurrencyKeys: [],
          exclusiveNode: false,
          allocatedAt: "2026-07-29T00:0" + attempt + ":00.000Z",
        },
        status: status as "blocked" | "failed",
        startedAt: "2026-07-29T00:0" + attempt + ":00.000Z",
        finishedAt: "2026-07-29T00:0" + attempt + ":30.000Z",
        outputEvidenceRefs: [],
      });
    }
    graph.updateTask(task.ref, {
      status: "pending",
      description: "Recovered task revision",
    });
    await defaultTaskGraphStore(cwd).save(graph);

    const sessions = new Map<string, SparkTaskExecutionSessionRelation>();
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === "session.get") {
        const sessionId = String(input.sessionId);
        return {
          sessionId,
          scope: { kind: "workspace", workspaceId: "ws_recovery" },
          workspaceId: "ws_recovery",
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
        sessions.set(sessionId, {
          kind: "task_execution",
          ...(input.taskExecution as Omit<SparkTaskExecutionSessionRelation, "kind">),
        });
        return {
          sessionId,
          scope: { kind: "workspace", workspaceId: "ws_recovery" },
          workspaceId: "ws_recovery",
          status: "ready",
          cwd,
          relation: sessions.get(sessionId),
          bindings: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      if (method === "turn.submit") {
        return {
          invocationId: "inv_recovered_fresh",
          status: "queued",
          acceptedAt: "2026-07-29T00:00:00.000Z",
        };
      }
      throw new Error("unexpected daemon method: " + method);
    }) as typeof requestSparkDaemon;
    const recoveredLease: TaskResourceAllocation = {
      leaseId: "resource:recovered-fresh",
      nodeId: "node-new",
      groups: [],
      gpuIds: [],
      concurrencyKeys: [],
      exclusiveNode: false,
      allocatedAt: "2026-07-29T00:03:00.000Z",
    };

    const [record] = await dispatchManagedTaskSessions({
      cwd,
      ctx: { sessionId: "sess_owner" },
      ownerSessionId: "sess_owner",
      projectRef: project.ref,
      taskRefs: [task.ref],
      registry: new RoleRegistry(),
      resourceAllocations: { [task.ref]: recoveredLease },
      daemonRequest,
    });

    expect(record).toMatchObject({
      attempt: 3,
      invocationId: "inv_recovered_fresh",
    });
    expect(record?.sessionId).not.toBe("sess_task_archived_1");
    expect(record?.sessionId).not.toBe("sess_task_archived_2");
    const persisted = await defaultTaskGraphStore(cwd).load();
    const recoveredRun = persisted?.runs(project.ref).at(-1);
    expect(recoveredRun).toMatchObject({
      runName: `${task.name}-attempt-3`,
      execution: {
        attempt: 3,
        executionSessionId: record?.sessionId,
        invocationId: "inv_recovered_fresh",
      },
      resourceAllocation: recoveredLease,
    });
    expect(recoveredRun?.execution?.jobId).not.toBe("task-job:original-revision");
  });

  it("rejects recovery assignment beyond maxAttempts without durable identities", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-recovery-exhausted-"));
    roots.push(cwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Exhausted", description: "Exhausted" });
    const runnable = graph.createTask({
      projectRef: project.ref,
      title: "Runnable task",
      description: "Must not receive an identity before batch attempt preflight completes.",
      kind: "implement",
      roleRef: "role:builtin-worker",
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        resources: { gpuCount: 0 },
        concurrencyKeys: [],
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Keep the runnable task unassigned",
          successCriteria: ["No identity is created for a partially accepted batch."],
          evidenceRequired: ["The exhausted peer causes an atomic refusal."],
          steps: ["Preflight every requested task before reserving any run."],
        },
        "Runnable task",
        "Runnable task",
      ),
    });
    const task = graph.createTask({
      projectRef: project.ref,
      title: "Exhausted task",
      description: "Exhausted task",
      kind: "implement",
      roleRef: "role:builtin-worker",
      executionPolicy: {
        sessionLifetime: "task_revision",
        continuity: "reuse_within_revision",
        isolation: "isolated_worktree",
        comparison: "single_side",
        resources: { gpuCount: 0 },
        concurrencyKeys: [],
        maxAttempts: 2,
      },
      plan: normalizeTaskPlan(
        {
          objective: "Retry exhausted task",
          successCriteria: ["A bounded retry records inspectable evidence."],
          evidenceRequired: ["Evidence record from the retry."],
          steps: ["Run the bounded retry and report the outcome."],
        },
        "Exhausted task",
        "Exhausted task",
      ),
    });
    for (const attempt of [1, 2]) {
      graph.recordRun({
        ref: ("run:exhausted-" + attempt) as TaskRun["ref"],
        projectRef: project.ref,
        taskRef: task.ref,
        roleRef: "role:builtin-worker",
        runName: task.name + "-attempt-" + attempt,
        ownerSessionId: "sess_owner",
        execution: {
          ownerSessionId: "sess_owner",
          executionSessionId: "sess_task_exhausted_" + attempt,
          sessionGoalId: "goal-exhausted-" + attempt,
          jobId: "task-job:revision-" + attempt,
          attempt,
          invocationId: "inv_exhausted_" + attempt,
        },
        status: "failed",
        startedAt: "2026-07-29T00:0" + attempt + ":00.000Z",
        finishedAt: "2026-07-29T00:0" + attempt + ":30.000Z",
        outputEvidenceRefs: [],
      });
    }
    graph.updateTask(runnable.ref, { status: "pending" });
    graph.updateTask(task.ref, { status: "pending" });
    await defaultTaskGraphStore(cwd).save(graph);
    let daemonCalls = 0;
    let refusal: unknown;
    try {
      await dispatchManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        ownerSessionId: "sess_owner",
        projectRef: project.ref,
        taskRefs: [runnable.ref, task.ref],
        registry: new RoleRegistry(),
        resourceAllocations: {
          [runnable.ref]: {
            leaseId: "resource:runnable-must-not-persist",
            nodeId: "node-new",
            groups: [],
            gpuIds: [],
            concurrencyKeys: [],
            exclusiveNode: false,
            allocatedAt: "2026-07-29T00:03:00.000Z",
          },
          [task.ref]: {
            leaseId: "resource:must-not-persist",
            nodeId: "node-new",
            groups: [],
            gpuIds: [],
            concurrencyKeys: [],
            exclusiveNode: false,
            allocatedAt: "2026-07-29T00:03:00.000Z",
          },
        },
        daemonRequest: (async () => {
          daemonCalls += 1;
          throw new Error("daemon must not be called");
        }) as typeof requestSparkDaemon,
      });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toMatchObject({
      accepted: false,
      reason: "attempt_limit",
      message: expect.stringContaining("immutable run history requires attempt=3"),
    });
    for (const identity of ["runRef", "executionSessionId", "invocationId", "leaseId"]) {
      expect(refusal).not.toHaveProperty(identity);
    }
    expect(daemonCalls).toBe(0);
    const persisted = await defaultTaskGraphStore(cwd).load();
    expect(persisted?.runs(project.ref)).toHaveLength(2);
    expect(persisted?.getTask(runnable.ref).claim).toBeUndefined();
    expect(persisted?.getTask(task.ref).claim).toBeUndefined();
  });

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
        sessionLifetime: "task_revision",
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
      if (method === "session.archive") {
        return {
          sessionId: String(input.sessionId),
          lifecycle: "closed",
          archived: true,
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
