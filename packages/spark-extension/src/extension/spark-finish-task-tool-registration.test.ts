import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { nowIso, type EvidenceRef, type RoleRef, type TaskPlan, type TaskRef } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, TaskGraph } from "@zendev-lab/spark-tasks";
import type { ReviewerRunner, TaskReviewInput } from "@zendev-lab/spark-roles/reviewer-runner";
import { registerSparkFinishTaskTool } from "./spark-finish-task-tool-registration.ts";
import {
  saveCurrentProjectRef,
  sparkSessionKey,
  sparkStateCwd,
} from "./session-state.ts";
import type {
  SparkRegisteredToolConfig,
  SparkToolContext,
} from "./spark-tool-registration.ts";
import type { SparkTaskClaimDaemonClient } from "./spark-task-claim-daemon-client.ts";

function executionReadyPlan(objective: string): TaskPlan {
  return {
    objective,
    contextRefs: [],
    constraints: [],
    nonGoals: [],
    successCriteria: [`pnpm test verifies ${objective} with exit code 0.`],
    evidenceRequired: [`Evidence records the ${objective} test command and exit code.`],
    steps: [objective],
    riskLevel: "normal",
    openQuestions: [],
    askRefs: [],
  };
}

function testContext(cwd: string): SparkToolContext {
  const sessionId = "session:finish-contract";
  return {
    cwd,
    sessionId,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => join(cwd, "session.json"),
      getLeafId: () => "finish-contract-leaf",
      isPersisted: () => true,
    },
  };
}

function approvedReviewer(onReview: (input: TaskReviewInput) => void): ReviewerRunner {
  return {
    async review(input) {
      assert.equal(input.targetKind, "task");
      onReview(input);
      return {
        verdict: {
          targetKind: "task",
          taskRef: input.task.ref,
          approved: true,
          outcome: "approved",
          summary: "Completion evidence is sufficient.",
          findings: [],
          blockers: [],
          confidence: "high",
        },
        record: {
          roleRef: "role:builtin-reviewer" as RoleRef,
          runName: "reviewer-test",
          startedAt: nowIso(),
          finishedAt: nowIso(),
        },
      };
    },
  };
}

async function addCompletionEvidence(
  cwd: string,
  graph: TaskGraph,
  taskRef: TaskRef,
): Promise<EvidenceRef> {
  const task = graph.getTask(taskRef);
  const evidence = await defaultEvidenceStore(cwd).put({
    kind: "trace",
    title: `Evidence for ${task.title}`,
    format: "text",
    body: "pnpm test exited 0",
    provenance: { producer: "task", projectRef: task.projectRef, taskRef },
  });
  graph.attachOutputEvidence(taskRef, evidence.ref);
  return evidence.ref;
}

function captureFinishTool(input: {
  daemon: SparkTaskClaimDaemonClient;
  reviewer: ReviewerRunner;
}): SparkRegisteredToolConfig {
  let tool: SparkRegisteredToolConfig | undefined;
  registerSparkFinishTaskTool(
    (registered) => {
      tool = registered;
    },
    {
      refreshSparkWidget: async () => undefined,
      taskClaimDaemonClient: input.daemon,
      createReviewerRunner: async () => input.reviewer,
    },
  );
  assert.ok(tool);
  return tool;
}

async function executeFinish(
  tool: SparkRegisteredToolConfig,
  ctx: SparkToolContext,
  params: Record<string, unknown>,
) {
  return await tool.execute(
    "finish-call",
    params,
    new AbortController().signal,
    () => undefined,
    ctx,
  );
}

test("finish honors taskRef and text instead of finishing the current claimed task", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-finish-selector-"));
  try {
    const ctx = testContext(cwd);
    const sessionKey = sparkSessionKey(ctx);
    const stateCwd = sparkStateCwd(cwd, ctx);
    const store = defaultTaskGraphStore(stateCwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Finish contract", description: "selector" });
    const target = graph.createTask({
      projectRef: project.ref,
      name: "target",
      title: "Target task",
      description: "Finish exactly this task",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("finish the target task"),
    });
    const current = graph.createTask({
      projectRef: project.ref,
      name: "current",
      title: "Current distractor",
      description: "Must remain running",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("keep the distractor running"),
    });
    graph.claimTask(target.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    graph.claimTask(current.ref, {
      kind: "role-run",
      claimedBy: `${sessionKey}/worker-test`,
      sessionId: sessionKey,
      runName: "worker-test",
      leaseMs: 60_000,
    });
    graph.applyTodoOps(target.ref, [{ op: "done", item: "finish the target task" }]);
    graph.applyTodoOps(current.ref, [{ op: "done", item: "keep the distractor running" }]);
    await addCompletionEvidence(stateCwd, graph, target.ref);
    await addCompletionEvidence(stateCwd, graph, current.ref);
    graph.setCurrentTask(project.ref, current.ref);
    await store.save(graph);
    await saveCurrentProjectRef(cwd, ctx, project.ref, current.ref);

    const daemonCalls: TaskRef[] = [];
    const daemon: SparkTaskClaimDaemonClient = {
      acquire: async () => {
        throw new Error("not used");
      },
      recover: async () => {
        throw new Error("not used");
      },
      release: async (_ctx, input) => {
        if (input.disposition === "release") throw new Error("finish must use a terminal disposition");
        daemonCalls.push(input.taskRef as TaskRef);
        const committed = await store.update((mutable) =>
          mutable.setTaskStatus(input.taskRef as TaskRef, input.disposition),
        );
        const task = committed.result;
        return {
          taskRef: task.ref,
          projectRef: task.projectRef,
          sessionId: sessionKey,
          outcome: "released",
          changed: true,
          observedAt: nowIso(),
        } as Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>;
      },
    };
    let reviewed: TaskReviewInput | undefined;
    const tool = captureFinishTool({
      daemon,
      reviewer: approvedReviewer((input) => {
        reviewed = input;
      }),
    });

    const result = await executeFinish(tool, ctx, {
      taskRef: target.ref,
      text: "Target validation completed.",
      status: "done",
    });

    assert.deepEqual(daemonCalls, [target.ref]);
    assert.equal(reviewed?.task.ref, target.ref);
    assert.equal(reviewed?.summary, "Target validation completed.");
    assert.equal(
      result.details?.transition &&
        (result.details.transition as { committed?: boolean }).committed,
      true,
    );
    const persisted = await store.load();
    assert.equal(persisted?.getTask(target.ref).status, "done");
    assert.equal(persisted?.getTask(current.ref).status, "running");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finish blocks missing completion evidence before reviewer or daemon authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-finish-evidence-gate-"));
  try {
    const ctx = testContext(cwd);
    const sessionKey = sparkSessionKey(ctx);
    const store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx));
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Finish evidence", description: "gate" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "needs-evidence",
      title: "Needs completion evidence",
      description: "Must not complete without Evidence",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("require completion evidence"),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    graph.applyTodoOps(task.ref, [{ op: "done", item: "require completion evidence" }]);
    graph.setCurrentTask(project.ref, task.ref);
    await store.save(graph);
    await saveCurrentProjectRef(cwd, ctx, project.ref, task.ref);

    let reviewerCalls = 0;
    let daemonCalls = 0;
    const tool = captureFinishTool({
      reviewer: approvedReviewer(() => {
        reviewerCalls += 1;
      }),
      daemon: {
        acquire: async () => {
          throw new Error("not used");
        },
        recover: async () => {
          throw new Error("not used");
        },
        release: async () => {
          daemonCalls += 1;
          throw new Error("finish must not reach daemon");
        },
      },
    });

    const result = await executeFinish(tool, ctx, { taskRef: task.ref, status: "done" });

    assert.equal(result.details?.error, "missing_completion_evidence");
    assert.equal(reviewerCalls, 0);
    assert.equal(daemonCalls, 0);
    assert.equal((await store.load())?.getTask(task.ref).status, "running");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("finish never reports committed when daemon no-op leaves the task unfinished", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "spark-finish-projection-"));
  try {
    const ctx = testContext(cwd);
    const sessionKey = sparkSessionKey(ctx);
    const stateCwd = sparkStateCwd(cwd, ctx);
    const store = defaultTaskGraphStore(stateCwd);
    const graph = new TaskGraph();
    const project = graph.createProject({ title: "Finish projection", description: "authority" });
    const task = graph.createTask({
      projectRef: project.ref,
      name: "projection",
      title: "Projection task",
      description: "Reject false commit reports",
      kind: "implement",
      status: "running",
      plan: executionReadyPlan("verify the authoritative projection"),
    });
    graph.claimTask(task.ref, {
      kind: "main",
      claimedBy: sessionKey,
      sessionId: sessionKey,
      leaseMs: 60_000,
    });
    graph.applyTodoOps(task.ref, [
      { op: "done", item: "verify the authoritative projection" },
    ]);
    await addCompletionEvidence(stateCwd, graph, task.ref);
    graph.setCurrentTask(project.ref, task.ref);
    await store.save(graph);
    await saveCurrentProjectRef(cwd, ctx, project.ref, task.ref);

    const tool = captureFinishTool({
      reviewer: approvedReviewer(() => undefined),
      daemon: {
        acquire: async () => {
          throw new Error("not used");
        },
        recover: async () => {
          throw new Error("not used");
        },
        release: async () =>
          ({
            taskRef: task.ref,
            projectRef: project.ref,
            sessionId: sessionKey,
            outcome: "released",
            changed: false,
            observedAt: nowIso(),
          }) as Awaited<ReturnType<SparkTaskClaimDaemonClient["release"]>>,
      },
    });

    const result = await executeFinish(tool, ctx, { taskRef: task.ref, status: "done" });

    assert.equal(result.isError, true);
    assert.equal(result.details?.error, "daemon_finish_projection_mismatch");
    assert.equal(result.details?.committed, false);
    assert.equal((await store.load())?.getTask(task.ref).status, "running");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
