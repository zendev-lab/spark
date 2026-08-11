import { Type } from "typebox";
import {
  sparkStateCwd,
  type SparkHostContext,
  type ToolConfig,
  type ToolRenderComponent,
  type ToolRenderTheme,
} from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-text";
import { listSavedWorkflows, readSavedWorkflow, type WorkflowDescriptor } from "./index.ts";

export type SparkWorkflowAction = "list" | "read" | "run" | "tick";

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
  /** Product-owned scheduler hook; available only inside a bound daemon Loop. */
  tick?: (ctx: SparkHostContext) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
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

export function registerSparkWorkflowTool(
  pi: SparkWorkflowHostApi,
  deps: SparkWorkflowToolDeps = {},
): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Canonical workflow tool. List, read, or run controlled WORKFLOW.md definitions; a daemon-bound Loop may also advance its active WorkflowRun with tick.",
    promptGuidelines: [
      "Use workflow action=run with a builtin:/workspace:/user: selector; raw JavaScript workflow source is rejected.",
      "Do not pass inline workflow source or arbitrary paths; use builtin:<id>, workspace:<id>, or user:<id> selectors.",
      "Execute workflows through the host's explicit workflow command/runtime, not by evaluating scripts from this tool.",
      "workflow action=tick is internal to a daemon-owned Workflow Loop and is rejected in ordinary turns.",
    ],
    policy: workflowToolPolicy("read", ["plan", "execute", "fleet"]),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" || action === "read"
        ? workflowToolPolicy("read", ["plan", "execute", "fleet"])
        : workflowToolPolicy("external_write", ["plan", "execute"]);
    },
    parameters: Type.Object({
      action: Type.String({ description: "list | read | run | tick" }),
      selector: Type.Optional(
        Type.String({ description: "builtin:<id>, workspace:<id>, or user:<id> for read." }),
      ),
      includeUser: Type.Optional(
        Type.Boolean({ description: "Include user workflows. Defaults to true." }),
      ),
      maxChars: Type.Optional(Type.Number({ description: "For read: script preview max chars." })),
      limit: Type.Optional(
        Type.Number({ description: "For list: maximum workflow rows. Default 20." }),
      ),
      args: Type.Optional(Type.Any({ description: "For run: JSON arguments." })),
      concurrency: Type.Optional(Type.Number({ description: "For run: bounded concurrency." })),
      maxAgents: Type.Optional(Type.Number({ description: "For run: maximum agent calls." })),
      tokenBudget: Type.Optional(Type.Number({ description: "For run: token ceiling." })),
      wait: Type.Optional(Type.Boolean({ description: "For run: wait for terminal result." })),
    }),
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
  if (value === "list" || value === "read" || value === "run" || value === "tick") return value;
  throw new Error("workflow.action must be list, read, run, or tick");
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
