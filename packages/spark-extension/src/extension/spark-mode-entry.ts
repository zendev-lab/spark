import type { TaskGraph } from "@zendev-lab/spark-tasks";
import {
  renderSparkExecuteModePrompt,
  renderSparkModeVisibleMessage,
  renderSparkPlanModePrompt,
} from "./mode/index.ts";
import { roadmapPlanningContext } from "../flows/roadmap-flow.ts";
import {
  clearCurrentProjectRef,
  currentSparkProject,
  saveSparkGraphAndTodos,
  saveSparkMode,
  type SparkPlanningModeSource,
} from "./session-state.ts";
import { sparkActiveMode } from "./spark-mode-state.ts";
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
      customType: "spark-mode-request",
      content: instruction,
      display: false,
      authority: "runtime_control",
      trust: "trusted",
      details: { visible: visibleMessage },
    },
    idle ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
  );
}

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
  ctx.sparkActiveMode = sparkActiveMode("plan");
  if (project) await saveSparkMode(ctx.cwd, ctx, { mode: "plan", projectRef: project.ref });
  else {
    await saveSparkMode(ctx.cwd, ctx, { mode: "plan" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  if (roadmapResult?.mutated) await saveSparkGraphAndTodos(ctx.cwd, graph, ctx);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.(
    "Spark plan mode: investigate, answer, and plan durable work when needed.",
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

export async function enterSparkExecuteMode(
  piApi: SparkModeMessageApi,
  deps: SparkModeEntryDeps,
  ctx: SparkToolContext,
  graph: TaskGraph,
  focus?: string,
): Promise<void> {
  const project = await currentSparkProject(ctx.cwd, ctx, graph);
  ctx.sparkActiveMode = sparkActiveMode("execute");
  if (project) await saveSparkMode(ctx.cwd, ctx, { mode: "execute", projectRef: project.ref });
  else {
    await saveSparkMode(ctx.cwd, ctx, { mode: "execute" });
    await clearCurrentProjectRef(ctx.cwd, ctx);
  }
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  ctx.ui?.notify?.("Spark execute mode: work until the next blocker.", "info");
  await dispatchSparkAgentInstruction(
    piApi,
    deps,
    ctx,
    renderSparkExecuteModePrompt(graph, project?.ref, focus),
    renderSparkModeVisibleMessage("execute", project?.title, focus),
  );
}
