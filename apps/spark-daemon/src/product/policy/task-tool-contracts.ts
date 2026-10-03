import type {
  Task,
  TaskCompletionIssue,
  TaskCompletionReadiness,
  TaskPlanItem,
  TaskStatus,
} from "@zendev-lab/spark-tasks";
import { isUnfinishedTaskStatus, type TaskPlanInput } from "@zendev-lab/spark-tasks";

export function terminalTaskPlanInputs(tasks: readonly TaskPlanInput[]): TaskPlanInput[] {
  return tasks.filter((task) => task.status === "done" || task.status === "failed");
}

export function firstBlockingCompletionIssue(
  readiness: TaskCompletionReadiness,
): TaskCompletionIssue | undefined {
  return readiness.issues.find((issue) => issue.severity === "blocking");
}

export function finishProjectionIssue(input: {
  requestedStatus: "done" | "failed" | "cancelled";
  daemonChanged: boolean;
  task: Pick<Task, "status" | "claim">;
}): string | undefined {
  if (!input.daemonChanged && input.task.status !== input.requestedStatus) {
    return `daemon reported no change and task remains ${input.task.status}`;
  }
  if (input.task.status !== input.requestedStatus) {
    return `expected status=${input.requestedStatus}, got status=${input.task.status}`;
  }
  if (input.task.claim) return "terminal task still has an active claim";
  return undefined;
}

export function releaseProjectionIssue(input: {
  statusBefore: TaskStatus;
  task: Pick<Task, "status" | "claim"> | undefined;
}): string | undefined {
  if (!input.task) return "task disappeared after daemon release";
  if (input.task.claim) return "released task still has an active claim";
  if (!isUnfinishedTaskStatus(input.task.status)) {
    return `release produced terminal status=${input.task.status}`;
  }
  const expectedStatus = input.statusBefore === "running" ? "pending" : input.statusBefore;
  if (input.task.status !== expectedStatus) {
    return `expected status=${expectedStatus}, got status=${input.task.status}`;
  }
  return undefined;
}

export function preserveTaskPlanItemMetadata(
  before: readonly TaskPlanItem[],
  after: readonly TaskPlanItem[],
): TaskPlanItem[] {
  const previousById = new Map(before.map((item) => [item.id, item]));
  return after.map((item) => {
    const previous = previousById.get(item.id);
    if (!previous) return item;
    return {
      ...item,
      ...(previous.description !== undefined ? { description: previous.description } : {}),
      ...(previous.evidenceRefs !== undefined ? { evidenceRefs: [...previous.evidenceRefs] } : {}),
    };
  });
}
