import { describe, expect, it } from "vitest";
import type { Task, TaskRun } from "@zendev-lab/spark-core";
import { isTaskSessionOwnerValid } from "./session-task-owner.ts";

describe("Task Session origin validity", () => {
  it("accepts only the active run bound to the exact Session", async () => {
    const run = taskRun();
    const subject = {
      origin: {
        kind: "task_run",
        projectRef: run.projectRef,
        taskRef: run.taskRef,
        runRef: run.ref,
        sessionGoalId: run.execution!.sessionGoalId,
        roleRef: "role:executor",
        jobId: run.execution!.jobId,
        attempt: 1,
      } as const,
      workspaceId: "ws-test",
      sessionId: run.execution!.sessionId!,
    };
    const options = {
      resolveWorkspaceCwd: () => "/workspace",
      loadGraph: async () => graph(run),
    };
    await expect(isTaskSessionOwnerValid(subject, options)).resolves.toBe(true);
    await expect(
      isTaskSessionOwnerValid({ ...subject, sessionId: "session-other" }, options),
    ).resolves.toBe(false);
    await expect(
      isTaskSessionOwnerValid(subject, {
        ...options,
        loadGraph: async () => graph({ ...run, status: "succeeded" }),
      }),
    ).resolves.toBe(false);
  });

  it("keeps a revision Session only while its Task remains unfinished", async () => {
    const run = taskRun({ sessionLifetime: "task_revision", status: "succeeded" });
    const subject = {
      origin: {
        kind: "task_revision",
        projectRef: run.projectRef,
        taskRef: run.taskRef,
        revisionRef: run.execution!.jobId,
        originatingRunRef: run.ref,
        sessionGoalId: run.execution!.sessionGoalId,
        roleRef: "role:executor",
        jobId: run.execution!.jobId,
        attempt: 1,
      } as const,
      workspaceId: "ws-test",
      sessionId: run.execution!.sessionId!,
    };
    const options = {
      resolveWorkspaceCwd: () => "/workspace",
      loadGraph: async () => graph(run),
    };
    await expect(isTaskSessionOwnerValid(subject, options)).resolves.toBe(true);
    await expect(
      isTaskSessionOwnerValid(subject, {
        ...options,
        loadGraph: async () => graph(run, "done"),
      }),
    ).resolves.toBe(false);
  });
});

function taskRun(
  input: { sessionLifetime?: "task_run" | "task_revision"; status?: TaskRun["status"] } = {},
): TaskRun {
  return {
    ref: "run:test",
    projectRef: "proj:test",
    taskRef: "task:test",
    status: input.status ?? "running",
    outputEvidenceRefs: [],
    execution: {
      ownerSessionId: "session-owner",
      sessionId: "session-task",
      executionSessionId: "session-task",
      sessionGoalId: "goal-task",
      sessionLifetime: input.sessionLifetime ?? "task_run",
      jobId: "job-task",
      attempt: 1,
    },
  };
}

function graph(run: TaskRun, taskStatus: Task["status"] = "running") {
  return {
    runs: () => [run],
    getTask: () => ({ status: taskStatus }),
  };
}
