import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent, ToolRenderTheme } from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-text";

export type SparkTaskReadAction =
  | "task_status"
  | "project_status"
  | "workspace_status"
  | "project_list"
  | "run_status";
export type SparkTaskWriteAction =
  | "project_use"
  | "project_rename"
  | "project_metadata_update"
  | "claim"
  | "plan"
  | "replace_dependencies"
  | "finish"
  | "recover"
  | "release"
  | "artifact_link"
  | "artifact_unlink"
  | "plan_update"
  | "cache_cleanup";
export type SparkTaskAssignAction = "assign";
export type SparkTaskAction = SparkTaskReadAction | SparkTaskWriteAction | SparkTaskAssignAction;

/**
 * Session-bound TODO checklist actions. The public `update` action reconciles target
 * state atomically; event-style actions remain decoder-only compatibility inputs. Task
 * plan items live on task_write({ action: "plan_update" }) instead.
 */
export type SparkTodoAction =
  | "update"
  | "list"
  | "init"
  | "append"
  | "start"
  | "done"
  | "upsert_done"
  | "block"
  | "cancel"
  | "delete"
  | "restore"
  | "remove"
  | "note";

type ToolExecute = ToolConfig["execute"];
type ToolOnUpdate = Parameters<ToolExecute>[3];
type ToolContext = Parameters<ToolExecute>[4];

export type SparkTaskToolResult = Awaited<ReturnType<ToolExecute>>;

export interface SparkTaskActionHandlerArgs {
  toolCallId: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onUpdate: ToolOnUpdate;
  ctx: ToolContext;
}

export type SparkTaskActionHandler = (
  args: SparkTaskActionHandlerArgs,
) => Promise<SparkTaskToolResult>;

export type SparkTaskToolHandlers = Partial<Record<SparkTaskAction, SparkTaskActionHandler>>;

export interface SparkTaskHostApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkTaskToolOptions {
  handlers: SparkTaskToolHandlers;
}

/** The `todo` tool routes every action through one session-bound handler. */
export interface SparkTodoToolOptions {
  handler: SparkTaskActionHandler;
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

const TASK_READ_ACTIONS: readonly SparkTaskReadAction[] = [
  "task_status",
  "project_status",
  "workspace_status",
  "project_list",
  "run_status",
];

const TASK_WRITE_ACTIONS: readonly SparkTaskWriteAction[] = [
  "project_use",
  "project_rename",
  "project_metadata_update",
  "claim",
  "plan",
  "replace_dependencies",
  "finish",
  "recover",
  "release",
  "artifact_link",
  "artifact_unlink",
  "plan_update",
  "cache_cleanup",
];

const TODO_ACTIONS: readonly SparkTodoAction[] = [
  "update",
  "list",
  "init",
  "append",
  "start",
  "done",
  "upsert_done",
  "block",
  "cancel",
  "delete",
  "restore",
  "remove",
  "note",
];

const taskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("blocked"),
  Type.Literal("cancelled"),
]);

const todoStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("blocked"),
  Type.Literal("cancelled"),
]);

const taskPlanItemStateSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Existing plan-item id; omit for a new item." })),
    title: Type.String({ description: "Concrete plan-item outcome." }),
    description: Type.Optional(Type.String()),
    status: todoStatusSchema,
    notes: Type.Optional(Type.Array(Type.String())),
    blockedBy: Type.Optional(Type.Array(Type.String())),
    evidenceRefs: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const sessionTodoStateSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Existing TODO id; omit for a new item." })),
    content: Type.String({ description: "Standalone next-step text." }),
    status: todoStatusSchema,
    notes: Type.Optional(Type.Array(Type.String())),
    blockedBy: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const taskMutationSchema = Type.Object(
  {
    taskRef: Type.Optional(Type.String({ description: "Exact existing Task ref." })),
    name: Type.Optional(Type.String({ description: "Stable @task name." })),
    title: Type.Optional(Type.String({ description: "Task title." })),
    description: Type.Optional(Type.String({ description: "Concrete task objective." })),
    kind: Type.Optional(Type.String({ description: "research | implement | review" })),
    status: Type.Optional(taskStatusSchema),
    roleRef: Type.Optional(Type.String({ description: "Preferred executor Role ref." })),
    executionPolicy: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Typed Task execution-policy object.",
      }),
    ),
    plan: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "High-bar TaskPlan object.",
      }),
    ),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    rationale: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const finishEvidenceSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    changedFiles: Type.Optional(Type.Array(Type.String())),
    sourceRefs: Type.Optional(Type.Array(Type.String())),
    validationCommands: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const statusViewProperties = {
  includeWorkspaceSummary: Type.Optional(Type.Boolean()),
  includeStateSummary: Type.Optional(Type.Boolean()),
  view: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("summary")])),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  limit: Type.Optional(Type.Number()),
};

export function registerSparkTaskTool(pi: SparkTaskHostApi, options: SparkTaskToolOptions): void {
  pi.registerTool({
    name: "task_read",
    label: "Task Read",
    description:
      "Read-only project/task/TODO/run graph capability. Use action=task_status for one task, project_status for one project, workspace_status for the broad workspace summary, project_list for project lists, or run_status for task-run status.",
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["tasks"],
      modes: ["plan", "execute", "fleet"],
      approval: "none",
    },
    promptGuidelines: [
      "Use task_read only for project/task/TODO/run graph inspection. run_status accepts status, list, or inspect; use workflow action=runs for mutations and lifecycle control.",
      "Use task_write for project/task/TODO graph mutations.",
      "Use assign for explicit role-run spawning; task_read never schedules, reconciles, acknowledges, or controls child runs.",
    ],
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("task_status"),
          Type.Literal("project_status"),
          Type.Literal("workspace_status"),
          Type.Literal("project_list"),
          Type.Literal("run_status"),
        ]),
        projectRef: Type.Optional(Type.String()),
        taskRef: Type.Optional(Type.String()),
        runRef: Type.Optional(Type.String()),
        runAction: Type.Optional(
          Type.Union([Type.Literal("status"), Type.Literal("list"), Type.Literal("inspect")]),
        ),
        includeHistory: Type.Optional(Type.Boolean()),
        ...statusViewProperties,
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      return renderTaskCall("task_read", args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeSparkTaskReadAction(params.action);
      return executeSparkTaskAction("task_read", action, options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });

  pi.registerTool({
    name: "task_write",
    label: "Task Write",
    description:
      "Project/task graph mutation capability. Use intent-specific actions to select/finish/rename/update projects, claim/plan/replace dependencies/finish/release tasks, update task plan items, or clean task-owned caches.",
    policy: taskWritePolicy(["plan", "execute", "fleet"]),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "project_use") return taskWritePolicy(["plan", "execute", "fleet"]);
      if (action === "recover" || action === "release" || action === "finish") {
        return taskWritePolicy(["execute", "fleet"]);
      }
      if (
        action === "claim" ||
        action === "artifact_link" ||
        action === "artifact_unlink" ||
        action === "plan_update"
      ) {
        return taskWritePolicy(["execute"]);
      }
      return taskWritePolicy(["plan"]);
    },
    promptGuidelines: [
      "Use task_write for project/task graph mutations.",
      "Creating or claiming a task is plan-locked: every task must have a bound high-bar task.plan before claim/creation completes; objectives, success criteria, evidence, and plan items must be concrete and objectively verifiable.",
      "Use action=replace_dependencies only to atomically replace one existing task's complete dependency set; it rejects mixed task creation, metadata, plan, and status mutations.",
      "Use action=release to give up this session's unfinished task claim without finishing or cancelling the task; action=plan_update atomically reconciles the complete desired plan-item state for the claimed task.",
      "Use artifact_link/artifact_unlink to maintain the task's durable product Artifact references.",
      "Use the session-bound todo tool for standalone session checklists.",
      "Use assign for explicit role-run spawning; task_write does not expose run_ready or run_control.",
    ],
    parameters: Type.Union([
      Type.Object(
        {
          action: Type.Literal("project_use"),
          projectRef: Type.Optional(Type.String({ description: "Existing Project ref/title." })),
          title: Type.Optional(Type.String({ description: "New Project title." })),
          description: Type.Optional(Type.String()),
          purpose: Type.Optional(Type.String({ description: "Project purpose." })),
          outputLanguage: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("project_rename"),
          projectRef: Type.Optional(Type.String()),
          title: Type.String({ description: "New Project title." }),
          text: Type.Optional(Type.String({ description: "Reason for the rename." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("project_metadata_update"),
          projectRef: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          purpose: Type.Optional(Type.String({ description: "Project purpose." })),
          outputLanguage: Type.Optional(Type.Union([Type.Literal("zh"), Type.Literal("en")])),
          text: Type.Optional(Type.String({ description: "Reason for the update." })),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("claim"),
          projectRef: Type.Optional(Type.String()),
          taskRef: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          kind: Type.Optional(Type.String({ description: "research | implement | review" })),
          status: Type.Optional(taskStatusSchema),
          roleRef: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("plan"),
          projectRef: Type.Optional(Type.String()),
          tasks: Type.Array(taskMutationSchema, {
            description:
              "Concrete Task plan entries with high-bar objectives, verifiable success criteria, concrete evidence, and checkable plan items.",
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("replace_dependencies"),
          taskRef: Type.String({
            description: "Existing Task ref, exact name, or exact title selector.",
          }),
          dependsOn: Type.Array(
            Type.String({
              description:
                "Complete replacement prerequisite selector list; [] clears all dependencies.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("finish"),
          taskRef: Type.Optional(Type.String()),
          status: Type.Optional(
            Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("cancelled")]),
          ),
          summary: Type.Optional(Type.String()),
          evidenceRefs: Type.Optional(Type.Array(Type.String())),
          evidence: Type.Optional(finishEvidenceSchema),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Union([Type.Literal("recover"), Type.Literal("release")]),
          projectRef: Type.Optional(Type.String()),
          taskRef: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Union([Type.Literal("artifact_link"), Type.Literal("artifact_unlink")]),
          taskRef: Type.Optional(Type.String()),
          artifactRef: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("plan_update"),
          taskRef: Type.Optional(Type.String()),
          items: Type.Array(taskPlanItemStateSchema, {
            description:
              "Complete desired non-deleted plan-item state; omitted existing items become deleted history.",
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          action: Type.Literal("cache_cleanup"),
          dryRun: Type.Optional(Type.Boolean()),
          olderThanDays: Type.Optional(Type.Number()),
          includeBroken: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ]),
    renderCall(args, theme) {
      return renderTaskCall("task_write", args, theme);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const action = normalizeSparkTaskWriteAction(params.action);
      return executeSparkTaskAction("task_write", action, options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });

  pi.registerTool({
    name: "assign",
    label: "Assign",
    description:
      "Explicit Spark assignment/spawn capability. Dispatch an allowlisted ready-task frontier through daemon-managed Task Sessions using host-owned scheduling policy.",
    policy: {
      effect: "external_write",
      executionMode: "sequential",
      domains: ["tasks", "sessions"],
      modes: ["execute", "fleet"],
      approval: "required",
    },
    promptGuidelines: [
      "Use assign only when ready Spark work should be dispatched to role runs.",
      "Prefer workflow runtime for parallel/scripted execution; assign is the explicit spawn surface for Spark ready-task frontiers.",
      "Use task_read for inspection and task_write for graph mutations before assigning work.",
      "When a planner supplies taskRefs, only those ready tasks may be dispatched; non-ready or out-of-scope refs fail closed.",
    ],
    parameters: Type.Object(
      {
        taskRefs: Type.Optional(
          Type.Array(
            Type.String({
              description:
                "Optional explicit ready-task allowlist. Required by active Repro drives.",
            }),
          ),
        ),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const taskCount = Array.isArray(args.taskRefs) ? `tasks=${args.taskRefs.length}` : undefined;
      const text = ["assign", "dispatch", taskCount].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeSparkTaskAction("assign", "assign", options, {
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      });
    },
  });
}

function taskWritePolicy(modes: string[]) {
  return {
    effect: "local_write" as const,
    executionMode: "sequential" as const,
    domains: ["tasks"],
    modes,
    approval: "none" as const,
  };
}

function executeSparkTaskAction(
  toolName: string,
  action: SparkTaskAction,
  options: SparkTaskToolOptions,
  args: SparkTaskActionHandlerArgs,
): Promise<SparkTaskToolResult> {
  const handler = options.handlers[action];
  if (!handler) throw new Error(`${toolName} action is not available in this host: ${action}`);
  return handler(args);
}

export function registerSparkTodoTool(pi: SparkTaskHostApi, options: SparkTodoToolOptions): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Atomically reconcile the session-bound TODO checklist of lightweight standalone next-steps that survive reload and are not tied to a claimed task. Current TODO state is injected automatically; use the registered context provider only for explicit diagnostics.",
    promptGuidelines: [
      "Use todo for standalone session next-steps that are not tied to a claimed durable task.",
      "Use task_write({ action: 'plan_update' }) for plan items of the currently claimed task, and task_write({ action: 'plan' }) to create durable project tasks.",
      "Call action=update with the complete desired non-deleted checklist; retain existing ids, set explicit target statuses, and keep at most one in_progress item.",
      "As soon as completion evidence or an exact blocker is known, send the updated target state before starting unrelated work; do not batch status changes at the final response.",
      "Items omitted from update become deleted history. Normal agent flow must not call legacy event-style compatibility actions or list.",
    ],
    parameters: Type.Object(
      {
        action: Type.Literal("update"),
        items: Type.Array(sessionTodoStateSchema, {
          description:
            "Complete desired non-deleted checklist. Existing rows omitted here become deleted history.",
        }),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : undefined;
      const count = Array.isArray(args.items) ? `items=${args.items.length}` : undefined;
      const text = ["todo", action && `action=${action}`, count].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      normalizeSparkTodoAction(params.action);
      return options.handler({ toolCallId, params, signal, onUpdate, ctx });
    },
  });
}

function renderTaskCall(
  toolName: string,
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : undefined;
  const task =
    typeof args.task === "string"
      ? args.task
      : typeof args.taskRef === "string"
        ? args.taskRef
        : undefined;
  const project = typeof args.project === "string" ? args.project : undefined;
  const text = [toolName, action && `action=${action}`, task ?? project].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}

function normalizeSparkTaskReadAction(value: unknown): SparkTaskReadAction {
  if (TASK_READ_ACTIONS.includes(value as SparkTaskReadAction)) return value as SparkTaskReadAction;
  throw new Error(`task_read.action must be one of: ${TASK_READ_ACTIONS.join(", ")}`);
}

function normalizeSparkTaskWriteAction(value: unknown): SparkTaskWriteAction {
  if (TASK_WRITE_ACTIONS.includes(value as SparkTaskWriteAction))
    return value as SparkTaskWriteAction;
  throw new Error(`task_write.action must be one of: ${TASK_WRITE_ACTIONS.join(", ")}`);
}

export function normalizeSparkTodoAction(value: unknown): SparkTodoAction {
  if (TODO_ACTIONS.includes(value as SparkTodoAction)) return value as SparkTodoAction;
  throw new Error(`todo.action must be one of: ${TODO_ACTIONS.join(", ")}`);
}
