import type {
  SparkSessionOwner,
  SparkTaskExecutionSessionRelation,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { TaskRun } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, isUnfinishedTaskStatus } from "@zendev-lab/spark-tasks";

interface TaskOwnerGraph {
  getTask(ref: string): { status: Parameters<typeof isUnfinishedTaskStatus>[0] };
  runs(projectRef?: string): TaskRun[];
}

export interface TaskSessionOwnerSubject {
  owner: SparkSessionOwner;
  workspaceId: string;
  sessionId: string;
  relation: SparkTaskExecutionSessionRelation;
}

export interface TaskSessionOwnerValidationOptions {
  resolveWorkspaceCwd: (workspaceId: string) => string | undefined;
  loadGraph?: (cwd: string) => Promise<TaskOwnerGraph | undefined>;
}

/** Validate Task-owned Sessions against the canonical workspace TaskGraph. */
export async function isTaskSessionOwnerValid(
  subject: TaskSessionOwnerSubject,
  options: TaskSessionOwnerValidationOptions,
): Promise<boolean> {
  if (subject.owner.kind !== "task_run" && subject.owner.kind !== "task_revision") return false;
  if (
    (subject.owner.kind === "task_run" && subject.owner.ref !== subject.relation.runRef) ||
    (subject.owner.kind === "task_revision" && subject.owner.ref !== subject.relation.jobId)
  )
    return false;
  const cwd = options.resolveWorkspaceCwd(subject.workspaceId)?.trim();
  if (!cwd) return false;
  const graph = await (options.loadGraph ?? loadTaskGraph)(cwd);
  if (!graph) return false;
  const run = graph
    .runs(subject.relation.projectRef)
    .find((candidate) =>
      subject.owner.kind === "task_run"
        ? candidate.ref === subject.owner.ref
        : candidate.execution?.jobId === subject.owner.ref,
    );
  if (!run || run.taskRef !== subject.relation.taskRef) return false;
  const executionSessionId = run.execution?.sessionId ?? run.execution?.executionSessionId;
  if (executionSessionId !== subject.sessionId) return false;
  if (subject.owner.kind === "task_run") {
    return run.status === "queued" || run.status === "running";
  }
  try {
    return (
      run.execution?.sessionLifetime === "task_revision" &&
      isUnfinishedTaskStatus(graph.getTask(run.taskRef).status)
    );
  } catch {
    return false;
  }
}

async function loadTaskGraph(cwd: string): Promise<TaskOwnerGraph | undefined> {
  return (await defaultTaskGraphStore(cwd).load()) ?? undefined;
}
