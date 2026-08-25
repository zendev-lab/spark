import { Type } from "typebox";
import {
  sparkStateCwd,
  type SparkHostContext,
  type ToolConfig,
  type ToolRenderComponent,
  type ToolRenderTheme,
} from "@zendev-lab/spark-core";
import { ToolCallText } from "@zendev-lab/spark-text-rendering";
import { listSavedWorkflows, readSavedWorkflow, type WorkflowDescriptor } from "./index.ts";

export type SparkWorkflowAction = "list" | "read" | "run" | "runs" | "tick";

export interface SparkWorkflowHostApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkWorkflowToolDeps {
  /** Product-owned execution adapter. Public callers provide a saved selector, never source. */
  run?: (
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkHostContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
  /** Product-owned WorkflowRun inspection and control adapter. */
  runs?: (
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: SparkHostContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
  /** Product-owned scheduler hook; available only inside a bound daemon Loop. */
  tick?: (ctx: SparkHostContext) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export function registerSparkWorkflowTool(
  pi: SparkWorkflowHostApi,
  deps: SparkWorkflowToolDeps = {},
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Canonical workflow and WorkflowRun capability. List, read, or run controlled WORKFLOW.md definitions; inspect/control runs with action=runs; a daemon-bound Loop may advance its active run with tick.",
    promptGuidelines: [
      "Use workflow action=run with a builtin:/workspace:/user: selector; raw JavaScript workflow source is rejected.",
      "Do not pass inline workflow source or arbitrary paths; use builtin:<id>, workspace:<id>, or user:<id> selectors.",
      "Execute workflows through the host's explicit workflow command/runtime, not by evaluating scripts from this tool.",
      "Use action=runs for WorkflowRun status and lifecycle control. task_read run_status is read-only compatibility inspection.",
      "workflow action=tick is internal to a daemon-owned Workflow Loop and is rejected in ordinary turns.",
    ],
    policy: workflowToolPolicy("read", ["plan", "execute", "fleet"]),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" || action === "read"
        ? workflowToolPolicy("read", ["plan", "execute", "fleet"])
        : workflowToolPolicy("external_write", ["plan", "execute"]);
    },
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("run"),
          Type.Literal("runs"),
          Type.Literal("tick"),
        ]),
        selector: Type.Optional(
          Type.String({ description: "Controlled workflow selector for read/run." }),
        ),
        includeUser: Type.Optional(Type.Boolean()),
        maxChars: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
        args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        concurrency: Type.Optional(Type.Number()),
        maxAgents: Type.Optional(Type.Number()),
        tokenBudget: Type.Optional(Type.Number()),
        wait: Type.Optional(Type.Boolean()),
        runAction: Type.Optional(
          Type.Union([
            Type.Literal("status"),
            Type.Literal("list"),
            Type.Literal("inspect"),
            Type.Literal("kill"),
            Type.Literal("reply"),
            Type.Literal("steer"),
            Type.Literal("reconcile"),
            Type.Literal("ack"),
            Type.Literal("kill_active"),
          ]),
        ),
        runRef: Type.Optional(Type.String()),
        taskRef: Type.Optional(Type.String()),
        projectRef: Type.Optional(Type.String()),
        includeHistory: Type.Optional(Type.Boolean()),
        signal: Type.Optional(Type.String()),
        forceAfterMs: Type.Optional(Type.Number()),
        all: Type.Optional(Type.Boolean()),
        message: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    renderCall(args, theme) {
      return renderWorkflowCall(args, theme);
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = sparkStateCwd(requiredCwd(ctx), ctx);
      const action = normalizeWorkflowAction(params.action);
      if (action === "tick") {
        if (!deps.tick)
          return {
            content: [
              { type: "text" as const, text: "workflow tick is unavailable in this host." },
            ],
            details: { error: "workflow_tick_unavailable" },
            isError: true,
          };
        return await deps.tick(ctx);
      }
      if (action === "run") {
        if (!deps.run) {
          return {
            content: [{ type: "text" as const, text: "workflow run is unavailable in this host." }],
            details: { error: "workflow_run_unavailable" },
            isError: true,
          };
        }
        if ("script" in params || "runRef" in params || "resumeRunRef" in params) {
          throw new Error(
            "workflow action=run accepts only a controlled selector; migrate definitions to .agents/workflows/<id>/WORKFLOW.md",
          );
        }
        const selector = requiredString(params.selector, "selector");
        return await deps.run({ ...params, selector }, signal, onUpdate, ctx);
      }
      if (action === "runs") {
        if (!deps.runs)
          return {
            content: [
              { type: "text" as const, text: "workflow run control is unavailable in this host." },
            ],
            details: { error: "workflow_runs_unavailable" },
            isError: true,
          };
        const { action: _action, runAction, ...rest } = params;
        return await deps.runs({ ...rest, action: runAction ?? "status" }, signal, onUpdate, ctx);
      }
      const includeUser = normalizeBoolean(params.includeUser, true, "includeUser");
      if (action === "list") {
        const listing = await listSavedWorkflows(cwd, { includeUser });
        const limit = normalizePositiveInteger(params.limit, 20, "limit");
        const visible = listing.workflows.slice(0, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: renderWorkflowList(visible, listing.workflows.length),
            },
          ],
          details: {
            count: listing.workflows.length,
            shown: visible.length,
            workflows: visible,
          } as unknown as Record<string, unknown>,
        };
      }
      const selector = requiredString(params.selector, "selector");
      const maxChars = normalizePositiveInteger(params.maxChars, 4_000, "maxChars");
      const { descriptor, script } = await readSavedWorkflow({ cwd, selector, includeUser });
      const body = truncate(script, maxChars);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${descriptor.selector}: ${descriptor.title}`,
              descriptor.description,
              "",
              body,
            ].join("\n"),
          },
        ],
        details: {
          descriptor,
          scriptChars: script.length,
          shownChars: body.length,
          truncated: body.length < script.length,
        },
      };
    },
  });
}

export default function piWorkflowExtension(pi: SparkWorkflowHostApi): void {
  registerSparkWorkflowTool(pi);
}

function renderWorkflowList(workflows: WorkflowDescriptor[], total: number): string {
  if (total === 0) return "No saved workflows found.";
  const lines = [
    `Workflows: ${total}${workflows.length < total ? ` (showing ${workflows.length})` : ""}`,
    ...workflows.map(
      (workflow) =>
        `- ${workflow.selector}: ${workflow.title} (${workflow.stages.length} stage(s))`,
    ),
  ];
  if (workflows.length < total)
    lines.push(
      `- … ${total - workflows.length} more workflow(s); increase limit for a larger bounded sample.`,
    );
  return lines.join("\n");
}

function workflowToolPolicy(
  effect: "read" | "external_write",
  modes: readonly string[],
): NonNullable<ToolConfig["policy"]> {
  return {
    effect,
    executionMode: effect === "read" ? "parallel" : "sequential",
    domains: ["workflows"],
    modes,
    approval: "none",
  };
}

function normalizeWorkflowAction(value: unknown): SparkWorkflowAction {
  if (
    value === "list" ||
    value === "read" ||
    value === "run" ||
    value === "runs" ||
    value === "tick"
  )
    return value;
  throw new Error("workflow.action must be list, read, run, runs, or tick");
}

function normalizeBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`workflow.${field} must be a boolean`);
  return value;
}

function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`workflow.${field} must be a positive integer`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`workflow.${field} is required`);
  return value;
}

function requiredCwd(ctx: unknown): string {
  const cwd =
    typeof (ctx as { cwd?: unknown })?.cwd === "string" ? (ctx as { cwd: string }).cwd : "";
  if (!cwd.trim()) throw new Error("workflow requires ctx.cwd");
  return cwd;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function renderWorkflowCall(
  args: Record<string, unknown>,
  theme: ToolRenderTheme,
): ToolRenderComponent {
  const action = typeof args.action === "string" ? args.action : "?";
  const selector = typeof args.selector === "string" ? args.selector : undefined;
  const text = ["workflow", `action=${action}`, selector].filter(Boolean).join(" ");
  return new ToolCallText(theme.bold ? theme.bold(text) : text);
}
