import type {
  SparkSessionOwner,
  SparkTaskExecutionSessionRelation,
} from "@zendev-lab/spark-protocol/session-assignment";
import type { TaskRun } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";

interface TaskOwnerGraph {
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
  if (subject.owner.kind !== "task_run" || subject.owner.ref !== subject.relation.runRef)
    return false;
  const cwd = options.resolveWorkspaceCwd(subject.workspaceId)?.trim();
  if (!cwd) return false;
  const graph = await (options.loadGraph ?? loadTaskGraph)(cwd);
  if (!graph) return false;
  const run = graph
    .runs(subject.relation.projectRef)
    .find((candidate) => candidate.ref === subject.owner.ref);
  if (!run || run.taskRef !== subject.relation.taskRef) return false;
  if (run.execution?.executionSessionId !== subject.sessionId) return false;
  return run.status === "queued" || run.status === "running";
}

async function loadTaskGraph(cwd: string): Promise<TaskOwnerGraph | undefined> {
  return (await defaultTaskGraphStore(cwd).load()) ?? undefined;
}
