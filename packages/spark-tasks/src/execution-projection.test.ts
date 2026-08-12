import { describe, expect, it } from "vitest";
import { applyExecutionProjection } from "./graph.ts";
import type {
  ExecutionAttemptAggregate,
  ExecutionRunAggregate,
  TaskRun,
} from "@zendev-lab/spark-core";

const baseRun: TaskRun = {
  ref: "run:projection",
  projectRef: "proj:projection",
  taskRef: "task:projection",
  status: "running",
  failureKind: "runtime_error",
  errorMessage: "old interruption",
  finishedAt: "2026-08-12T00:00:00.000Z",
  outputEvidenceRefs: [],
  execution: {
    ownerSessionId: "sess:projection",
    sessionGoalId: "goal:projection",
    jobId: "job:projection",
    attempt: 1,
  },
};

const aggregate: ExecutionRunAggregate = {
  runRef: baseRun.ref,
  projectRef: baseRun.projectRef,
  taskRef: baseRun.taskRef,
  workspaceId: "ws:projection",
  status: "paused",
  stateRevision: 4,
  pauseReason: "daemon_restart",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:01.000Z",
};

const attempt: ExecutionAttemptAggregate = {
  attemptId: "attempt:projection",
  runRef: baseRun.ref,
  attempt: 2,
  parentAttemptId: "attempt:old",
  status: "paused",
  daemonGeneration: 2,
  stateRevision: 4,
  leaseToken: "lease:projection",
  checkpointRevision: 3,
};

describe("TaskGraph execution projection", () => {
  it("projects pause without terminal metadata or transition commands", () => {
    const projected = applyExecutionProjection(baseRun, aggregate, attempt);
    expect(projected).toMatchObject({
      ref: baseRun.ref,
      taskRef: baseRun.taskRef,
      status: "paused",
      execution: { attempt: 2 },
    });
    expect(projected.failureKind).toBeUndefined();
    expect(projected.errorMessage).toBeUndefined();
    expect(projected.finishedAt).toBeUndefined();
    expect(projected).not.toHaveProperty("transition");
    expect(projected).not.toHaveProperty("command");
  });

  it("projects recovery_required as blocked without inventing a terminal failure", () => {
    const projected = applyExecutionProjection(
      baseRun,
      { ...aggregate, status: "recovery_required", recoveryReason: "side_effect_uncertain" },
      attempt,
    );
    expect(projected.status).toBe("blocked");
    expect(projected.failureKind).toBeUndefined();
    expect(projected.finishedAt).toBeUndefined();
  });
});
