import {
  DEFAULT_READY_TASK_MAX_CONCURRENCY,
  type ProjectRef,
  type TaskRef,
} from "@zendev-lab/spark-invocation";
import { type Task } from "@zendev-lab/spark-tasks";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  discoverTaskResourceInventory,
  packTaskResourceFrontier,
  type DeferredTaskResource,
} from "@zendev-lab/spark-workflows";
import { resolveFleetTaskTarget } from "./spark-fleet-target.ts";

export interface SparkFleetProjection {
  recommended: boolean;
  running: number;
  ready: number;
  attention: number;
  done: number;
  workers: number;
  scheduledTaskRefs: TaskRef[];
  deferred: DeferredTaskResource[];
}

/** Pure projection except for live Artifact/worktree and resource preflight reads. */
export async function projectSparkFleetState(input: {
  workspaceCwd: string;
  graph: TaskGraph;
  projectRef: ProjectRef;
  maxConcurrency?: number;
}): Promise<SparkFleetProjection> {
  const readyTasks = input.graph.readyTasks(input.projectRef);
  const prepared = await prepareFleetTargetLocks(input.workspaceCwd, readyTasks);
  const inventory = await discoverTaskResourceInventory();
  const packing = packTaskResourceFrontier({
    tasks: prepared.tasks,
    runs: input.graph.runs(),
    inventory,
    maxConcurrency: input.maxConcurrency ?? DEFAULT_READY_TASK_MAX_CONCURRENCY,
  });
  const projectTasks = input.graph.tasks(input.projectRef);
  const runs = input.graph.runs(input.projectRef);
  return {
    recommended: packing.scheduled.length >= 2,
    running: runs.filter((run) => run.status === "queued" || run.status === "running").length,
    ready: readyTasks.length,
    attention: projectTasks.filter((task) => task.status === "blocked" || task.status === "failed")
      .length,
    done: projectTasks.filter((task) => task.status === "done").length,
    workers: new Set(
      runs
        .map((run) => run.execution?.sessionId ?? run.execution?.executionSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ).size,
    scheduledTaskRefs: packing.scheduled.map((item) => item.taskRef),
    deferred: [...prepared.deferred, ...packing.deferred],
  };
}

export async function prepareFleetTargetLocks(
  workspaceCwd: string,
  tasks: readonly Task[],
): Promise<{
  tasks: Task[];
  deferred: DeferredTaskResource[];
}> {
  const accepted: Task[] = [];
  const deferred: DeferredTaskResource[] = [];
  for (const task of tasks) {
    try {
      const target = await resolveFleetTaskTarget({ workspaceCwd, task });
      if (!task.executionPolicy) throw new Error("Task has no normalized executionPolicy");
      accepted.push({
        ...task,
        executionPolicy: {
          ...task.executionPolicy,
          concurrencyKeys: [
            ...new Set([...task.executionPolicy.concurrencyKeys, ...target.concurrencyKeys]),
          ],
        },
      });
    } catch (error) {
      deferred.push({
        taskRef: task.ref,
        reason: "isolation_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { tasks: accepted, deferred };
}

export function renderSparkFleetProjection(projection: SparkFleetProjection): string {
  return [
    "## Fleet state",
    `- recommended: ${projection.recommended}`,
    `- running: ${projection.running}`,
    `- ready: ${projection.ready}`,
    `- attention: ${projection.attention}`,
    `- done: ${projection.done}`,
    `- workers: ${projection.workers}`,
    `- dispatchable now: ${projection.scheduledTaskRefs.length}`,
    `- deferred: ${projection.deferred.length}`,
  ].join("\n");
}
