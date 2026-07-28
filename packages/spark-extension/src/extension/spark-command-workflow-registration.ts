import { listBuiltinWorkflows } from "@zendev-lab/spark-workflows";
import { parseWorkflowCommandArgs } from "./spark-command-parser-utils.ts";
import type { SparkWorkflowNavigatorAction } from "./spark-workflow-driver-entry.ts";
import type { SparkCommandApi, SparkCommandContext } from "./spark-command-types.ts";

const WORKFLOW_CONTROL_ACTIONS = [
  "inspect",
  "pause",
  "resume",
  "stop",
  "restart",
  "save",
  "ack",
] as const satisfies readonly SparkWorkflowNavigatorAction[];

const WORKFLOW_ACTIONS = [
  { value: "run", description: "run a saved workflow" },
  { value: "list", description: "open the workflow picker" },
  { value: "runs", description: "show workflow runs" },
  ...WORKFLOW_CONTROL_ACTIONS.map((value) => ({
    value,
    description: `${value} a workflow run`,
  })),
] as const;

export interface SparkWorkflowCommandHandlers {
  handleSparkWorkflowCommand: (
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    parsed: { selector?: string; focus: string; forceNavigator?: boolean },
  ) => Promise<void>;
  handleSparkUltracodeCommand: (
    piApi: SparkCommandApi,
    ctx: SparkCommandContext,
    focus: string,
  ) => Promise<void>;
  handleSparkDynamicWorkflowDashboardCommand: (
    ctx: SparkCommandContext,
    args: string,
    commandLabel?: string,
  ) => Promise<void>;
  handleSparkDynamicWorkflowActionCommand: (
    ctx: SparkCommandContext,
    action: SparkWorkflowNavigatorAction,
    args: string,
    commandLabel?: string,
  ) => Promise<void>;
}

export function registerSparkWorkflowCommands(
  pi: SparkCommandApi,
  handlers: SparkWorkflowCommandHandlers,
): void {
  pi.registerCommand("workflow", {
    description: "Run or manage saved workflows; empty /workflow opens the workflow picker.",
    argumentHint:
      "[run <selector> [focus] | list [focus] | runs [runRef] | <inspect|pause|resume|stop|restart|save|ack> <runRef>]",
    getArgumentCompletions: (prefix) => workflowActionCompletions(prefix),
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["start", "list", "inspect", "pause", "resume", "stop", "restart", "save", "ack"],
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      const [action = "", ...restParts] = trimmed.split(/\s+/u);
      const rest = restParts.join(" ").trim();
      if (action === "list") {
        await handlers.handleSparkWorkflowCommand(pi, ctx, {
          focus: rest,
          forceNavigator: true,
        });
        return;
      }
      if (action === "runs") {
        await handlers.handleSparkDynamicWorkflowDashboardCommand(ctx, rest, "workflow runs");
        return;
      }
      if (isWorkflowControlAction(action)) {
        await handlers.handleSparkDynamicWorkflowActionCommand(
          ctx,
          action,
          rest,
          `workflow ${action}`,
        );
        return;
      }
      if (action === "run") {
        const parsed = parseWorkflowCommandArgs(normalizeWorkflowRunArgs(rest));
        await handlers.handleSparkWorkflowCommand(pi, ctx, parsed);
        return;
      }
      const parsed = parseWorkflowCommandArgs(trimmed);
      await handlers.handleSparkWorkflowCommand(pi, ctx, parsed);
    },
  });

  pi.registerCommand("workflows", {
    description:
      "Open the Spark workflow dashboard/navigator without requiring project state; shows dynamic runs and explicit controls.",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["list"],
      deprecatedAliasFor: "/workflow list",
    },
    async handler(args, ctx) {
      await handlers.handleSparkWorkflowCommand(pi, ctx, {
        focus: args.trim(),
        forceNavigator: true,
      });
    },
  });

  pi.registerCommand("workflow-runs", {
    description: "Show the live dynamic workflow run dashboard. Usage: /workflow-runs [runRef].",
    argumentHint: "[runRef]",
    metadata: {
      source: "extension",
      extensionId: "spark-workflow",
      plane: "daemon",
      resource: "workflow",
      verbs: ["list"],
      deprecatedAliasFor: "/workflow runs [runRef]",
    },
    async handler(args, ctx) {
      await handlers.handleSparkDynamicWorkflowDashboardCommand(ctx, args.trim());
    },
  });

  for (const action of ["inspect", "pause", "resume", "stop", "restart", "save", "ack"] as const) {
    pi.registerCommand(`workflow-${action}`, {
      description: `Dynamic workflow ${action}. Usage: /workflow-${action} <runRef>.`,
      argumentHint: "<runRef>",
      metadata: {
        source: "extension",
        extensionId: "spark-workflow",
        plane: "daemon",
        resource: "workflow",
        verbs: [action],
        deprecatedAliasFor: `/workflow ${action} <runRef>`,
      },
      async handler(args, ctx) {
        await handlers.handleSparkDynamicWorkflowActionCommand(
          ctx,
          action,
          args.trim(),
          `workflow-${action}`,
        );
      },
    });
  }

  pi.registerCommand("ultracode", {
    description:
      "Opt into high-effort dynamic workflow generation and execution through workflow_run.",
    async handler(args, ctx) {
      await handlers.handleSparkUltracodeCommand(pi, ctx, args.trim());
    },
  });

  for (const workflow of listBuiltinWorkflows()) {
    pi.registerCommand("workflow:" + workflow.id, {
      description: `Enter Spark builtin workflow ${workflow.id}.`,
      metadata: {
        source: "extension",
        extensionId: "spark-workflow",
        plane: "daemon",
        resource: "workflow",
        verbs: ["start"],
        deprecatedAliasFor: `/workflow run builtin:${workflow.id}`,
      },
      async handler(args, ctx) {
        await handlers.handleSparkWorkflowCommand(pi, ctx, {
          selector: "builtin:" + workflow.id,
          focus: args.trim(),
        });
      },
    });
  }
}

function isWorkflowControlAction(value: string): value is SparkWorkflowNavigatorAction {
  return WORKFLOW_CONTROL_ACTIONS.some((action) => action === value);
}

function normalizeWorkflowRunArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";
  const [candidate = "", ...focusParts] = trimmed.split(/\s+/u);
  const builtinIds = new Set(listBuiltinWorkflows().map((workflow) => workflow.id));
  if (!builtinIds.has(candidate)) return trimmed;
  const focus = focusParts.join(" ").trim();
  return `builtin:${candidate}${focus ? ` ${focus}` : ""}`;
}

function workflowActionCompletions(
  prefix: string,
): Array<{ value: string; label: string; description?: string }> | null {
  const normalized = prefix.trimStart();
  if (normalized.startsWith("run ")) {
    const selectorPrefix = normalized.slice("run ".length);
    if (selectorPrefix.includes(" ")) return null;
    return listBuiltinWorkflows()
      .map((workflow) => ({
        value: `run builtin:${workflow.id}`,
        label: `run builtin:${workflow.id}`,
        description: workflow.description,
      }))
      .filter((entry) => entry.value.startsWith(normalized));
  }
  if (normalized.includes(" ")) return null;
  return WORKFLOW_ACTIONS.filter((entry) => entry.value.startsWith(normalized)).map((entry) => ({
    value: entry.value,
    label: entry.value,
    description: entry.description,
  }));
}
