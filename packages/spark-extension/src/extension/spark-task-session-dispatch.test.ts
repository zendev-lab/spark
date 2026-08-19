import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { defaultArtifactStore, type EvidenceRef } from "@zendev-lab/spark-artifacts";
import { requestSparkDaemon, SparkDaemonRemoteError } from "@zendev-lab/spark-daemon-client";
import type {
  ArtifactRef,
  ProjectRef,
  TaskRef,
  TaskResourceAllocation,
  TaskRun,
} from "@zendev-lab/spark-core";
import { loadSessionGoal } from "@zendev-lab/spark-loop";
import type { SparkFleetWorkerBinding, SparkSessionLineage } from "@zendev-lab/spark-protocol";
import { createSparkSessionRepro } from "@zendev-lab/spark-repro";
import { RoleRegistry } from "@zendev-lab/spark-roles";
import { defaultTaskGraphStore, normalizeTaskPlan, TaskGraph } from "@zendev-lab/spark-tasks";
import {
  dispatchManagedTaskSessions,
  reconcileManagedTaskSessions,
} from "./spark-task-session-dispatch.ts";
import { workspaceSessionRecord } from "../../../../test/support/session-fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Task Session dispatch", () => {
  it("serializes one Fleet lane, reuses its Session, and honors fresh continuity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-task-session-fleet-"));
    roots.push(cwd);
    const worktree = join(cwd, "worktree");
    await mkdir(worktree);
    const artifactRef = "artifact:fleet-worktree" as ArtifactRef;
    await defaultArtifactStore(cwd).put({
      ref: artifactRef,
      kind: "git_change",
      title: "Fleet worktree",
      format: "json",
      body: {
        schemaVersion: 2,
        kind: "git_change",
        repository: { forge: "github", repo: "acme/fleet" },
        trunk: "main",
        worktree: {
          path: worktree,
          branch: "fleet/work",
          ownership: "spark",
          status: "attached",
        },
        stack: { authority: "gh-stack", entries: [] },
        lifecycle: "local",
      },
    });
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Fleet", description: "Fleet" });
    const makeTask = (title: string, continuity: "reuse_within_revision" | "fresh") =>
      graph.createTask({
        projectRef: project.ref,
        title,
        description: title,
        kind: "implement",
        roleRef: "role:builtin-executor",
        artifactRefs: [artifactRef],
        executionPolicy: {
          sessionLifetime: continuity === "fresh" ? "task_run" : "task_revision",
          continuity,
          isolation: "isolated_worktree",
          comparison: "single_side",
          resources: { gpuCount: 0 },
          worktreeTarget: {
            primaryArtifactRef: artifactRef,
            writableArtifactRefs: [artifactRef],
          },
          concurrencyKeys: [],
          maxAttempts: 2,
        },
        plan: normalizeTaskPlan(
          {
            objective: `Implement and verify the bounded change for ${title}.`,
            successCriteria: [
              `The ${title} change is complete and a focused test demonstrates its behavior.`,
            ],
            evidenceRequired: [`An inspectable test result and diff summary for ${title}.`],
            steps: [
              `Inspect the current implementation for ${title}.`,
              `Implement ${title} and run its focused verification.`,
            ],
          },
          title,
          title,
        ),
      });
    const firstTask = makeTask("First lane task", "reuse_within_revision");
    const secondTask = makeTask("Second lane task", "reuse_within_revision");
    const freshTask = makeTask("Fresh lane task", "fresh");
    for (const item of [firstTask, secondTask, freshTask]) graph.setTaskStatus(item.ref, "ready");
    await defaultTaskGraphStore(cwd).save(graph);

    const sessions = new Map<string, SparkFleetWorkerBinding>();
    const sends: Array<Record<string, unknown>> = [];
    let invocation = 0;
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === "session.get") {
        const sessionId = String(input.sessionId);
        const fleetWorker = sessions.get(sessionId);
        return {
          ...workspaceSessionRecord({
            sessionId,
            workspaceId: "ws_fleet",
            supervisorSessionId: "sess_owner",
            roleBinding: fleetWorker
              ? { kind: "explicit", roleRef: fleetWorker.roleRef }
              : { kind: "none" },
            cwd: sessionId === "sess_owner" ? cwd : worktree,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          }),
          ...(fleetWorker ? { fleetWorker } : {}),
        };
      }
      if (method === "session.create") {
        const sessionId = String(input.sessionId);
        if (sessions.has(sessionId)) {
          throw new SparkDaemonRemoteError("session exists", { code: "session_exists" });
        }
        const fleetWorker = input.fleetWorker as SparkFleetWorkerBinding;
        sessions.set(sessionId, fleetWorker);
        return {
          ...workspaceSessionRecord({
            sessionId,
            workspaceId: "ws_fleet",
            supervisorSessionId: "sess_owner",
            roleBinding: input.roleBinding as { kind: "explicit"; roleRef: `role:${string}` },
            cwd: worktree,
            cwdArtifactRef: artifactRef,
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          }),
          fleetWorker,
        };
      }
      if (method === "session.send") {
        sends.push(input);
        invocation += 1;
        return {
          mail: { mailId: `mail_${invocation}` },
          submitted: {
            invocationId: `inv_fleet_${invocation}`,
            status: "queued",
            acceptedAt: "2026-08-11T00:00:00.000Z",
          },
        };
      }
      throw new Error(`unexpected daemon method: ${method}`);
    }) as typeof requestSparkDaemon;
    const dispatch = (taskRefs: TaskRef[]) =>
      dispatchManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        ownerSessionId: "sess_owner",
        parentInvocationId: "inv_owner",
        projectRef: project.ref,
        taskRefs,
        registry: new RoleRegistry(),
        fleet: true,
        daemonRequest,
      });

    const [first] = await dispatch([firstTask.ref]);
    await expect(dispatch([secondTask.ref])).rejects.toThrow(/already has an active TaskRun/u);
    expect((await defaultTaskGraphStore(cwd).load())?.runs(project.ref)).toHaveLength(1);
    await defaultTaskGraphStore(cwd).update(
      (next) => {
        const run = next.runs(project.ref).find((candidate) => candidate.ref === first!.runRef)!;
        next.recordRun({
          ...run,
          status: "succeeded",
          finishedAt: "2026-08-11T00:01:00.000Z",
        });
        next.releaseTaskClaim(firstTask.ref);
        next.setTaskStatus(firstTask.ref, "done");
      },
      { createIfMissing: false },
    );
    const [second] = await dispatch([secondTask.ref]);
    expect(second?.sessionId).toBe(first?.sessionId);
    expect(second?.jobId).not.toBe(first?.jobId);
    expect(second?.runRef).not.toBe(first?.runRef);
    await expect(loadSessionGoal(cwd, { sessionId: first!.sessionId })).resolves.toBeUndefined();
    await defaultTaskGraphStore(cwd).update(
      (next) => {
        const run = next.runs(project.ref).find((candidate) => candidate.ref === second!.runRef)!;
        next.recordRun({
          ...run,
          status: "succeeded",
          finishedAt: "2026-08-11T00:02:00.000Z",
        });
        next.releaseTaskClaim(secondTask.ref);
        next.setTaskStatus(secondTask.ref, "done");
      },
      { createIfMissing: false },
    );
    const [fresh] = await dispatch([freshTask.ref]);
    expect(fresh?.sessionId).not.toBe(first?.sessionId);
    expect(new Set(sends.map((send) => send.toSessionId)).size).toBe(2);
    for (const send of sends) {
      expect(send).toMatchObject({
        fromSessionId: "sess_owner",
        kind: "request",
        intent: "fleet.task.execute",
        wake: true,
        parentInvocationId: "inv_owner",
        payload: {
          kind: "task_execution",
          projectRef: project.ref,
          attempt: 1,
        },
      });
    }
    expect(
      (await defaultTaskGraphStore(cwd).load())?.runs(project.ref).map((run) => ({
        taskRef: run.taskRef,
        lane: run.execution?.workerLaneKey,
        attempt: run.execution?.attempt,
      })),
    ).toEqual([
      { taskRef: firstTask.ref, lane: expect.stringMatching(/^fleet:/u), attempt: 1 },
      { taskRef: secondTask.ref, lane: expect.stringMatching(/^fleet:/u), attempt: 1 },
      { taskRef: freshTask.ref, lane: expect.stringMatching(/^fleet:/u), attempt: 1 },
    ]);
  });

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
        return workspaceSessionRecord({
          sessionId: String(input.sessionId),
          workspaceId: "ws_repro",
          cwd,
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        });
      }
      if (method === "session.create") {
        return {
          ...workspaceSessionRecord({
            sessionId: String(input.sessionId),
            workspaceId: "ws_repro",
            cwd,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          }),
          sessionId: String(input.sessionId),
          lineage: {
            kind: "child",
            parentSessionId: String(input.supervisorSessionId),
            origin: { kind: "task_run", ...(input.taskExecution as Record<string, unknown>) },
          },
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
      if (method === "session.close") {
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
        originKind: "task_revision",
        projectRef: project.ref,
        taskRef: tasks[index]!.ref,
        revisionRef: records[index]!.jobId,
        originatingRunRef: records[index]!.runRef,
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
    const closeCalls = calls.filter((call) => call.method === "session.close");
    expect(closeCalls).toHaveLength(1);
    expect(
      closeCalls.find((call) => call.input.sessionId === records[0]!.sessionId)?.input.completion,
    ).toMatchObject({
      source: "domain_completion",
      status: "completed",
      code: "task_session_completed",
      summary: expect.stringContaining("Subgoal still requires verifier promotion"),
      evidenceRefs: [rawTaskEvidenceRef],
      artifactRefs: [],
      sourceInvocationIds: [records[0]!.invocationId],
    });
    expect(closeCalls.some((call) => call.input.sessionId === records[1]!.sessionId)).toBe(false);
    expect(safeSubgoals.every((subgoal) => subgoal.status !== "done")).toBe(true);
    await expect(
      reconcileManagedTaskSessions({
        cwd,
        ctx: { sessionId: "sess_owner" },
        projectRef: project.ref,
        ownerSessionId: "sess_owner",
        subgoals: safeSubgoals,
        daemonRequest,
      }),
    ).resolves.toEqual({
      inspected: 0,
      terminal: 0,
      succeeded: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
      superseded: 0,
    });
    expect(calls.filter((call) => call.method === "session.close")).toHaveLength(1);
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
      const sessions = new Map<string, Extract<SparkSessionLineage, { kind: "child" }>>();
      const closeInputs: Record<string, unknown>[] = [];
      let invocation = 0;
      const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
        if (method === "session.get") {
          const sessionId = String(input.sessionId);
          return {
            ...workspaceSessionRecord({
              sessionId,
              workspaceId: "ws_repro",
              roleBinding: sessions.has(sessionId)
                ? { kind: "explicit", roleRef: "role:builtin-explorer" }
                : { kind: "none" },
              cwd,
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            }),
            sessionId,
            ...(sessions.has(sessionId) ? { lineage: sessions.get(sessionId)! } : {}),
          };
        }
        if (method === "session.create") {
          const sessionId = String(input.sessionId);
          if (sessions.has(sessionId)) {
            throw new SparkDaemonRemoteError("session exists", { code: "session_exists" });
          }
          const taskExecution = input.taskExecution as Record<string, unknown> & {
            originKind: "task_run" | "task_revision";
          };
          const { originKind, kind: _legacyKind, ...fields } = taskExecution;
          const lineage = {
            kind: "child",
            parentSessionId: String(input.supervisorSessionId),
            origin: { kind: originKind, ...fields },
          } as Extract<SparkSessionLineage, { kind: "child" }>;
          sessions.set(sessionId, lineage);
          return {
            ...workspaceSessionRecord({
              sessionId,
              workspaceId: "ws_repro",
              roleBinding: input.roleBinding as {
                kind: "explicit";
                roleRef: `role:${string}`;
              },
              cwd,
              createdAt: "2026-07-29T00:00:00.000Z",
              updatedAt: "2026-07-29T00:00:00.000Z",
            }),
            sessionId,
            lineage,
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
        if (method === "session.close") {
          closeInputs.push(input);
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
          const currentTask = next.getTask(task.ref);
          next.recordRun({
            ...run,
            status: "failed",
            failureKind: "runtime_error",
            finishedAt: "2026-07-29T00:01:00.000Z",
          });
          if (reusesSession && currentTask.plan?.items?.[0]) {
            next.updateTask(task.ref, {
              plan: {
                ...currentTask.plan,
                items: currentTask.plan.items.map((item, index) =>
                  index === 0
                    ? {
                        ...item,
                        status: "done",
                        notes: ["attempt progress"],
                        evidenceRefs: ["evidence:attempt-progress" as EvidenceRef],
                        updatedAt: "2026-07-29T00:01:00.000Z",
                      }
                    : item,
                ),
              },
            });
          }
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
      expect(closeInputs).toHaveLength(1);
      expect(closeInputs[0]?.completion).toMatchObject({
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
      roleRef: "role:builtin-executor",
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
        roleRef: "role:builtin-executor",
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

    const sessions = new Map<string, Extract<SparkSessionLineage, { kind: "child" }>>();
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === "session.get") {
        const sessionId = String(input.sessionId);
        return {
          ...workspaceSessionRecord({
            sessionId,
            workspaceId: "ws_recovery",
            cwd,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          }),
          ...(sessions.has(sessionId) ? { lineage: sessions.get(sessionId)! } : {}),
        };
      }
      if (method === "session.create") {
        const sessionId = String(input.sessionId);
        const taskExecution = input.taskExecution as Record<string, unknown> & {
          originKind: "task_run" | "task_revision";
        };
        const { originKind, kind: _legacyKind, ...fields } = taskExecution;
        sessions.set(sessionId, {
          kind: "child",
          parentSessionId: String(input.supervisorSessionId),
          origin: { kind: originKind, ...fields },
        } as Extract<SparkSessionLineage, { kind: "child" }>);
        return {
          ...workspaceSessionRecord({
            sessionId,
            workspaceId: "ws_recovery",
            cwd,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          }),
          lineage: sessions.get(sessionId)!,
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
      roleRef: "role:builtin-executor",
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
      roleRef: "role:builtin-executor",
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
        roleRef: "role:builtin-executor",
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
    let closeCalls = 0;
    const daemonRequest = (async (method: string, input: Record<string, unknown>) => {
      if (method === "session.get") {
        return workspaceSessionRecord({
          sessionId: String(input.sessionId),
          workspaceId: "ws_repro",
          cwd,
          createdAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        });
      }
      if (method === "session.create") {
        return {
          ...workspaceSessionRecord({
            sessionId: String(input.sessionId),
            workspaceId: "ws_repro",
            cwd,
            createdAt: "2026-07-29T00:00:00.000Z",
            updatedAt: "2026-07-29T00:00:00.000Z",
          }),
          sessionId: String(input.sessionId),
          lineage: {
            kind: "child",
            parentSessionId: String(input.supervisorSessionId),
            origin: { kind: "task_run", ...(input.taskExecution as Record<string, unknown>) },
          },
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
      if (method === "session.close") {
        closeCalls += 1;
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
    expect(closeCalls).toBe(1);
  });
});
