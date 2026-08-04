import { detectCopyLanguage, type CopyLanguage } from "@zendev-lab/spark-core";
import type { ProjectRef } from "@zendev-lab/spark-core";
import type { TaskGraph } from "@zendev-lab/spark-tasks";
import type { SparkEntryResolution } from "./spark-entry.ts";
import { titleFromIdea, type SparkInitClarificationData } from "./spark-md-rendering.ts";
import { initializeSparkIdea } from "./spark-initialization.ts";
import {
  loadSparkGraph,
  saveCurrentProjectRef,
  sparkStateCwd,
  type SparkPlanningPhaseSource,
} from "./session-state.ts";
import {
  enterSparkImplementationPhase,
  enterSparkPlanningPhase,
  type SparkPhaseEntryDeps,
  type SparkPhaseMessageApi,
} from "./spark-phase-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";

export interface SparkEntryApplicationDeps extends SparkPhaseEntryDeps {}

export async function applySparkEntryResolution(
  piApi: SparkPhaseMessageApi,
  deps: SparkEntryApplicationDeps,
  ctx: SparkToolContext,
  graph: TaskGraph | null,
  resolution: SparkEntryResolution,
): Promise<void> {
  switch (resolution.action) {
    case "initialize_new_project":
      await startSparkNewProject(piApi, deps, ctx, resolution.idea, {
        enterPhase: resolution.enterPlanning ? "plan" : undefined,
        planningSource: resolution.planningSource,
        materializeSparkMd: true,
      });
      return;
    case "initialize_existing_project":
      await startSparkNewProject(piApi, deps, ctx, resolution.idea, {
        enterPhase: "plan",
        planningSource: resolution.planningSource,
        materializeSparkMd: resolution.planningSource !== "direct",
      });
      return;
    case "enter_phase": {
      if (!graph) {
        ctx.ui?.notify?.("Spark phase needs initialized Spark state.", "warning");
        return;
      }
      if (resolution.phase === "plan")
        await enterSparkPlanningPhase(
          piApi,
          deps,
          ctx,
          graph,
          resolution.focus,
          resolution.planningSource,
        );
      else await enterSparkImplementationPhase(piApi, deps, ctx, graph, resolution.focus);
      return;
    }
    case "blocked":
      ctx.ui?.notify?.(resolution.message, "warning");
      return;
    case "none":
      return;
  }
}

async function startSparkNewProject(
  piApi: SparkPhaseMessageApi,
  deps: SparkEntryApplicationDeps,
  ctx: SparkToolContext,
  idea: string,
  options: {
    enterPhase?: "plan";
    planningSource?: SparkPlanningPhaseSource;
    materializeSparkMd?: boolean;
  } = {},
): Promise<void> {
  const existing = await loadSparkGraph(ctx.cwd, ctx);
  if (existing) {
    await deps.refreshSparkWidget(ctx.cwd, ctx);
    if (options.enterPhase === "plan")
      await enterSparkPlanningPhase(piApi, deps, ctx, existing, idea, options.planningSource);
    return;
  }

  const language = detectCopyLanguage(idea);
  const workingTitle = titleFromIdea(idea);
  const outputLanguage: CopyLanguage = language;
  const clarification = {
    workingTitle,
    outputLanguage,
    objective: idea,
    nextAction: "analyze_then_targeted_ask",
  } satisfies SparkInitClarificationData;

  const result = await initializeSparkIdea(sparkStateCwd(ctx.cwd, ctx), idea, {
    projectTitle: clarification.workingTitle,
    outputLanguage: clarification.outputLanguage,
    clarification,
    materializeSparkMd: options.materializeSparkMd,
  });

  await saveCurrentProjectRef(ctx.cwd, ctx, result.projectRef as ProjectRef);
  await deps.refreshSparkWidget(ctx.cwd, ctx);
  await deps.ensureWorkflowRunManager(ctx.cwd, ctx);

  if (options.enterPhase === "plan") {
    const graph = await loadSparkGraph(ctx.cwd, ctx);
    if (graph) await enterSparkPlanningPhase(piApi, deps, ctx, graph, idea, options.planningSource);
  }
}
