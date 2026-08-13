import type { SparkSessionOwner } from "@zendev-lab/spark-protocol/session-assignment";
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
  const owner = subject.owner;
  const cwd = options.resolveWorkspaceCwd(subject.workspaceId)?.trim();
  if (!cwd) return false;
  const graph = await (options.loadGraph ?? loadTaskGraph)(cwd);
  if (!graph) return false;
  const run = graph
    .runs(owner.projectRef)
    .find((candidate) =>
      owner.kind === "task_run"
        ? candidate.ref === owner.runRef
        : candidate.ref === owner.originatingRunRef && candidate.execution?.jobId === owner.jobId,
    );
  if (!run || run.taskRef !== owner.taskRef) return false;
  const executionSessionId = run.execution?.sessionId ?? run.execution?.executionSessionId;
  if (executionSessionId !== subject.sessionId) return false;
  if (owner.kind === "task_run") {
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
