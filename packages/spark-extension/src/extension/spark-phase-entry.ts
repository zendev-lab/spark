import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  renderSparkImplementationPhasePrompt,
  renderSparkPhaseVisibleMessage,
  renderSparkPlanningPhasePrompt,
} from "./phase/index.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  saveSparkGraphAndTodos,
  saveSparkPhase,
  type SparkPlanningPhaseSource,
} from "./session-state.ts";
import { sparkActiveLens } from "./spark-phase-state.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkPhaseMessageApi {
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

export interface SparkPhaseEntryDeps {
  queueSparkAgentInstruction: (
    ctx: SparkToolContext,
    instruction: string,
    options?: { goalId?: string },
  ) => void;
  refreshSparkWidget: (cwd: string, ctx?: SparkToolContext) => Promise<void>;
  ensureWorkflowRunManager: (cwd: string, ctx: SparkToolContext) => Promise<void>;
}

export async function dispatchSparkAgentInstruction(
  piApi: SparkPhaseMessageApi,
  _deps: Pick<SparkPhaseEntryDeps, "queueSparkAgentInstruction">,
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
      customType: "spark-phase-request",
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
      details: { visible: visibleMessage },
    },
    idle ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
  );
}

export async function enterSparkPlanningPhase(
  piApi: SparkPhaseMessageApi,
  deps: SparkPhaseEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
  source: SparkPlanningPhaseSource = "auto",
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  const roadmapResult = project ? roadmapPlanningContext(graph, project.ref, focus) : undefined;
  ctx.sparkActiveLens = sparkActiveLens("plan");
  if (project) await saveSparkPhase(ctx.cwd, ctx, { phase: "plan", projectRef: project.ref });
  else {
    await saveSparkPhase(ctx.cwd, ctx, { phase: "plan" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  if (roadmapResult?.mutated) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    "Spark plan phase: investigate, answer, and plan durable work when needed.",
    "info",
  );
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkPlanningPhasePrompt(graph, project?.ref, focus, source, roadmapResult?.context),
    renderSparkPhaseVisibleMessage("plan", project?.title, focus),
  );
}

export async function enterSparkImplementationPhase(
  piApi: SparkPhaseMessageApi,
  deps: SparkPhaseEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  ctx.sparkActiveLens = sparkActiveLens("implement");
  if (project) await saveSparkPhase(ctx.cwd, ctx, { phase: "implement", projectRef: project.ref });
  else {
    await saveSparkPhase(ctx.cwd, ctx, { phase: "implement" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark implement phase: work until the next blocker.", "info");
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkImplementationPhasePrompt(graph, project?.ref, focus),
    renderSparkPhaseVisibleMessage("implement", project?.title, focus),
  );
}
