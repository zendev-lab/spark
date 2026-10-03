import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  renderSparkExecuteModePrompt,
  renderSparkFleetModePrompt,
  renderSparkModeVisibleMessage,
  renderSparkPlanModePrompt,
} from "./spark-directive-prompts.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  currentSparkProject,
  saveSparkGraphAndTodos,
  type SparkPlanningModeSource,
} from "./session-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkModeMessageApi {
  isIdle?(): boolean;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
      authority?: "runtime_control" | "runtime_data";
      trust?: "trusted" | "untrusted";
    },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
  ): void;
  sendUserMessage?(
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp" | "nextTurn";
      streamingBehavior?: "steer" | "followUp";
    },
  ): void;
}

export interface SparkModeEntryDeps {
  queueSparkAgentInstruction: (
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ) => void;
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => Promise<void>;
}

export async function dispatchSparkAgentInstruction(
  piApi: SparkModeMessageApi,
  _deps: Pick<SparkModeEntryDeps, "queueSparkAgentInstruction">,
  ctx: SparkToolContext,
  instruction: string,
  visibleMessage: string,
): Promise<void> {
  if (ctx.sendUserMessage) {
    await ctx.sendUserMessage(instruction);
    return;
  }
  const idle = piApi.isIdle?.() ?? false;
  piApi.sendMessage(
    {
      customType: "spark-directive-request",
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
      details: { visible: visibleMessage },
    },
    idle ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
  );
}

/**
 * One-shot `/plan [focus]` command: inject planning guidance into the current
 * invocation only. Nothing is persisted and no tool, sandbox, approval, or
 * admission boundary changes; the next plain turn is neutral again.
 */
export async function enterSparkPlanMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  source: SparkPlanningModeSource = "auto",
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const roadmapResult = project ? roadmapPlanningContext(graph, project.ref, focus) : undefined;
  if (roadmapResult?.mutated) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    "Spark /plan: this turn investigates, answers, and plans durable work when needed.",
    "info",
  );
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkPlanModePrompt(graph, project?.ref, focus, source, roadmapResult?.context),
    renderSparkModeVisibleMessage("plan", project?.title, focus),
  );
}

/** One-shot `/execute [focus]` command: execution guidance for this turn only. */
export async function enterSparkExecuteMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark /execute: this turn works until the next blocker.", "info");
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkExecuteModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("execute", project?.title, focus),
  );
}

/** One-shot `/fleet [focus]` command: fleet-coordination guidance for this turn only. */
export async function enterSparkFleetMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark /fleet: this turn coordinates isolated task workers.", "info");
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkFleetModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("fleet", project?.title, focus),
  );
}
