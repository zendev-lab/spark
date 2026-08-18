import { describe, expect, it } from "vitest";
import type { TaskRun } from "@zendev-lab/spark-core";
import { normalizeTaskExecutionPolicy, normalizeTaskRun } from "./internal.ts";

describe("Task Session lifetime compatibility", () => {
  it("maps legacy continuity into the canonical Session lifetime", () => {
    expect(normalizeTaskExecutionPolicy({ continuity: "fresh" })).toMatchObject({
      sessionLifetime: "task_run",
      continuity: "fresh",
    });
    expect(normalizeTaskExecutionPolicy({ sessionLifetime: "task_revision" })).toMatchObject({
      sessionLifetime: "task_revision",
      continuity: "reuse_within_revision",
    });
  });

  it("retains a reusable Session until its owner closes when explicitly requested", () => {
    expect(normalizeTaskExecutionPolicy({ sessionRetention: "owner_terminal" })).toMatchObject({
      sessionLifetime: "task_revision",
      sessionRetention: "owner_terminal",
    });
    expect(() =>
      normalizeTaskExecutionPolicy({
        sessionRetention: "unsupported" as "task_terminal",
      }),
    ).toThrow(/sessionRetention is invalid/u);
  });

  it("rejects conflicting canonical and legacy lifetime selectors", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        sessionLifetime: "task_run",
        continuity: "reuse_within_revision",
      }),
    ).toThrow(/sessionLifetime conflicts with legacy continuity/u);
  });

  it("upgrades legacy executionSessionId on TaskRun decode", () => {
    const run = normalizeTaskRun({
      ref: "run:legacy-task-run",
      projectRef: "proj:test",
      taskRef: "task:test",
      status: "running",
      execution: {
        ownerSessionId: "sess_owner",
        executionSessionId: "sess_task_legacy",
        sessionGoalId: "goal_legacy",
        jobId: "job_legacy",
        attempt: 1,
      },
      outputEvidenceRefs: [],
    } as TaskRun);

    expect(run.execution).toMatchObject({
      sessionId: "sess_task_legacy",
      executionSessionId: "sess_task_legacy",
      sessionLifetime: "task_revision",
    });
  });
});
