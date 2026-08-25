import type { RunRef, TaskRef, ProjectRef } from "@zendev-lab/spark-core";
import type { WorkflowRunRecord } from "@zendev-lab/spark-workflows";
import {
  readRoleRunEvidencePreview,
  type ActiveSparkRoleRunProcess,
} from "@zendev-lab/spark-task-runtime";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkBackgroundChildRunView } from "./background-run-contracts.ts";

type SparkBackgroundChildStatus = SparkBackgroundChildRunView["status"];

export function resolveBackgroundTaskRef(
  graph: TaskGraph,
  selector: string | undefined,
  projectRef: ProjectRef | undefined,
): TaskRef | undefined {
  if (!selector) return undefined;
  const normalized = selector.trim().replace(/^@/, "");
  const tasks = graph.tasks(projectRef);
  return tasks.find(
    (task) =>
      task.ref === selector ||
      task.ref === normalized ||
      task.name === normalized ||
      task.title === selector ||
      task.title === normalized,
  )?.ref;
}

export function collectBackgroundChildRuns(input: {
  graph: TaskGraph;
  workflowRuns: WorkflowRunRecord[];
  activeProcesses: ActiveSparkRoleRunProcess[];
  projectRef?: ProjectRef;
  targetRunRef?: RunRef;
  targetTaskRef?: TaskRef;
}): SparkBackgroundChildRunView[] {
  const allTasks = input.graph.tasks();
  const taskByRef = new Map(allTasks.map((task) => [task.ref, task]));
  const allTaskRuns = input.graph.runs();
  const taskRunByRef = new Map(allTaskRuns.map((run) => [run.ref, run]));
  const workflowRunRefByChild = new Map<RunRef, RunRef>();
  const childRunRefs = new Set<RunRef>();
  for (const workflowRun of input.workflowRuns) {
    for (const childRunRef of workflowRun.taskRunRefs) {
      if (
        input.targetRunRef &&
        input.targetRunRef !== workflowRun.ref &&
        input.targetRunRef !== childRunRef
      )
        continue;
      workflowRunRefByChild.set(childRunRef, workflowRun.ref);
      childRunRefs.add(childRunRef);
    }
  }
  const targetRunRefIsWorkflowRun = Boolean(
    input.targetRunRef && input.workflowRuns.some((run) => run.ref === input.targetRunRef),
  );
  for (const process of input.activeProcesses) {
    if (input.targetRunRef && !targetRunRefIsWorkflowRun && process.runRef !== input.targetRunRef)
      continue;
    childRunRefs.add(process.runRef);
  }
  if (input.targetRunRef && !targetRunRefIsWorkflowRun) childRunRefs.add(input.targetRunRef);
  for (const task of allTasks) {
    if (input.projectRef && task.projectRef !== input.projectRef) continue;
    if (input.targetTaskRef && task.ref !== input.targetTaskRef) continue;
    if (task.claim?.runRef) childRunRefs.add(task.claim.runRef);
  }
  for (const run of allTaskRuns) {
    if (input.projectRef && run.projectRef !== input.projectRef) continue;
    if (input.targetTaskRef && run.taskRef !== input.targetTaskRef) continue;
    if (input.targetRunRef && run.ref !== input.targetRunRef) continue;
    if (input.targetTaskRef || input.targetRunRef) childRunRefs.add(run.ref);
  }
  const activeByRunRef = new Map(input.activeProcesses.map((process) => [process.runRef, process]));
  const views = [...childRunRefs].flatMap((runRef): SparkBackgroundChildRunView[] => {
    if (input.targetRunRef && !targetRunRefIsWorkflowRun && runRef !== input.targetRunRef)
      return [];
    const taskRun = taskRunByRef.get(runRef);
    const activeProcess = activeByRunRef.get(runRef);
    const task = taskRun
      ? taskByRef.get(taskRun.taskRef)
      : allTasks.find((candidate) => candidate.claim?.runRef === runRef);
    if (input.projectRef && task && task.projectRef !== input.projectRef) return [];
    if (input.projectRef && taskRun && taskRun.projectRef !== input.projectRef) return [];
    if (input.targetTaskRef && task?.ref !== input.targetTaskRef) return [];
    const status: SparkBackgroundChildStatus = activeProcess
      ? "active"
      : taskRun?.status === "stale"
        ? "unknown"
        : (taskRun?.status ?? (task?.status === "running" ? "running" : "unknown"));
    const view: SparkBackgroundChildRunView = {
      runRef,
      workflowRunRef: workflowRunRefByChild.get(runRef),
      taskRef: task?.ref ?? taskRun?.taskRef,
      taskName: task?.name,
      taskTitle: task?.title,
      taskStatus: task?.status,
      roleRef: activeProcess?.roleRef ?? taskRun?.roleRef ?? task?.claim?.roleRef,
      runName: activeProcess?.runName ?? taskRun?.runName ?? task?.claim?.runName,
      ownerSessionId: taskRun?.ownerSessionId ?? task?.claim?.sessionId,
      claimKind: task?.claim?.runRef === runRef ? task.claim.kind : undefined,
      pid: activeProcess?.pid,
      cwd: activeProcess?.cwd,
      startedAt: activeProcess?.startedAt ?? taskRun?.startedAt,
      finishedAt: taskRun?.finishedAt,
      timedOutAt: activeProcess?.timedOutAt,
      inputControl: activeProcess?.inputControl,
      activeProcess: Boolean(activeProcess),
      status,
      summary: taskRun?.completionSummary?.summary,
      errorMessage: taskRun?.errorMessage,
      outcome: taskRun?.outcome ? { ...taskRun.outcome } : undefined,
      evidenceRefs: [
        ...(taskRun?.completionSummary?.evidenceRefs ?? []),
        ...(taskRun?.outputEvidenceRefs ?? []).filter(
          (evidenceRef) => !(taskRun?.completionSummary?.evidenceRefs ?? []).includes(evidenceRef),
        ),
      ],
    };
    view.nextAction = backgroundChildNextAction(view);
    return [view];
  });
  return views.sort((a, b) => {
    const byStatus = taskRunStatusRank(a.status) - taskRunStatusRank(b.status);
    if (byStatus !== 0) return byStatus;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

export async function enrichBackgroundChildRunsWithRoleRunEvidence(input: {
  cwd: string;
  childRuns: SparkBackgroundChildRunView[];
}): Promise<SparkBackgroundChildRunView[]> {
  return Promise.all(
    input.childRuns.map(async (child) => {
      if (child.evidenceRefs.length === 0) return child;
      const roleRunEvidence = await Promise.all(
        child.evidenceRefs.map((evidenceRef) => readRoleRunEvidencePreview(input.cwd, evidenceRef)),
      );
      const compact = roleRunEvidence.find(
        (evidence) => evidence.summary || evidence.transcriptRef,
      );
      return {
        ...child,
        summary: child.summary ?? compact?.summary,
        transcriptRef: compact?.transcriptRef,
        stdoutTail: compact?.stdout,
        stderrTail: compact?.stderr,
        jsonEventsTail: compact?.jsonEvents,
        roleRunEvidence,
      };
    }),
  );
}

function backgroundChildNextAction(child: SparkBackgroundChildRunView): string | undefined {
  if (child.activeProcess && child.inputControl && child.inputControl !== "none")
    return `wait for completion, reply/steer with a selected target, or kill ${child.runRef} if this child is non-responsive`;
  if (child.activeProcess)
    return `wait for completion, or kill ${child.runRef} if this child is non-responsive`;
  if (child.status === "blocked") {
    const detail = child.outcome?.nextAction ?? child.outcome?.reason;
    return detail
      ? `resolve blocker: ${detail}`
      : "inspect the blocked run, resolve its blocker, then rerun";
  }
  if (child.status === "failed")
    return "inspect failed task/run evidence, fix the cause, then rerun";
  if (child.status === "queued" || child.status === "running")
    return "reconcile; no active process is currently tracked for this child";
  return undefined;
}

function taskRunStatusRank(status: SparkBackgroundChildStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "blocked":
      return 3;
    case "failed":
      return 4;
    case "cancelled":
      return 5;
    case "succeeded":
      return 6;
    case "unknown":
      return 7;
  }
}
