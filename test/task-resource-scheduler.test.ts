import { describe, expect, it } from "vitest";

import {
  newRef,
  type TaskExecutionPolicy,
  type TaskResourceInventory,
  type TaskRun,
} from "@zendev-lab/spark-core";
import { packTaskResourceFrontier, parseTaskResourceInventory } from "@zendev-lab/spark-workflows";
import { TaskGraph } from "@zendev-lab/spark-tasks";

const inventory: TaskResourceInventory = {
  nodeId: "node-8",
  gpus: Array.from({ length: 8 }, (_, index) => ({
    id: String(index),
    memoryGiB: 80,
    topologyClasses: ["gpu-pair", "gpu-island-4"],
  })),
};

describe("Task resource scheduler", () => {
  it.each([
    { title: "eight single-side jobs", count: 8, gpuCount: 1, comparison: "single_side" as const },
    { title: "four paired single-GPU lanes", count: 4, gpuCount: 1, comparison: "paired" as const },
    { title: "two paired TP2 lanes", count: 2, gpuCount: 2, comparison: "paired" as const },
    { title: "one paired four-GPU lane", count: 1, gpuCount: 4, comparison: "paired" as const },
  ])("packs $title on eight GPUs", ({ count, gpuCount, comparison }) => {
    const fixture = tasksWithPolicy(
      count + 2,
      policy({ gpuCount, comparison, topologyClass: gpuCount === 2 ? "gpu-pair" : undefined }),
    );
    const packed = packTaskResourceFrontier({
      tasks: fixture.tasks,
      runs: [],
      inventory,
      maxConcurrency: 8,
      now: "2026-07-29T00:00:00.000Z",
    });

    expect(packed.scheduled).toHaveLength(count);
    expect(new Set(packed.scheduled.flatMap((item) => item.allocation.gpuIds)).size).toBe(
      count * gpuCount * (comparison === "paired" ? 2 : 1),
    );
    for (const item of packed.scheduled) {
      expect(item.allocation.groups).toHaveLength(comparison === "paired" ? 2 : 1);
    }
  });

  it("reconstructs active leases and defers concurrency-key and exclusive-node conflicts", () => {
    const fixture = tasksWithPolicy(3, policy({ gpuCount: 1, concurrencyKeys: ["results:s0"] }));
    const active = activeRun(fixture.tasks[0]!, ["0"], ["results:s0"]);
    const packed = packTaskResourceFrontier({
      tasks: fixture.tasks.slice(1),
      runs: [active],
      inventory,
      maxConcurrency: 8,
    });
    expect(packed.scheduled).toHaveLength(0);
    expect(packed.deferred.map((item) => item.reason)).toEqual([
      "concurrency_key",
      "concurrency_key",
    ]);
    expect(packed.activeLeaseIds).toEqual(["resource:active"]);

    const exclusiveFixture = tasksWithPolicy(1, policy({ gpuCount: 8, exclusiveNode: true }));
    const exclusive = packTaskResourceFrontier({
      tasks: exclusiveFixture.tasks,
      runs: [active],
      inventory,
      maxConcurrency: 2,
    });
    expect(exclusive.deferred[0]?.reason).toBe("exclusive_node");
  });

  it("counts reconstructed active leases against maxConcurrency", () => {
    const fixture = tasksWithPolicy(2, policy({ gpuCount: 1 }));
    const packed = packTaskResourceFrontier({
      tasks: [fixture.tasks[1]!],
      runs: [activeRun(fixture.tasks[0]!, ["0"], [])],
      inventory,
      maxConcurrency: 1,
    });
    expect(packed.scheduled).toHaveLength(0);
    expect(packed.deferred).toEqual([
      expect.objectContaining({ taskRef: fixture.tasks[1]!.ref, reason: "concurrency_limit" }),
    ]);
  });

  it("fails closed on memory, topology, and attempt limits", () => {
    const fixture = tasksWithPolicy(
      3,
      policy({ gpuCount: 1, minGpuMemoryGiB: 120, topologyClass: "nvlink-8", maxAttempts: 1 }),
    );
    const attempt = activeRun(fixture.tasks[0]!, [], []);
    attempt.status = "failed";
    const packed = packTaskResourceFrontier({
      tasks: fixture.tasks,
      runs: [attempt],
      inventory,
      maxConcurrency: 3,
    });
    expect(packed.deferred).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskRef: fixture.tasks[0]!.ref, reason: "attempt_limit" }),
        expect.objectContaining({ taskRef: fixture.tasks[1]!.ref, reason: "topology_unavailable" }),
      ]),
    );
  });

  it("does not consume maxAttempts for preview-only dry runs", () => {
    const fixture = tasksWithPolicy(1, policy({ gpuCount: 1, maxAttempts: 1 }));
    const preview = activeRun(fixture.tasks[0]!, [], []);
    preview.status = "succeeded";
    preview.dryRun = true;
    const packed = packTaskResourceFrontier({
      tasks: fixture.tasks,
      runs: [preview],
      inventory,
      maxConcurrency: 1,
    });
    expect(packed.scheduled).toHaveLength(1);
    expect(packed.deferred).toHaveLength(0);
  });

  it("parses an explicit topology inventory and rejects duplicate GPU ids", () => {
    expect(
      parseTaskResourceInventory({
        nodeId: "node-a",
        gpus: [{ id: "0", memoryGiB: 80, topologyClasses: ["pair", "pair"] }],
      }),
    ).toEqual({
      nodeId: "node-a",
      gpus: [{ id: "0", memoryGiB: 80, topologyClasses: ["pair"] }],
    });
    expect(() =>
      parseTaskResourceInventory({
        nodeId: "node-a",
        gpus: [
          { id: "0", topologyClasses: [] },
          { id: "0", topologyClasses: [] },
        ],
      }),
    ).toThrow(/duplicate GPU id/u);
  });
});

function tasksWithPolicy(count: number, executionPolicy: TaskExecutionPolicy) {
  const graph = new TaskGraph();
  const project = graph.createProject({ title: "Resources", description: "Resources" });
  const tasks = Array.from({ length: count }, (_, index) =>
    graph.createTask({
      projectRef: project.ref,
      title: `Task ${index}`,
      description: `Execute task ${index}`,
      executionPolicy: {
        ...executionPolicy,
        concurrencyKeys: executionPolicy.concurrencyKeys.map((key) =>
          key === "per-task" ? `${key}:${index}` : key,
        ),
      },
    }),
  );
  return { graph, project, tasks };
}

function policy(input: {
  gpuCount: number;
  comparison?: TaskExecutionPolicy["comparison"];
  minGpuMemoryGiB?: number;
  topologyClass?: string;
  exclusiveNode?: boolean;
  concurrencyKeys?: string[];
  maxAttempts?: number;
}): TaskExecutionPolicy {
  return {
    sessionLifetime: "task_revision",
    continuity: "reuse_within_revision",
    isolation: "isolated_results",
    comparison: input.comparison ?? "single_side",
    resources: {
      gpuCount: input.gpuCount,
      ...(input.minGpuMemoryGiB ? { minGpuMemoryGiB: input.minGpuMemoryGiB } : {}),
      ...(input.topologyClass ? { topologyClass: input.topologyClass } : {}),
      ...(input.exclusiveNode ? { exclusiveNode: true } : {}),
    },
    concurrencyKeys: input.concurrencyKeys ?? ["per-task"],
    maxAttempts: input.maxAttempts ?? 2,
  };
}

function activeRun(
  task: ReturnType<TaskGraph["tasks"]>[number],
  gpuIds: string[],
  concurrencyKeys: string[],
): TaskRun {
  return {
    ref: newRef("run"),
    projectRef: task.projectRef,
    taskRef: task.ref,
    status: "running",
    outputEvidenceRefs: [],
    resourceAllocation: {
      leaseId: "resource:active",
      nodeId: "node-8",
      groups: gpuIds.length > 0 ? [{ side: "single_side", gpuIds }] : [],
      gpuIds,
      concurrencyKeys,
      exclusiveNode: false,
      allocatedAt: "2026-07-29T00:00:00.000Z",
    },
  };
}
