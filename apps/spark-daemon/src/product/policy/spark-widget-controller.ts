import {
  SparkWidgetController as SparkHostWidgetController,
  type SparkWidgetControllerContext,
  type SparkWidgetControllerDeps,
} from "../host/spark-widget-controller.ts";
import { projectSparkDynamicWorkflowRuns } from "./spark-dynamic-workflow-run-rendering.ts";
import { defaultSparkWorkflowRunStore } from "./spark-workflow-run-store.ts";
import { defaultSparkDynamicWorkflowEventStore } from "./spark-dynamic-workflow-event-store.ts";
import { defaultTaskGraphStore } from "@zendev-lab/spark-tasks";
import { ensureLocalSparkDirectory } from "./spark-activation.ts";
import { activeSparkRoleRunProcessesForCwd } from "./background-runs.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkSessionKey,
  sparkSessionOwnerKey,
} from "./session-state.ts";
import {
  assignTodoDisplayNumber,
  loadIndependentTodos,
  loadTodoDisplayNumberState,
  saveTodoDisplayNumberState,
  taskTodoDisplayKey,
} from "./session-todos.ts";
import { independentTodoDisplayKey } from "@zendev-lab/spark-tasks";
import { renderSparkProjectKindDisplay } from "./project-kind-registry.ts";
import { ensureSparkGraphInvariants, isPlaceholderProjectTitle } from "./spark-graph-invariants.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { clearSessionLoop, loadSessionLoop } from "./spark-session-loops.ts";
import { latestRunsByTaskRef, taskPlanSummary } from "./task-display.ts";
import { deriveTaskRoleLabel, isClaimOwnedBySession, taskClaimedBy } from "./task-ownership.ts";

export type { SparkWidgetControllerContext };

const piExtensionWidgetControllerDeps: SparkWidgetControllerDeps = {
  ensureLocalSparkDirectory: (cwd, ctx) => ensureLocalSparkDirectory(cwd, ctx),
  defaultTaskGraphStore: (cwd, ctx) => defaultTaskGraphStore(cwd, ctx),
  loadSparkGraph: (cwd, ctx) => loadSparkGraph(cwd, ctx),
  ensureSparkGraphInvariants,
  saveSparkGraphAndTodos: (cwd, graph, ctx, store) =>
    saveSparkGraphAndTodos(cwd, graph, ctx, store),
  sparkSessionKey: (ctx) => sparkSessionKey(ctx),
  sparkSessionOwnerKey: (ctx) => sparkSessionOwnerKey(ctx),
  activeSparkRoleRunProcessesForCwd,
  defaultSparkWorkflowRunStore: (cwd, ctx) => defaultSparkWorkflowRunStore(cwd, ctx),
  listDynamicWorkflowRuns: async (cwd, ctx) =>
    projectSparkDynamicWorkflowRuns({
      runs: await defaultSparkDynamicWorkflowEventStore(cwd, ctx).listRuns(),
      includeHistory: false,
    }),
  loadTodoDisplayNumberState: (cwd, ctx) => loadTodoDisplayNumberState(cwd, ctx),
  saveTodoDisplayNumberState: (cwd, ctx, state) => saveTodoDisplayNumberState(cwd, ctx, state),
  loadIndependentTodos: (cwd, ctx) => loadIndependentTodos(cwd, ctx),
  currentSparkProject: (cwd, ctx, graph) => currentSparkProject(cwd, ctx, graph),
  loadSessionGoal: (cwd, ctx) => loadSessionGoal(cwd, ctx),
  loadSessionLoop: (cwd, ctx) => loadSessionLoop(cwd, ctx),
  clearSessionLoop: (cwd, ctx) => clearSessionLoop(cwd, ctx),
  renderSparkProjectKindDisplay,
  isPlaceholderProjectTitle,
  latestRunsByTaskRef,
  taskPlanSummary,
  deriveTaskRoleLabel: (input) => deriveTaskRoleLabel(input),
  isClaimOwnedBySession,
  taskClaimedBy,
  assignTodoDisplayNumber,
  taskTodoDisplayKey,
  independentTodoDisplayKey,
};

/** Product shim: widget rendering/controller logic lives in the adjacent daemon host owner. */
export class SparkWidgetController extends SparkHostWidgetController {
  constructor() {
    super(piExtensionWidgetControllerDeps);
  }
}
