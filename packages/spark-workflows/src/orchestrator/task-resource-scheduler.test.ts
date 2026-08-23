import { describe, expect, it } from "vitest";
import type { ProjectRef, RunRef, TaskRef } from "@zendev-lab/spark-invocation";
import { type Task, type TaskRun, type TaskRunStatus } from "@zendev-lab/spark-tasks";
import { packTaskResourceFrontier, taskAttemptLimitDeferrals } from "./task-resource-scheduler.ts";

function task(ref: string, maxAttempts = 2): Task {
  return {
    ref: ref as TaskRef,
    projectRef: "proj:scheduler" as ProjectRef,
    name: ref.replace("task:", ""),
    title: ref,
    description: "scheduler fixture",
    kind: "implement",
    status: "ready",
    executionPolicy: {
      sessionLifetime: "task_revision",
      continuity: "reuse_within_revision",
      isolation: "isolated_worktree",
      comparison: "single_side",
      concurrencyKeys: [],
      resources: { gpuCount: 0 },
      maxAttempts,
    },
    supersededBy: [],
    artifactRefs: [],
    inputEvidenceRefs: [],
    outputEvidenceRefs: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function run(
  ref: string,
  taskRef: TaskRef,
  status: TaskRunStatus,
  options: { attemptConsumed?: boolean; allocation?: boolean } = {},
): TaskRun {
  return {
    ref: ref as RunRef,
    projectRef: "proj:scheduler" as ProjectRef,
    taskRef,
    status,
    startedAt: "2026-08-09T00:00:00.000Z",
    ...(options.attemptConsumed !== undefined ? { attemptConsumed: options.attemptConsumed } : {}),
    ...(options.allocation
      ? {
          resourceAllocation: {
            leaseId: `resource:${ref}`,
            nodeId: "node-1",
            groups: [],
            gpuIds: [],
            concurrencyKeys: [],
            exclusiveNode: false,
            allocatedAt: "2026-08-09T00:00:00.000Z",
          },
        }
      : {}),
    outputEvidenceRefs: [],
  };
}

const inventory = { nodeId: "node-1", gpus: [] };

describe("task resource frontier attempt semantics", () => {
  it("does not count recovered/stale attempts towards maxAttempts", () => {
    const target = task("task:recovered", 2);
    const consuming = run("run:first", target.ref, "failed", { attemptConsumed: true });
    const recovered = run("run:second", target.ref, "failed", { attemptConsumed: false });

    const deferrals = taskAttemptLimitDeferrals([target], [consuming, recovered]);
    expect(deferrals).toHaveLength(0);

    const packed = packTaskResourceFrontier({
      tasks: [target],
      runs: [consuming, recovered],
      inventory,
      maxConcurrency: 1,
    });
    expect(packed.deferred.map((entry) => entry.reason)).not.toContain("attempt_limit");
    expect(packed.scheduled.map((entry) => entry.taskRef)).toEqual([target.ref]);
  });

  it("defers only consuming attempts past maxAttempts", () => {
    const target = task("task:exhausted", 2);
    const runs = [
      run("run:one", target.ref, "failed", { attemptConsumed: undefined }),
      run("run:two", target.ref, "failed", { attemptConsumed: undefined }),
    ];
    expect(taskAttemptLimitDeferrals([target], runs)).toMatchObject([
      { reason: "attempt_limit", taskRef: target.ref },
    ]);
    const packed = packTaskResourceFrontier({
      tasks: [target],
      runs,
      inventory,
      maxConcurrency: 1,
    });
    expect(packed.deferred.map((entry) => entry.reason)).toContain("attempt_limit");
    expect(packed.scheduled).toHaveLength(0);
  });

  it("stale TaskRuns no longer occupy frontier capacity", () => {
    const staleOwner = task("task:zombie");
    const fresh = task("task:fresh");
    const staleRun = run("run:zombie", staleOwner.ref, "stale", {
      attemptConsumed: false,
      allocation: true,
    });

    const packed = packTaskResourceFrontier({
      tasks: [fresh],
      runs: [staleRun],
      inventory,
      maxConcurrency: 2,
    });
    // A stale run with an allocation must not count as an active lease.
    expect(packed.activeLeaseIds).toEqual([]);
    expect(packed.scheduled.map((entry) => entry.taskRef)).toEqual([fresh.ref]);
  });
});
