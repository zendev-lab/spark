import { defaultTaskGraphStore, type TaskGraph } from "@zendev-lab/spark-tasks";
import { renderActiveSparkContext } from "./spark-active-context.ts";
import { ensureLocalSparkDirectory, readActiveSparkMd } from "./spark-activation.ts";
import { ensureSparkGraphInvariants } from "./spark-graph-invariants.ts";
import {
  currentSparkProject,
  loadSparkGraph,
  saveSparkGraphAndTodos,
  sparkStateCwd,
  type SparkSessionContext,
} from "./session-state.ts";
import { loadSessionGoal } from "./spark-session-goals.ts";
import { sparkLanguageForProject, type SparkLanguage } from "./spark-i18n.ts";
import { sparkSystemPromptLanguageDirective } from "./spark-model-prompts.ts";
import { renderBaseSystemPromptsCatalogPrompt } from "@zendev-lab/spark-roles/builtin-skills";
import type { SparkModeEntryDeps, SparkModeMessageApi } from "./spark-mode-entry.ts";
import type { SparkToolContext } from "./spark-tool-registration.ts";
import { sparkTaskClaimSessionKey } from "./task-claim-selection.ts";

interface SparkInputEvent {
  text: string;
  source?: string;
}

export interface SparkInputModeRouter {
  piApi: SparkModeMessageApi;
  deps: SparkModeEntryDeps;
}

export async function handleSparkInput(
  event: unknown,
  _ctx: SparkToolContext,
  _router?: SparkInputModeRouter,
): Promise<unknown> {
  if (!isSparkInputEvent(event)) return { action: "continue" };
  if (event.source === "extension") return { action: "continue" };
  const text = event.text.trim();
  if (!text || text.startsWith("/")) return { action: "continue" };
  return { action: "continue" };
}

export async function injectSparkHints(event: unknown, ctx: SparkToolContext): Promise<unknown> {
  // Spark is always available: inject the standing neutral prompt even when no
  // local .spark/ state exists yet. The richer active-context block is only
  // appended once a task graph is present.
  const graph = await ensureSparkStateForActiveWorkspace(ctx.cwd, ctx);
  const summary = graph ? await renderActiveSparkContextWithLanguage(ctx.cwd, ctx) : undefined;
  const sparkPrompt = renderSparkActiveSystemPrompt(eventSystemPrompt(event), summary?.language);
  const builtinSkillsPrompt = await renderBaseSystemPromptsCatalogPrompt();
  const sections = [sparkPrompt, builtinSkillsPrompt, summary?.content].filter(
    (section): section is string => Boolean(section),
  );
  return { systemPrompt: sections.join("\n\n") };
}

export interface ActiveSparkContextSummary {
  content: string;
  language: SparkLanguage;
}

async function renderActiveSparkContextWithLanguage(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<ActiveSparkContextSummary | undefined> {
  const stateCwd = sparkStateCwd(cwd, ctx);
  const graph = await loadSparkGraph(cwd, ctx);
  if (!graph) return undefined;
  const store = defaultTaskGraphStore(stateCwd, ctx);
  if (ensureSparkGraphInvariants(graph)) await saveSparkGraphAndTodos(cwd, graph, ctx, store);
  const sparkMd = await readActiveSparkMd(stateCwd);
  const project = await currentSparkProject(cwd, ctx, graph);
  const sessionKey = sparkTaskClaimSessionKey(ctx);
  const sessionGoal = await loadSessionGoal(cwd, ctx);
  const language = sparkLanguageForProject({
    project,
    goal: sessionGoal,
    fallbackText: sparkMd,
  });
  const content = renderActiveSparkContext({
    graph,
    project,
    sessionKey,
    sessionGoal,
    sparkMd,
  });
  if (!content) return undefined;
  return { content, language };
}

export async function renderActiveSparkContextSummary(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<string | undefined> {
  return (await renderActiveSparkContextWithLanguage(cwd, ctx))?.content;
}

export async function ensureSparkStateForActiveWorkspace(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<TaskGraph | null> {
  await ensureLocalSparkDirectory(cwd, ctx);
  return loadSparkGraph(cwd, ctx);
}

export function renderSparkActiveSystemPrompt(
  basePrompt: string,
  language?: SparkLanguage,
): string {
  const languageDirective = language ? sparkSystemPromptLanguageDirective(language) : undefined;
  return [basePrompt, languageDirective]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

function isSparkInputEvent(event: unknown): event is SparkInputEvent {
  return Boolean(
    event && typeof event === "object" && typeof (event as { text?: unknown }).text === "string",
  );
}

function eventSystemPrompt(event: unknown): string {
  return event &&
    typeof event === "object" &&
    typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
    ? (event as { systemPrompt: string }).systemPrompt
    : "";
}
