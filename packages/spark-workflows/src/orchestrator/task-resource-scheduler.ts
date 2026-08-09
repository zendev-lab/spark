import {
  nowIso,
  stableId,
  type Task,
  type TaskExecutionPolicy,
  type TaskGpuResource,
  type TaskRef,
  type TaskResourceAllocation,
  type TaskResourceAllocationGroup,
  type TaskResourceInventory,
  type TaskRun,
} from "@zendev-lab/spark-core";

export type TaskResourceDeferralReason =
  | "attempt_limit"
  | "concurrency_limit"
  | "concurrency_key"
  | "exclusive_node"
  | "gpu_unavailable"
  | "topology_unavailable";

export interface PackedTaskResource {
  taskRef: TaskRef;
  allocation: TaskResourceAllocation;
}

export interface DeferredTaskResource {
  taskRef: TaskRef;
  reason: TaskResourceDeferralReason;
  message: string;
}

export interface TaskResourcePackingResult {
  scheduled: PackedTaskResource[];
  deferred: DeferredTaskResource[];
  activeLeaseIds: string[];
}

export function taskAttemptLimitDeferrals(
  tasks: readonly Task[],
  runs: readonly TaskRun[],
): DeferredTaskResource[] {
  return tasks.flatMap((task) => {
    const policy = effectiveTaskExecutionPolicy(task);
    const attempts = runs.filter((run) => run.taskRef === task.ref && !run.dryRun).length;
    return attempts >= policy.maxAttempts
      ? [
          {
            taskRef: task.ref,
            reason: "attempt_limit" as const,
            message: `Task reached maxAttempts=${policy.maxAttempts}.`,
          },
        ]
      : [];
  });
}

export function packTaskResourceFrontier(input: {
  tasks: readonly Task[];
  runs: readonly TaskRun[];
  inventory: TaskResourceInventory;
  maxConcurrency: number;
  now?: string;
}): TaskResourcePackingResult {
  const activeRuns = input.runs.filter(
    (run) =>
      (run.status === "queued" || run.status === "running") && Boolean(run.resourceAllocation),
  );
  const activeAllocations = activeRuns.flatMap((run) => run.resourceAllocation ?? []);
  const usedGpuIds = new Set(activeAllocations.flatMap((allocation) => allocation.gpuIds));
  const usedConcurrencyKeys = new Set(
    activeAllocations.flatMap((allocation) => allocation.concurrencyKeys),
  );
  let nodeExclusive = activeAllocations.some((allocation) => allocation.exclusiveNode);
  let allocationCount = activeAllocations.length;
  const scheduled: PackedTaskResource[] = [];
  const deferred: DeferredTaskResource[] = [];
  const maxConcurrency = Math.max(1, Math.floor(input.maxConcurrency));
  const availableConcurrency = Math.max(0, maxConcurrency - activeAllocations.length);
  const allocatedAt = input.now ?? nowIso();

  const attemptLimitByTask = new Map(
    taskAttemptLimitDeferrals(input.tasks, input.runs).map((deferred) => [
      deferred.taskRef,
      deferred,
    ]),
  );

  for (const task of input.tasks) {
    const attemptLimit = attemptLimitByTask.get(task.ref);
    if (attemptLimit) {
      deferred.push(attemptLimit);
      continue;
    }
    if (scheduled.length >= availableConcurrency) {
      deferred.push({
        taskRef: task.ref,
        reason: "concurrency_limit",
        message: `The scheduler maxConcurrency=${maxConcurrency} is fully leased.`,
      });
      continue;
    }
    const policy = effectiveTaskExecutionPolicy(task);
    const attempts = input.runs.filter((run) => run.taskRef === task.ref && !run.dryRun).length;

    const conflictingKey = policy.concurrencyKeys.find((key) => usedConcurrencyKeys.has(key));
    if (conflictingKey) {
      deferred.push({
        taskRef: task.ref,
        reason: "concurrency_key",
        message: `Concurrency key is already leased: ${conflictingKey}.`,
      });
      continue;
    }

    const exclusiveNode = policy.resources?.exclusiveNode ?? false;
    if (nodeExclusive || (exclusiveNode && allocationCount > 0)) {
      deferred.push({
        taskRef: task.ref,
        reason: "exclusive_node",
        message: nodeExclusive
          ? "The node is reserved by an exclusive task."
          : "Exclusive-node execution requires every other lease to finish.",
      });
      continue;
    }

    const perSideGpuCount = policy.resources?.gpuCount ?? 0;
    const groupCount = policy.comparison === "paired" ? 2 : perSideGpuCount > 0 ? 1 : 0;
    const totalGpuCount = perSideGpuCount * groupCount;
    const candidates = matchingAvailableGpus(
      input.inventory.gpus,
      usedGpuIds,
      policy.resources?.minGpuMemoryGiB,
      policy.resources?.topologyClass,
    );
    if (totalGpuCount > candidates.length) {
      const topologyClass = policy.resources?.topologyClass;
      deferred.push({
        taskRef: task.ref,
        reason: topologyClass ? "topology_unavailable" : "gpu_unavailable",
        message: topologyClass
          ? `Need ${totalGpuCount} available GPU(s) in topology class ${topologyClass}; found ${candidates.length}.`
          : `Need ${totalGpuCount} available GPU(s); found ${candidates.length}.`,
      });
      continue;
    }

    const selectedGpuIds = candidates.slice(0, totalGpuCount).map((gpu) => gpu.id);
    const allocation: TaskResourceAllocation = {
      leaseId: `resource:${stableId(
        `${task.ref}:${attempts + 1}:${input.inventory.nodeId}:${selectedGpuIds.join(",")}`,
      )}`,
      nodeId: input.inventory.nodeId,
      groups: allocationGroups(policy, selectedGpuIds, perSideGpuCount),
      gpuIds: selectedGpuIds,
      concurrencyKeys: [...policy.concurrencyKeys],
      ...(policy.resources?.topologyClass ? { topologyClass: policy.resources.topologyClass } : {}),
      exclusiveNode,
      allocatedAt,
    };
    for (const gpuId of selectedGpuIds) usedGpuIds.add(gpuId);
    for (const key of policy.concurrencyKeys) usedConcurrencyKeys.add(key);
    nodeExclusive ||= exclusiveNode;
    allocationCount += 1;
    scheduled.push({ taskRef: task.ref, allocation });
  }

  return {
    scheduled,
    deferred,
    activeLeaseIds: activeAllocations.map((allocation) => allocation.leaseId),
  };
}

function matchingAvailableGpus(
  gpus: readonly TaskGpuResource[],
  usedGpuIds: ReadonlySet<string>,
  minGpuMemoryGiB: number | undefined,
  topologyClass: string | undefined,
): TaskGpuResource[] {
  return gpus.filter(
    (gpu) =>
      !usedGpuIds.has(gpu.id) &&
      (minGpuMemoryGiB === undefined ||
        (gpu.memoryGiB !== undefined && gpu.memoryGiB >= minGpuMemoryGiB)) &&
      (!topologyClass || gpu.topologyClasses.includes(topologyClass)),
  );
}

function allocationGroups(
  policy: TaskExecutionPolicy,
  gpuIds: string[],
  perSideGpuCount: number,
): TaskResourceAllocationGroup[] {
  if (gpuIds.length === 0) return [];
  if (policy.comparison === "paired") {
    return [
      { side: "reference", gpuIds: gpuIds.slice(0, perSideGpuCount) },
      { side: "target", gpuIds: gpuIds.slice(perSideGpuCount, perSideGpuCount * 2) },
    ];
  }
  return [{ side: policy.comparison, gpuIds }];
}

function effectiveTaskExecutionPolicy(task: Task): TaskExecutionPolicy {
  return (
    task.executionPolicy ?? {
      sessionLifetime: "task_revision",
      continuity: "reuse_within_revision",
      isolation:
        task.kind === "implement"
          ? "isolated_worktree"
          : task.kind === "research" || task.kind === "review" || task.kind === "plan"
            ? "readonly"
            : "isolated_results",
      comparison: "single_side",
      concurrencyKeys: [],
      maxAttempts: 2,
    }
  );
}
