import type { TaskRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkReproOrchestrationInput, SparkSessionRepro } from "./spark-session-repro.ts";

export interface SparkReproOrchestrationSnapshot extends SparkReproOrchestrationInput {
  safeTaskRefs: TaskRef[];
  dispatchableTaskRefs: TaskRef[];
  activeTaskRefs: TaskRef[];
  excludedAskTaskRefs: TaskRef[];
}

const OWNER_ASK_WAITING_TASK_STATUSES = new Set(["pending", "ready", "running", "blocked"]);

function subgoalAwaitsOwnerAsk(
  subgoal: SparkSessionRepro["subgoals"][number],
  taskStatusByRef: Readonly<Record<string, string | undefined>>,
): boolean {
  if (subgoal.status === "done" || subgoal.status === "cancelled") return false;
  // Unbound ask authority fails closed. Bound missing or terminal tasks need owner reconciliation, not dormancy.
  if (!subgoal.taskRef) return true;
  return OWNER_ASK_WAITING_TASK_STATUSES.has(taskStatusByRef[subgoal.taskRef] ?? "");
}

export function collectReproOrchestrationSnapshot(
  repro: SparkSessionRepro,
  graph: TaskGraph | undefined,
): SparkReproOrchestrationSnapshot {
  if (!repro.projectRef || !graph) return conservativeReproOrchestrationSnapshot();
  const askTaskRefs = new Set(
    repro.subgoals
      .filter(
        (subgoal) => subgoal.authority === "ask_decision" || subgoal.authority === "ask_approval",
      )
      .map((subgoal) => subgoal.taskRef)
      .filter((ref): ref is TaskRef => !!ref),
  );
  const safeTaskRefs = [
    ...new Set(
      repro.subgoals
        .filter((subgoal) => subgoal.authority === "safe_local")
        .map((subgoal) => subgoal.taskRef)
        .filter((ref): ref is TaskRef => !!ref)
        .filter((taskRef) => !askTaskRefs.has(taskRef)),
    ),
  ].sort();
  const safeTaskRefSet = new Set(safeTaskRefs);
  const tasks = graph.tasks(repro.projectRef);
  const taskStatusByRef = Object.fromEntries(tasks.map((task) => [task.ref, task.status]));
  const dispatchableTaskRefs = graph
    .readyTasks(repro.projectRef)
    .map((task) => task.ref)
    .filter((taskRef) => safeTaskRefSet.has(taskRef))
    .sort();
  const activeRunTaskRefs = new Set(
    graph
      .runs(repro.projectRef)
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => run.taskRef),
  );
  const activeTaskRefs = safeTaskRefs.filter((taskRef) => activeRunTaskRefs.has(taskRef));
  const awaitingAsk =
    repro.subgoals.some(
      (subgoal) =>
        (subgoal.authority === "ask_decision" || subgoal.authority === "ask_approval") &&
        subgoalAwaitsOwnerAsk(subgoal, taskStatusByRef),
    ) &&
    dispatchableTaskRefs.length === 0 &&
    activeTaskRefs.length === 0;
  return {
    taskStatusByRef,
    activeChildRunCount: activeTaskRefs.length,
    dispatchableFrontierCount: dispatchableTaskRefs.length,
    awaitingAsk,
    safeTaskRefs,
    dispatchableTaskRefs,
    activeTaskRefs,
    excludedAskTaskRefs: [...askTaskRefs].sort(),
  };
}

export function conservativeReproOrchestrationSnapshot(): SparkReproOrchestrationSnapshot {
  return {
    taskStatusByRef: {},
    activeChildRunCount: 0,
    dispatchableFrontierCount: 0,
    awaitingAsk: false,
    safeTaskRefs: [],
    dispatchableTaskRefs: [],
    activeTaskRefs: [],
    excludedAskTaskRefs: [],
  };
}
