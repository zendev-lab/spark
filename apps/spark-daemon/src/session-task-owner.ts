import type { SparkSessionLineageOrigin } from "@zendev-lab/spark-protocol/session-assignment";
import type { TaskRun } from "@zendev-lab/spark-core";
import { defaultTaskGraphStore, isUnfinishedTaskStatus } from "@zendev-lab/spark-tasks";

interface TaskOwnerGraph {
  getTask(ref: string): {
    status: Parameters<typeof isUnfinishedTaskStatus>[0];
    executionPolicy?: { sessionRetention?: "task_terminal" | "owner_terminal" };
  };
  runs(projectRef?: string): TaskRun[];
}

export interface TaskSessionOwnerSubject {
  origin: SparkSessionLineageOrigin;
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
  if (subject.origin.kind !== "task_run" && subject.origin.kind !== "task_revision") return false;
  const origin = subject.origin;
  const cwd = options.resolveWorkspaceCwd(subject.workspaceId)?.trim();
  if (!cwd) return false;
  const graph = await (options.loadGraph ?? loadTaskGraph)(cwd);
  if (!graph) return false;
  const run = graph
    .runs(origin.projectRef)
    .find((candidate) =>
      origin.kind === "task_run"
        ? candidate.ref === origin.runRef
        : candidate.ref === origin.originatingRunRef && candidate.execution?.jobId === origin.jobId,
    );
  if (!run || run.taskRef !== origin.taskRef) return false;
  const executionSessionId = run.execution?.sessionId ?? run.execution?.executionSessionId;
  if (executionSessionId !== subject.sessionId) return false;
  if (origin.kind === "task_run") {
    return run.status === "queued" || run.status === "running";
  }
  try {
    const task = graph.getTask(run.taskRef);
    return (
      run.execution?.sessionLifetime === "task_revision" &&
      (task.executionPolicy?.sessionRetention === "owner_terminal" ||
        isUnfinishedTaskStatus(task.status))
    );
  } catch {
    return false;
  }
}

async function loadTaskGraph(cwd: string): Promise<TaskOwnerGraph | undefined> {
  return (await defaultTaskGraphStore(cwd).load()) ?? undefined;
}
