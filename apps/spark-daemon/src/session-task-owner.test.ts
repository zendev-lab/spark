import { describe, expect, it } from "vitest";
import type { TaskRun } from "@zendev-lab/spark-core";
import { isTaskSessionOwnerValid } from "./session-task-owner.ts";

describe("Task Session owner validity", () => {
  it("accepts only the active run bound to the exact Session", async () => {
    const run = taskRun();
    const subject = {
      owner: { kind: "task_run", ref: run.ref } as const,
      workspaceId: "ws-test",
      sessionId: run.execution!.executionSessionId!,
      relation: {
        kind: "task_execution" as const,
        ownerSessionId: "session-owner",
        projectRef: run.projectRef,
        taskRef: run.taskRef,
        runRef: run.ref,
        sessionGoalId: run.execution!.sessionGoalId,
        roleRef: "role:executor",
        jobId: run.execution!.jobId,
        attempt: 1,
      },
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
});

function taskRun(input: { status?: TaskRun["status"] } = {}): TaskRun {
  return {
    ref: "run:test",
    projectRef: "proj:test",
    taskRef: "task:test",
    status: input.status ?? "running",
    outputEvidenceRefs: [],
    execution: {
      ownerSessionId: "session-owner",
      executionSessionId: "session-task",
      sessionGoalId: "goal-task",
      jobId: "job-task",
      attempt: 1,
    },
  };
}

function graph(run: TaskRun) {
  return {
    runs: () => [run],
  };
}
