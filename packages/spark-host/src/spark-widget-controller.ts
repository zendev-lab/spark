import type { Project, ProjectRef, RunRef, Task, TaskRun } from "@zendev-lab/spark-core";
import {
  isReproRequirementSatisfied,
  type SparkReproRequirement,
  type SparkSessionRepro,
} from "@zendev-lab/spark-repro";
import type {
  WorkflowRunReconcileInput,
  WorkflowRunStatusSummary,
  WorkflowRunStoreSnapshot,
} from "@zendev-lab/spark-workflows";
import type { SessionTodoEntry, TaskGraph, TaskGraphStore } from "@zendev-lab/spark-tasks";
import {
  SparkWidget,
  type SparkWidgetActiveLens,
  type SparkWidgetState,
  type TaskEntry,
} from "./spark-widget.ts";

export interface SparkWidgetControllerContext {
  cwd?: string;
  sessionId?: string;
  sparkStateRoot?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getLeafId?: () => string | undefined;
  };
  sparkActiveMode?: SparkWidgetActiveLens;
  ui?: unknown;
}

export interface SparkTodoDisplayNumberState {
  version: 1;
  next: number;
  numbers: Record<string, number>;
  changed?: boolean;
}

export interface SparkSessionGoalProjection {
  status: "active" | "paused" | "complete";
  objective: string;
}

export interface SparkSessionLoopProjection {
  status: "active" | "paused";
  objective: string;
}

export interface SparkWidgetControllerDeps {
  ensureLocalSparkDirectory: (cwd: string, ctx?: SparkWidgetControllerContext) => Promise<void>;
  defaultTaskGraphStore: (cwd: string, ctx?: SparkWidgetControllerContext) => TaskGraphStore;
  loadSparkGraph: (cwd: string, ctx?: SparkWidgetControllerContext) => Promise<TaskGraph | null>;
  ensureSparkGraphInvariants: (graph: TaskGraph) => boolean;
  saveSparkGraphAndTodos: (
    cwd: string,
    graph: TaskGraph,
    ctx: SparkWidgetControllerContext | undefined,
    store: TaskGraphStore,
  ) => Promise<void>;
  sparkSessionKey: (ctx?: SparkWidgetControllerContext) => string;
  sparkSessionOwnerKey: (ctx?: SparkWidgetControllerContext) => string;
  activeSparkRoleRunProcessesForCwd: (cwd: string) => Array<{ runRef?: RunRef }>;
  defaultSparkWorkflowRunStore: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => {
    reconcile(input: WorkflowRunReconcileInput): Promise<WorkflowRunStoreSnapshot>;
    status(): Promise<WorkflowRunStatusSummary>;
  };
  listDynamicWorkflowRuns: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SparkDynamicWorkflowRunProjection[]>;
  loadTodoDisplayNumberState: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SparkTodoDisplayNumberState>;
  saveTodoDisplayNumberState: (
    cwd: string,
    ctx: SparkWidgetControllerContext | undefined,
    state: SparkTodoDisplayNumberState,
  ) => Promise<void>;
  loadIndependentTodos: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SessionTodoEntry[]>;
  currentSparkProject: (
    cwd: string,
    ctx: SparkWidgetControllerContext | undefined,
    graph: TaskGraph,
  ) => Promise<Project | undefined>;
  loadSessionGoal: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SparkSessionGoalProjection | undefined>;
  loadSessionLoop: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SparkSessionLoopProjection | undefined>;
  clearSessionLoop: (cwd: string, ctx?: SparkWidgetControllerContext) => Promise<void>;
  readSessionRepro: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<SparkSessionRepro | undefined>;
  loadSparkMode: (
    cwd: string,
    ctx?: SparkWidgetControllerContext,
  ) => Promise<{ mode: "plan" | "execute" | "fleet" }>;
  sparkActiveMode: (mode: "plan" | "execute" | "fleet") => SparkWidgetActiveLens;
  renderSparkProjectKindDisplay: (project: Project) => SparkWidgetState["projectKind"];
  isPlaceholderProjectTitle: (title: string) => boolean;
  latestRunsByTaskRef: (runs: TaskRun[]) => Map<string, TaskRun>;
  taskPlanSummary: (task: Task) => TaskEntry["planSummary"];
  deriveTaskRoleLabel: (input: {
    task: Task;
    currentSessionKey: string;
    latestRun?: Partial<TaskRun>;
  }) => string | undefined;
  isClaimOwnedBySession: (task: Task, sessionKey: string) => boolean;
  taskClaimedBy: (task: Task) => string | undefined;
  assignTodoDisplayNumber: (state: SparkTodoDisplayNumberState, key: string) => number;
  taskTodoDisplayKey: (taskRef: string, todoId: string) => string;
  independentTodoDisplayKey: (todo: SessionTodoEntry) => string;
}

export interface SparkDynamicWorkflowRunProjection {
  ref: string;
  name: string;
  status: "running" | "paused" | "succeeded" | "failed" | "stale" | "stopped";
  completedNodes: number;
  totalNodes: number;
  active?: boolean;
}

export class SparkWidgetController {
  private state: SparkWidgetState | undefined;
  private ctx: SparkWidgetControllerContext | undefined;
  private ui: unknown;

  private readonly widget = new SparkWidget(
    () => this.state,
    (key, cb) => {
      (
        this.ctx?.ui as { setWidget?: (...args: unknown[]) => void } | null | undefined
      )?.setWidget?.(key, cb, { placement: "belowEditor" });
    },
  );

  private readonly deps: SparkWidgetControllerDeps;

  constructor(deps: SparkWidgetControllerDeps) {
    this.deps = deps;
  }

  async refresh(cwd: string, ctx?: SparkWidgetControllerContext): Promise<void> {
    if (ctx?.ui !== this.ui) {
      this.widget.dispose();
      this.ctx = ctx;
      this.ui = ctx?.ui;
    } else {
      this.ctx = ctx;
    }

    await this.deps.ensureLocalSparkDirectory(cwd, ctx);
    const store = this.deps.defaultTaskGraphStore(cwd, ctx);
    const graph = await this.deps.loadSparkGraph(cwd, ctx);
    if (graph && this.deps.ensureSparkGraphInvariants(graph))
      await this.deps.saveSparkGraphAndTodos(cwd, graph, ctx, store);
    const sessionKey = this.deps.sparkSessionKey(ctx);
    const ownerSessionKey = this.deps.sparkSessionOwnerKey(ctx);
    const activeProcesses = this.deps.activeSparkRoleRunProcessesForCwd(cwd);
    const activeRunRefs = new Set(
      activeProcesses
        .map((process) => process.runRef)
        .filter((runRef): runRef is RunRef => typeof runRef === "string"),
    );
    const runStore = this.deps.defaultSparkWorkflowRunStore(cwd, ctx);
    if (graph && activeRunRefs.size > 0) await runStore.reconcile({ graph, activeRunRefs });
    const workflowRunStatus = await runStore.status();
    const dynamicWorkflowRuns = await this.deps.listDynamicWorkflowRuns(cwd, ctx);
    const dynamicWorkflowRun = sparkDynamicWorkflowRunWidgetEntry(dynamicWorkflowRuns);
    const todoDisplayNumbers = await this.deps.loadTodoDisplayNumberState(cwd, ctx);
    const independentTodos = await this.deps.loadIndependentTodos(cwd, ctx);
    const project = graph ? await this.deps.currentSparkProject(cwd, ctx, graph) : undefined;
    const projectOverview = graph ? sparkProjectWidgetEntries(graph, project) : undefined;
    const sessionGoal = await this.deps.loadSessionGoal(cwd, ctx);
    let sessionLoop = await this.deps.loadSessionLoop(cwd, ctx);
    if (sessionLoop?.status === "paused") {
      await this.deps.clearSessionLoop(cwd, ctx);
      sessionLoop = undefined;
    }
    const sessionRepro = await this.deps.readSessionRepro(cwd, ctx);
    const foregroundLoop = sparkForegroundLoopWidgetEntries(sessionGoal, sessionLoop, sessionRepro);
    const mode = (await this.deps.loadSparkMode(cwd, ctx)).mode;
    const activeLens = this.deps.sparkActiveMode(mode);
    const independentTodoEntries = independentTodos.map((todo) => ({
      ...todo,
      displayNumber: this.deps.assignTodoDisplayNumber(
        todoDisplayNumbers,
        this.deps.independentTodoDisplayKey(todo),
      ),
    }));
    if (!graph || !project) {
      this.state = {
        workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus),
        dynamicWorkflowRun,
        ...foregroundLoop,
        projects: projectOverview,
        activeLens,
        tasks: [],
        independentTodos: independentTodoEntries,
        taskCountTotal: 0,
        taskCountClaimed: 0,
        taskCountClaimedBySession: 0,
        outputLanguage: "en",
      };
      if (todoDisplayNumbers.changed)
        await this.deps.saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
      this.widget.update();
      return;
    }

    const allTasks = graph.tasks(project.ref) as Task[];
    const claimedTasks = allTasks.filter((task: Task) => this.deps.taskClaimedBy(task));
    const sessionTasks = claimedTasks.filter((task: Task) =>
      this.deps.isClaimOwnedBySession(task, sessionKey),
    );
    const taskTodosByRef = new Map(
      allTasks.map((task) => [task.ref, graph.taskTodos(task.ref) as SessionTodoEntry[]]),
    );
    const lastRunsByTaskRef = this.deps.latestRunsByTaskRef(graph.runs(project.ref));
    this.state = {
      projectTitle: this.deps.isPlaceholderProjectTitle(project.title) ? undefined : project.title,
      workflowRun: sparkWorkflowRunWidgetEntry(workflowRunStatus, project.ref),
      dynamicWorkflowRun,
      ...foregroundLoop,
      projectKind: this.deps.renderSparkProjectKindDisplay(project),
      activeLens,
      tasks: allTasks.map((task: Task) => {
        const backgroundOwner =
          task.claim?.kind === "role-run" &&
          task.claim.sessionId === ownerSessionKey &&
          task.claim.runRef &&
          activeRunRefs.has(task.claim.runRef)
            ? "session"
            : undefined;
        const showTodos = shouldExposeTaskTodosInWidget(
          task,
          sessionKey,
          backgroundOwner,
          this.deps,
        );
        return {
          title: task.title,
          status: mapTaskStatus(task.status),
          claim: mapTaskClaim(task, sessionKey, this.deps),
          agentLabel: this.deps.deriveTaskRoleLabel({
            task,
            currentSessionKey: sessionKey,
            latestRun: lastRunsByTaskRef.get(task.ref),
          }),
          planSummary: this.deps.taskPlanSummary(task),
          backgroundOwner,
          todos: showTodos
            ? (taskTodosByRef.get(task.ref) ?? []).map((todo: SessionTodoEntry) => ({
                id: todo.id,
                displayNumber: this.deps.assignTodoDisplayNumber(
                  todoDisplayNumbers,
                  this.deps.taskTodoDisplayKey(task.ref, String(todo.id)),
                ),
                content: todo.content,
                status: mapTodoStatus(todo.status),
              }))
            : [],
        };
      }),
      independentTodos: independentTodoEntries,
      taskCountTotal: allTasks.length,
      taskCountClaimed: claimedTasks.length,
      taskCountClaimedBySession: sessionTasks.length,
      outputLanguage: (project.outputLanguage as "zh" | "en" | undefined) ?? "en",
    };

    if (todoDisplayNumbers.changed)
      await this.deps.saveTodoDisplayNumberState(cwd, ctx, todoDisplayNumbers);
    this.widget.update();
  }
}

function sparkProjectWidgetEntries(
  graph: TaskGraph,
  activeProject: Project | undefined,
): SparkWidgetState["projects"] {
  const projects = graph.projects();
  if (projects.length === 0) return undefined;
  return projects
    .map((project) => {
      const tasks = graph.tasks(project.ref);
      const readyTasks = graph.readyTasks(project.ref);
      return {
        title: typeof project.title === "string" ? project.title : "Untitled project",
        ref: typeof project.ref === "string" ? project.ref : undefined,
        active: activeProject?.ref === project.ref,
        totalTasks: tasks.length,
        doneTasks: tasks.filter((task) => task.status === "done" || task.status === "cancelled")
          .length,
        readyTasks: readyTasks.length,
      };
    })
    .filter((project) => project.totalTasks > 0)
    .slice(0, 8);
}

function mapTaskStatus(status: string): TaskEntry["status"] {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
}

function mapTaskClaim(
  task: Task,
  sessionKey: string,
  deps: Pick<SparkWidgetControllerDeps, "taskClaimedBy" | "isClaimOwnedBySession">,
): TaskEntry["claim"] {
  if (task.claim?.kind === "role-run") return "role-run";
  const claimedBy = deps.taskClaimedBy(task);
  if (!claimedBy) return undefined;
  return deps.isClaimOwnedBySession(task, sessionKey) ? "mine" : "other";
}

function shouldExposeTaskTodosInWidget(
  task: Task,
  sessionKey: string,
  backgroundOwner: TaskEntry["backgroundOwner"],
  deps: Pick<SparkWidgetControllerDeps, "isClaimOwnedBySession">,
): boolean {
  if (task.status === "done" || task.status === "cancelled") return false;
  if (deps.isClaimOwnedBySession(task, sessionKey)) return true;
  return task.claim?.kind === "role-run" && backgroundOwner === "session";
}

function mapTodoStatus(status: string): SessionTodoEntry["status"] {
  switch (status) {
    case "in_progress":
    case "done":
    case "blocked":
    case "cancelled":
    case "pending":
      return status;
    default:
      return "pending";
  }
}

function sparkForegroundLoopWidgetEntries(
  sessionGoal: SparkSessionGoalProjection | undefined,
  sessionLoop: SparkSessionLoopProjection | undefined,
  sessionRepro?: SparkSessionRepro,
): Pick<SparkWidgetState, "goal" | "loop" | "repro"> {
  if (sessionRepro?.status === "active") {
    const stage = sessionRepro.stages[sessionRepro.currentStageIndex];
    return {
      repro: {
        status: sessionRepro.status,
        objective: sessionRepro.objective
          ? compactGoalObjective(sessionRepro.objective)
          : undefined,
        stageName: stage.name,
        stageIndex: sessionRepro.currentStageIndex,
        totalStages: sessionRepro.stages.length,
        phase: sessionRepro.currentPhase,
        acceptance: stage.acceptance.map((requirement: SparkReproRequirement) => ({
          description: requirement.description,
          satisfied: isReproRequirementSatisfied(requirement),
        })),
        gate: stage.gate
          ? { id: stage.gate.id, passed: stage.gate.evaluation?.passed === true }
          : undefined,
      },
    };
  }
  if (sessionGoal && sessionGoal.status !== "complete") {
    return {
      goal: {
        status: sessionGoal.status,
        objective: compactGoalObjective(sessionGoal.objective),
      },
    };
  }
  if (sessionLoop?.status === "active") {
    return {
      loop: {
        status: sessionLoop.status,
        objective: compactGoalObjective(sessionLoop.objective),
      },
    };
  }
  return sessionGoal
    ? {
        goal: {
          status: sessionGoal.status,
          objective: compactGoalObjective(sessionGoal.objective),
        },
      }
    : {};
}

function compactGoalObjective(objective: string): string {
  const firstLine = objective
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const normalized = (firstLine ?? objective).replace(/\s+/gu, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function sparkDynamicWorkflowRunWidgetEntry(
  runs: SparkDynamicWorkflowRunProjection[],
): SparkWidgetState["dynamicWorkflowRun"] {
  const run =
    runs.find((candidate) => candidate.active) ??
    runs.find((candidate) => candidate.status === "succeeded" || candidate.status === "failed") ??
    runs[0];
  if (!run) return undefined;
  return {
    status: run.status,
    runRef: run.ref,
    name: run.name,
    completedNodes: run.completedNodes,
    totalNodes: run.totalNodes,
    active: run.active,
    ...(run.status === "succeeded" ? { delivery: "result" as const } : {}),
    ...(run.status === "failed" ? { delivery: "error" as const } : {}),
  };
}

function sparkWorkflowRunWidgetEntry(
  workflowRunStatus: WorkflowRunStatusSummary,
  projectRef?: ProjectRef,
): SparkWidgetState["workflowRun"] {
  const activeRun = workflowRunStatus.activeRun;
  if (
    !activeRun ||
    activeRun.status !== "running" ||
    (projectRef && activeRun.projectRef !== projectRef)
  )
    return undefined;
  return {
    status: activeRun.status,
    runRef: activeRun.ref,
    scheduled: activeRun.scheduled,
    completed: activeRun.completed,
    active: true,
  };
}
