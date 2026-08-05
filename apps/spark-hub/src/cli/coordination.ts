import { type TaskGraph } from "@zendev-lab/spark-tasks";
import type { Project, ProjectRef, Task, TaskRef } from "@zendev-lab/spark-core";
import { createId, parseSparkAssignment } from "@zendev-lab/spark-protocol";

import {
  consoleSparkCliErrorOutput,
  consoleSparkCliOutput,
  helpFlagRequested,
  parseSparkCliOptions,
  printSparkCliResult,
  readBooleanOption,
  readNumberOption,
  readStringOption,
  type SparkCliOutput,
} from "./shared.ts";
import type { HubAccessCliResult } from "./access.ts";
import type { WorkspaceAccessCliResult } from "./workspace-access.ts";
import type { HubInstanceCliFailure, HubInstanceCliResult } from "./instance.ts";
import { loadSparkHubCoordinationState } from "./coordination-adapter.ts";
import type {
  SparkHubArtifactSummary,
  SparkHubCliOptions,
  SparkHubCoordinationState,
  SparkHubGoalSource,
  SparkHubGoalSummary,
  SparkHubReviewSummary,
  SparkHubWorkflowSummary,
} from "./coordination-contract.ts";
export type {
  SparkHubArtifactSummary,
  SparkHubCliOptions,
  SparkHubGoalSource,
  SparkHubGoalSummary,
  SparkHubReviewSummary,
  SparkHubWorkflowSummary,
} from "./coordination-contract.ts";
import { getManagedSession, submitAssignment } from "./coordination-daemon.ts";

export type SparkHubCliResource =
  | "help"
  | "status"
  | "project"
  | "task"
  | "goal"
  | "artifact"
  | "review"
  | "workflow"
  | "assign"
  | "instance"
  | "access"
  | "workspace-access";

export interface SparkHubCliCommand {
  resource: SparkHubCliResource;
  verb?: string;
  json?: boolean;
  selector?: string;
  limit?: number;
  sessionId?: string;
  goal?: string;
  title?: string;
  role?: string;
  workspaceId?: string;
  workspaceRef?: string;
  snapshotPath?: string;
  databasePath?: string;
  rollbackRoot?: string;
  yes?: boolean;
  label?: string;
  tokenId?: string;
}

export type SparkHubCliResult =
  | { action: "help"; text: string }
  | { action: "status"; result: SparkHubStatusResult }
  | { action: "project"; result: SparkHubProjectListResult | SparkHubProjectStatusResult }
  | { action: "task"; result: SparkHubTaskListResult | SparkHubTaskStatusResult }
  | { action: "goal"; result: SparkHubGoalResult }
  | { action: "artifact"; result: SparkHubArtifactListResult }
  | { action: "review"; result: SparkHubReviewListResult }
  | { action: "workflow"; result: SparkHubWorkflowListResult }
  | { action: "assign"; result: SparkHubAssignResult }
  | { action: "instance"; result: HubInstanceCliResult }
  | { action: "access"; result: HubAccessCliResult }
  | { action: "workspace-access"; result: WorkspaceAccessCliResult };

export interface SparkHubAssignResult {
  plane: "hub";
  resource: "assign";
  assignmentId: string;
  sessionId: string;
  goal: string;
  status: string;
  commandKind: "assignment.create.request";
  text: string;
}

export interface SparkHubStatusResult {
  plane: "hub";
  resource: "status";
  currentProjectRef: ProjectRef | null;
  currentProjectTitle?: string;
  projectCount: number;
  taskCounts: SparkHubTaskCounts;
  readyTasks: SparkHubTaskRow[];
  scope: SparkHubStatusScope;
  goal?: SparkHubGoalSummary | null;
  artifactCount: number;
  reviewCount: number;
  workflowRunCount: number;
  text: string;
}

export interface SparkHubStatusScope {
  selectedWorkspace: string;
  selectedSessionKey: string | null;
  selectedProjectRef: ProjectRef | null;
  goalSource: SparkHubGoalSource;
}

export interface SparkHubTaskCounts {
  total: number;
  unfinished: number;
  ready: number;
  done: number;
  claimed: number;
}

export interface SparkHubProjectListResult {
  plane: "hub";
  resource: "project";
  projects: SparkHubProjectRow[];
  text: string;
}

export interface SparkHubProjectStatusResult {
  plane: "hub";
  resource: "project";
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  readyTasks: SparkHubTaskRow[];
  currentClaim: SparkHubTaskRow | null;
  statusCounts: Record<string, number>;
  text: string;
}

export interface SparkHubProjectRow {
  projectRef: ProjectRef;
  title: string;
  current: boolean;
  taskCount: number;
  unfinished: number;
  ready: number;
}

export interface SparkHubTaskListResult {
  plane: "hub";
  resource: "task";
  projectRef: ProjectRef | null;
  tasks: SparkHubTaskRow[];
  text: string;
}

export interface SparkHubTaskStatusResult {
  plane: "hub";
  resource: "task";
  task: SparkHubTaskRow;
  projectRef: ProjectRef;
  evidenceRefs: string[];
  text: string;
}

export interface SparkHubTaskRow {
  taskRef: TaskRef;
  name: string;
  title: string;
  status: string;
  kind: string;
  projectRef: ProjectRef;
  ready: boolean;
  claimed: boolean;
  owner?: string;
}

export interface SparkHubGoalResult {
  plane: "hub";
  resource: "goal";
  goal: SparkHubGoalSummary | null;
  text: string;
}

export interface SparkHubArtifactListResult {
  plane: "hub";
  resource: "artifact";
  artifacts: SparkHubArtifactSummary[];
  text: string;
}

export interface SparkHubReviewListResult {
  plane: "hub";
  resource: "review";
  reviews: SparkHubReviewSummary[];
  text: string;
}

export interface SparkHubWorkflowListResult {
  plane: "hub";
  resource: "workflow";
  workflows: SparkHubWorkflowSummary[];
  text: string;
}

export function parseSparkHubCliArgs(argv: string[]): SparkHubCliCommand {
  if (argv.length === 0) return { resource: "status", json: false };
  const [resourceToken, ...rest] = argv;
  if (resourceToken === "help" || resourceToken === "--help" || resourceToken === "-h") {
    return { resource: "help" };
  }
  if (helpFlagRequested(argv)) {
    return { resource: "help" };
  }
  const parsed = parseSparkCliOptions(rest);
  const json = readBooleanOption(parsed.options, "json");
  const limit = readNumberOption(parsed.options, "limit");
  const selector =
    readStringOption(parsed.options, "project") ?? readStringOption(parsed.options, "task");
  const [verb = defaultHubVerb(resourceToken), positionalSelector] = parsed.positionals;
  switch (resourceToken) {
    case "status":
      return { resource: "status", verb: "show", json, limit };
    case "project":
    case "task":
    case "goal":
    case "artifact":
    case "review":
    case "workflow":
      return {
        resource: resourceToken,
        verb,
        json,
        limit,
        selector: selector ?? positionalSelector,
      };
    case "assign": {
      const sessionId =
        readStringOption(parsed.options, "session")?.trim() || positionalSelector?.trim();
      const goal =
        readStringOption(parsed.options, "goal")?.trim() ||
        parsed.positionals
          .slice(verb === "create" || verb === "run" ? 1 : 0)
          .join(" ")
          .trim();
      return {
        resource: "assign",
        verb: verb === "create" || verb === "run" ? verb : "create",
        json,
        sessionId,
        goal: goal || undefined,
        title: readStringOption(parsed.options, "title")?.trim(),
        role: readStringOption(parsed.options, "role")?.trim(),
        workspaceId: readStringOption(parsed.options, "workspace")?.trim(),
      };
    }
    case "instance":
      return {
        resource: "instance",
        verb,
        json,
        snapshotPath:
          readStringOption(parsed.options, "snapshot")?.trim() || positionalSelector?.trim(),
        databasePath: readStringOption(parsed.options, "database")?.trim(),
        rollbackRoot: readStringOption(parsed.options, "rollback-root")?.trim(),
        yes: readBooleanOption(parsed.options, "yes") || readBooleanOption(parsed.options, "y"),
      };
    case "access":
      return {
        resource: "access",
        verb,
        json,
        databasePath: readStringOption(parsed.options, "database")?.trim(),
        label: readStringOption(parsed.options, "label")?.trim(),
        tokenId:
          readStringOption(parsed.options, "id")?.trim() ||
          (verb === "revoke" ? positionalSelector?.trim() : undefined),
      };
    case "workspace": {
      const [topic, operation, ...rest] = parsed.positionals;
      if (topic !== "access") {
        throw new Error(
          "Usage: spark hub workspace access create|list|revoke --workspace <id> [...]",
        );
      }
      const workspaceFromFlag = readStringOption(parsed.options, "workspace")?.trim();
      const idFromFlag = readStringOption(parsed.options, "id")?.trim();
      let workspaceRef = workspaceFromFlag;
      let tokenId = idFromFlag;
      if (!workspaceRef && rest[0]) {
        workspaceRef = rest[0].trim();
        if (operation === "revoke" && !tokenId && rest[1]) tokenId = rest[1].trim();
      } else if (operation === "revoke" && !tokenId && rest[0]) {
        tokenId = rest[0].trim();
      }
      return {
        resource: "workspace-access",
        verb: operation ?? "list",
        json,
        workspaceRef,
        databasePath: readStringOption(parsed.options, "database")?.trim(),
        label: readStringOption(parsed.options, "label")?.trim(),
        tokenId,
      };
    }
    default:
      throw new Error(`unknown spark hub resource: ${resourceToken}`);
  }
}

export async function handleSparkHubCliCommand(
  command: SparkHubCliCommand,
  options: SparkHubCliOptions = {},
): Promise<SparkHubCliResult> {
  if (command.resource === "help") return { action: "help", text: sparkHubHelpText() };
  if (command.resource === "instance") {
    const { handleHubInstanceCliCommand } = await import("./instance.ts");
    return {
      action: "instance",
      result: await handleHubInstanceCliCommand(
        {
          operation: command.verb ?? "status",
          snapshotPath: command.snapshotPath,
          databasePath: command.databasePath,
          rollbackRoot: command.rollbackRoot,
          yes: command.yes,
        },
        options.instance,
      ),
    };
  }
  if (command.resource === "access") {
    const { handleHubAccessCliCommand } = await import("./access.ts");
    return {
      action: "access",
      result: await handleHubAccessCliCommand({
        operation: command.verb ?? "list",
        databasePath: command.databasePath,
        label: command.label,
        tokenId: command.tokenId,
        json: command.json,
      }),
    };
  }
  if (command.resource === "workspace-access") {
    const { handleWorkspaceAccessCliCommand } = await import("./workspace-access.ts");
    return {
      action: "workspace-access",
      result: await handleWorkspaceAccessCliCommand({
        operation: command.verb ?? "list",
        workspaceRef: command.workspaceRef,
        databasePath: command.databasePath,
        label: command.label,
        tokenId: command.tokenId,
        json: command.json,
      }),
    };
  }
  const state = await loadHubState(options);
  switch (command.resource) {
    case "status":
      return { action: "status", result: await hubStatus(state, command) };
    case "project":
      return { action: "project", result: hubProject(state, command) };
    case "task":
      return { action: "task", result: hubTask(state, command) };
    case "goal":
      return { action: "goal", result: hubGoal(state) };
    case "artifact":
      return { action: "artifact", result: hubArtifacts(state, command) };
    case "review":
      return { action: "review", result: hubReviews(state, command) };
    case "workflow":
      return { action: "workflow", result: hubWorkflows(state, command) };
    case "assign":
      return { action: "assign", result: await hubAssign(command, options) };
  }
}

export async function runSparkHubCliCommand(
  command: SparkHubCliCommand,
  output: SparkCliOutput = consoleSparkCliOutput,
  options: SparkHubCliOptions = {},
  errorOutput: SparkCliOutput = consoleSparkCliErrorOutput,
): Promise<number> {
  try {
    const result = await handleSparkHubCliCommand(command, options);
    if (result.action === "help") {
      output.write(result.text);
      return 0;
    }
    if (!command.json && "text" in result.result) {
      output.write(result.result.text);
      return 0;
    }
    printSparkCliResult(output, result, { json: command.json });
    return 0;
  } catch (error) {
    const instanceFailure = readHubInstanceFailure(error);
    if (!instanceFailure) throw error;
    const failure = { action: "error", error: instanceFailure } as const;
    if (command.json) {
      printSparkCliResult(errorOutput, failure, { json: true });
    } else {
      errorOutput.write(`${instanceFailure.code}: ${instanceFailure.message}\n`);
    }
    return instanceFailure.exitCode;
  }
}

function readHubInstanceFailure(error: unknown): HubInstanceCliFailure | null {
  if (!(error instanceof Error) || error.name !== "HubInstanceCliError") return null;
  const failure = (error as Error & { failure?: unknown }).failure;
  if (!failure || typeof failure !== "object") return null;
  const candidate = failure as Partial<HubInstanceCliFailure>;
  return typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.exitCode === "number"
    ? (candidate as HubInstanceCliFailure)
    : null;
}

export function sparkHubHelpText(): string {
  return `spark hub - Spark Hub Web presentation host

Usage:
  spark hub
  spark hub web start [--json]
  spark hub web status [--json]
  spark hub web stop [--json]
  spark hub web logs [--lines <n>] [--json]
  spark hub --help

Commands:
  (no command)        Start the built production Hub Web host
  web                 Start, inspect, stop, or locate logs for the background Web hub

Hub coordination, access, instance, workspace, and delegation commands live under spark hub.
Legacy spark hub coordination aliases remain accepted for one version and print a migration warning.

Production start environment:
  HOST=0.0.0.0                         Intentionally listen on all interfaces
  PORT=5174                            Override the default port
  SPARK_HUB_PUBLIC_URL=https://spark.example.com
                                        Canonical public origin for a custom domain
  SPARK_HUB_PUBLIC_URL=auto        Derive the origin from a trusted proxy request
  SPARK_HUB_TRUST_PROXY=loopback   Trust forwarded headers from a loopback proxy
  SPARK_HUB_PROXY_HOPS=1           Select the client entry in X-Forwarded-For
`;
}

type LoadedHubState = SparkHubCoordinationState;

async function loadHubState(options: SparkHubCliOptions): Promise<LoadedHubState> {
  return await loadSparkHubCoordinationState(options);
}

async function hubStatus(
  state: LoadedHubState,
  command: SparkHubCliCommand,
): Promise<SparkHubStatusResult> {
  const graph = requireGraph(state.graph);
  const project = state.currentProjectRef ? findProject(graph, state.currentProjectRef) : undefined;
  const tasks = project ? graph.tasks(project.ref) : graph.tasks();
  const ready = readyTasksForServer(graph, project?.ref);
  const goal = normalizeGoalForProject(state.goal, project?.ref ?? null);
  const result: SparkHubStatusResult = {
    plane: "hub",
    resource: "status",
    currentProjectRef: project?.ref ?? null,
    ...(project ? { currentProjectTitle: project.title } : {}),
    projectCount: graph.projects().length,
    taskCounts: taskCounts(tasks, ready),
    readyTasks: ready.slice(0, command.limit ?? 20).map((task) => taskRow(graph, task)),
    scope: statusScope(state, project?.ref ?? null, goal),
    goal,
    artifactCount: state.artifacts.length,
    reviewCount: state.reviews.length,
    workflowRunCount: state.workflows.length,
    text: "",
  };
  result.text = `${result.currentProjectRef ?? "no-project"} ${result.taskCounts.unfinished} unfinished ${result.taskCounts.ready} ready\n`;
  return result;
}

function hubProject(
  state: LoadedHubState,
  command: SparkHubCliCommand,
): SparkHubProjectListResult | SparkHubProjectStatusResult {
  const graph = requireGraph(state.graph);
  if ((command.verb ?? "list") === "list") {
    const projects = graph
      .projects()
      .map((project) => projectRow(graph, project, state.currentProjectRef));
    return {
      plane: "hub",
      resource: "project",
      projects,
      text: projects
        .map((project) => `${project.current ? "*" : " "} ${project.projectRef} ${project.title}\n`)
        .join(""),
    };
  }
  const project = resolveProject(graph, command.selector ?? state.currentProjectRef ?? undefined);
  const tasks = graph.tasks(project.ref);
  const ready = readyTasksForServer(graph, project.ref);
  const currentClaim = tasks.find((task) => Boolean(task.claim));
  return {
    plane: "hub",
    resource: "project",
    projectRef: project.ref,
    title: project.title,
    current: project.ref === state.currentProjectRef,
    readyTasks: ready.map((task) => taskRow(graph, task)),
    currentClaim: currentClaim ? taskRow(graph, currentClaim) : null,
    statusCounts: statusCounts(tasks),
    text: `${project.ref} ${project.title}: ${ready.length} ready\n`,
  };
}

function hubTask(
  state: LoadedHubState,
  command: SparkHubCliCommand,
): SparkHubTaskListResult | SparkHubTaskStatusResult {
  const graph = requireGraph(state.graph);
  if ((command.verb ?? "list") === "list") {
    const project = command.selector
      ? resolveProject(graph, command.selector)
      : state.currentProjectRef
        ? findProject(graph, state.currentProjectRef)
        : undefined;
    const tasks = (project ? graph.tasks(project.ref) : graph.tasks()).slice(
      0,
      command.limit ?? 50,
    );
    const rows = tasks.map((task) => taskRow(graph, task));
    return {
      plane: "hub",
      resource: "task",
      projectRef: project?.ref ?? null,
      tasks: rows,
      text: rows.map((task) => `${task.status} ${task.taskRef} ${task.title}\n`).join(""),
    };
  }
  const task = resolveTask(graph, command.selector);
  return {
    plane: "hub",
    resource: "task",
    task: taskRow(graph, task),
    projectRef: task.projectRef,
    evidenceRefs: [...(task.inputEvidenceRefs ?? []), ...(task.outputEvidenceRefs ?? [])],
    text: `${task.status} ${task.ref} ${task.title}\n`,
  };
}

function hubGoal(state: LoadedHubState): SparkHubGoalResult {
  const goal = normalizeGoalForProject(state.goal, state.currentProjectRef);
  return {
    plane: "hub",
    resource: "goal",
    goal,
    text: goal ? `${goal.status} ${goal.objective ?? ""}\n` : "No Spark goal found.\n",
  };
}

function hubArtifacts(
  state: LoadedHubState,
  command: SparkHubCliCommand,
): SparkHubArtifactListResult {
  const artifacts = state.artifacts.slice(0, command.limit ?? 50);
  for (const artifact of artifacts) {
    if (
      !artifact.artifactRef.startsWith("artifact:") ||
      artifact.artifactRef.length === "artifact:".length
    ) {
      throw new Error("Hub Artifact summary requires an artifact: ref");
    }
  }
  return {
    plane: "hub",
    resource: "artifact",
    artifacts,
    text: artifacts.map((artifact) => `${artifact.artifactRef} ${artifact.title ?? ""}\n`).join(""),
  };
}

function hubReviews(state: LoadedHubState, command: SparkHubCliCommand): SparkHubReviewListResult {
  const reviews = state.reviews.slice(0, command.limit ?? 50);
  return {
    plane: "hub",
    resource: "review",
    reviews,
    text: reviews
      .map((review) => `${review.reviewRef} ${review.outcome ?? review.status ?? ""}\n`)
      .join(""),
  };
}

function hubWorkflows(
  state: LoadedHubState,
  command: SparkHubCliCommand,
): SparkHubWorkflowListResult {
  const workflows = state.workflows.slice(0, command.limit ?? 50);
  return {
    plane: "hub",
    resource: "workflow",
    workflows,
    text: workflows
      .map((workflow) => `${workflow.runRef} ${workflow.status ?? ""} ${workflow.name ?? ""}\n`)
      .join(""),
  };
}

function normalizeGoalForProject(
  goal: SparkHubGoalSummary | null,
  currentProjectRef: ProjectRef | null,
): SparkHubGoalSummary | null {
  if (!goal) return null;
  const current = Boolean(
    goal.projectRef && currentProjectRef && goal.projectRef === currentProjectRef,
  );
  const source: SparkHubGoalSource = goal.projectRef
    ? current
      ? "current-project"
      : "unrelated-project"
    : "legacy-unscoped";
  return { ...goal, current, source };
}

function statusScope(
  state: LoadedHubState,
  selectedProjectRef: ProjectRef | null,
  goal: SparkHubGoalSummary | null,
): SparkHubStatusScope {
  return {
    selectedWorkspace: state.cwd,
    selectedSessionKey: goal?.current
      ? (goal.sessionKey ?? state.currentSessionKey)
      : state.currentSessionKey,
    selectedProjectRef,
    goalSource: goal?.source ?? "none",
  };
}

function defaultHubVerb(resource: string): string {
  return resource === "status" || resource === "goal" || resource === "instance"
    ? "status"
    : "list";
}

function requireGraph(graph: TaskGraph | null): TaskGraph {
  if (!graph) throw new Error("Spark hub coordination state not found: .spark/projects");
  return graph;
}

function resolveProject(graph: TaskGraph, selector: string | undefined): Project {
  if (!selector) {
    const first = graph.projects()[0];
    if (!first) throw new Error("no Spark projects found");
    return first;
  }
  const project = graph
    .projects()
    .find((candidate) => candidate.ref === selector || candidate.title === selector);
  if (!project) throw new Error(`unknown project: ${selector}`);
  return project;
}

function findProject(graph: TaskGraph, ref: ProjectRef): Project | undefined {
  return graph.projects().find((project) => project.ref === ref);
}

async function hubAssign(
  command: SparkHubCliCommand,
  options: SparkHubCliOptions,
): Promise<SparkHubAssignResult> {
  const sessionId = command.sessionId?.trim();
  const goal = command.goal?.trim();
  if (!sessionId) throw new Error("spark hub assign requires --session <session-id>");
  if (!goal) throw new Error("spark hub assign requires --goal <text>");

  const session = await getManagedSession(sessionId, options.daemonClient);
  if (session.status === "archived") {
    throw new Error(`cannot assign to archived session: ${sessionId}`);
  }

  const role = command.role?.trim();
  const title = command.title?.trim();
  const assignment = parseSparkAssignment({
    goal,
    target: {
      sessionId,
      ...(role ? { role } : {}),
      workspaceId: command.workspaceId?.trim() || session.workspaceId,
    },
    constraints: [],
    evidence: [],
    source: { kind: "cli" },
    ...(title ? { title } : {}),
  });
  const assignmentId = createId("asn");
  const submitted = await submitAssignment(
    { sessionId, prompt: goal, assignment },
    options.daemonClient,
  );

  return {
    plane: "hub",
    resource: "assign",
    assignmentId,
    sessionId,
    goal,
    status: submitted.status,
    commandKind: "assignment.create.request",
    text: `queued assignment ${assignmentId} -> session ${sessionId} (${submitted.invocationId})\n`,
  };
}

function resolveTask(graph: TaskGraph, selector: string | undefined): Task {
  if (!selector) throw new Error("task status requires a task ref, name, or title");
  const task = graph
    .tasks()
    .find(
      (candidate) =>
        candidate.ref === selector || candidate.name === selector || candidate.title === selector,
    );
  if (!task) throw new Error(`unknown task: ${selector}`);
  return task;
}

function projectRow(
  graph: TaskGraph,
  project: Project,
  currentProjectRef: ProjectRef | null,
): SparkHubProjectRow {
  const tasks = graph.tasks(project.ref);
  const ready = readyTasksForServer(graph, project.ref);
  return {
    projectRef: project.ref,
    title: project.title,
    current: project.ref === currentProjectRef,
    taskCount: tasks.length,
    unfinished: tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
      .length,
    ready: ready.length,
  };
}

function taskRow(graph: TaskGraph, task: Task): SparkHubTaskRow {
  return {
    taskRef: task.ref,
    name: task.name,
    title: task.title,
    status: task.status,
    kind: task.kind,
    projectRef: task.projectRef,
    ready: readyTasksForServer(graph, task.projectRef).some((ready) => ready.ref === task.ref),
    claimed: Boolean(task.claim),
    ...(task.claim?.claimedBy ? { owner: task.claim.claimedBy } : {}),
  };
}

function readyTasksForServer(graph: TaskGraph, projectRef?: ProjectRef): Task[] {
  const byRef = new Map<TaskRef, Task>();
  for (const task of graph.readyTasks(projectRef)) byRef.set(task.ref, task);
  for (const task of graph.tasks(projectRef)) {
    if (task.status === "ready") byRef.set(task.ref, task);
  }
  return [...byRef.values()];
}

function taskCounts(tasks: Task[], ready: Task[]): SparkHubTaskCounts {
  return {
    total: tasks.length,
    unfinished: tasks.filter((task) => task.status !== "done" && task.status !== "cancelled")
      .length,
    ready: ready.length,
    done: tasks.filter((task) => task.status === "done").length,
    claimed: tasks.filter((task) => Boolean(task.claim)).length,
  };
}

function statusCounts(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}
