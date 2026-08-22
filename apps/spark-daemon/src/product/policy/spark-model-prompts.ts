import type { SparkLanguage } from "./spark-i18n.ts";

export interface GoalInstructionStrings {
  goalActiveHeader: string;
  currentProject: (projectTitle: string) => string;
  goalLine: (objective: string) => string;
  loopTickHeader: string;
  loopModeDecisionContract: string;
  loopReviewerOwnership: string;
  emptyGoalNotSet: string;
  emptyGoalReadContext: string;
  emptyGoalWriteHint: string;
  emptyGoalNoCounts: string;
  notSetVisible: string;
  pauseLineForeground: string;
}

const GOAL_INSTRUCTIONS: GoalInstructionStrings = {
  goalActiveHeader: "Spark session goal is active.",
  currentProject: (title) => `Current project: ${title}`,
  goalLine: (objective) => `Goal: ${objective}`,
  loopTickHeader: "Spark foreground goal loop tick.",
  loopModeDecisionContract:
    "Goal driver requirements: use the objective, current project/task state, blockers, and validation needs to choose concrete next actions. Respect the standing Spark intent, authority, and delegation policy; Goal grants only the bounded manual_only operations declared by tool owners and does not redefine other boundaries. When a missing user decision or required authorization blocks progress, ask the exact question required instead of guessing.",
  loopReviewerOwnership:
    "Goal owns autonomous continuation and reviewer-gated completion. Continue substantive in-scope work until the objective is satisfied, a material user decision is required, or a real blocker prevents progress. The reviewer audits completion evidence but never substitutes for user authorization.",
  emptyGoalNotSet: "Spark session goal is not set.",
  emptyGoalReadContext:
    "Read the Spark project/task context below and choose one concrete, stable session goal. Default to the substantive project outcome described by the project purpose, description, or title; use planning-only or readiness-only wording only when the user explicitly requested that scope.",
  emptyGoalWriteHint:
    'Write it with goal({ action: "set", objective: "<one short stable line describing the intended project outcome, not task counts>" }).',
  emptyGoalNoCounts:
    "Do not include task counts or ready-frontier text inside the objective; those are recomputed each tick.",
  notSetVisible: "Spark goal needs to be set; agent will infer it now.",
  pauseLineForeground:
    "Spark foreground goal continuation runs on idle ticks; goal completion is reviewer-gated.",
};

export function goalInstructions(): GoalInstructionStrings {
  return GOAL_INSTRUCTIONS;
}

export interface GoalContextStrings {
  notInitialized: string;
  currentProjectLine: (title: string) => string;
  unfinishedReadyLine: (unfinished: number, ready: number) => string;
  readyFrontierLine: (titles: string[]) => string;
  noActiveProject: (count: number) => string;
  activeProjectCandidates: (titles: string[]) => string;
  projectStatus: (unfinished: number, ready: number, frontier: string[]) => string;
}

const GOAL_CONTEXT: GoalContextStrings = {
  notInitialized: "Spark project state: not initialized.",
  currentProjectLine: (title) => `Current project: ${title}.`,
  unfinishedReadyLine: (unfinished, ready) =>
    `Unfinished tasks: ${unfinished}. Ready tasks: ${ready}.`,
  readyFrontierLine: (titles) => `Ready frontier: ${titles.join("; ")}.`,
  noActiveProject: (count) => `Current project: none. Total projects: ${count}.`,
  activeProjectCandidates: (titles) => `Project candidates: ${titles.join("; ")}.`,
  projectStatus: (unfinished, ready, frontier) => {
    const tail = frontier.length > 0 ? ` Ready frontier: ${frontier.join("; ")}.` : "";
    return `Project status: unfinished=${unfinished}, ready=${ready}.${tail}`;
  },
};

export function goalContextStrings(): GoalContextStrings {
  return GOAL_CONTEXT;
}

export interface ActiveSparkContextStrings {
  header: string;
  noProjectHeader: string;
  noProjectGuidance: string;
  currentProjectLine: (title: string, ref: string) => string;
  taskCountsLine: (input: {
    unfinished: number;
    claimed: number;
    sessionClaimed: number;
    total: number;
  }) => string;
  goalLine: (input: { status: string; objective: string; reason?: string }) => string;
  myClaimedTaskLine: (input: {
    status: string;
    name: string;
    title: string;
    ref: string;
    activeTodos: number;
  }) => string;
  myClaimedTodosHidden: (hidden: number) => string;
  hiddenSessionClaimed: (hidden: number) => string;
  projectsCountsLine: (total: number) => string;
  durableStateHint: string;
  sparkMdHeader: string;
  sparkMdReadFull: string;
}

const ACTIVE_SPARK_CONTEXT: ActiveSparkContextStrings = {
  header: "Spark context:",
  noProjectHeader: "Spark available: no project selected for this session.",
  noProjectGuidance:
    '- Use task_write({ action: "project_use" }) to select or create a current project before planning, claiming, or updating project-bound tasks.',
  currentProjectLine: (title, ref) => `- Current project: ${title} (${ref})`,
  taskCountsLine: ({ unfinished, claimed, sessionClaimed, total }) =>
    `- Unfinished tasks: ${unfinished} / claimed: ${claimed} / current_session_claimed: ${sessionClaimed} (${total} total)`,
  goalLine: ({ status, objective, reason }) => {
    const reasonText = reason ? `; reason: ${reason}` : "";
    return `- Session goal: ${status}; ${objective}${reasonText}`;
  },
  myClaimedTaskLine: ({ status, name, title, ref, activeTodos }) => {
    const todoSuffix = activeTodos > 0 ? `; ${activeTodos} active TODOs` : "";
    return `- My claimed task: [${status}] @${name}: ${title} (${ref})${todoSuffix}`;
  },
  myClaimedTodosHidden: (hidden) => `  - … ${hidden} more active TODOs`,
  hiddenSessionClaimed: (hidden) =>
    `- … ${hidden} more claimed task(s); use task_read({ action: "project_status" }) for details`,
  projectsCountsLine: (total) => `- Projects: ${total} total`,
  durableStateHint:
    '- Durable state is authoritative; compact summaries/history are hints. Verify with task_read({ action: "project_status" }) or task_read({ action: "workspace_status" }) before changing project/task/goal state.',
  sparkMdHeader: "SPARK.md (intent excerpt):",
  sparkMdReadFull: "… (read SPARK.md for full intent)",
};

export function activeSparkContextStrings(): ActiveSparkContextStrings {
  return ACTIVE_SPARK_CONTEXT;
}

export interface SparkProductToolCopy {
  label?: string;
  description: string;
  promptGuidelines?: string[];
}

const SPARK_PRODUCT_TOOL_COPY: Record<string, Partial<SparkProductToolCopy>> = {
  impl_ask: {
    label: "Spark Ask",
    description:
      "Ask the user a structured multi-question clarification, decision, approval, or unblock form and persist the answer as an artifact.",
  },
  impl_ask_replay: { label: "Spark Ask Replay" },
  drive: { label: "Spark Drive" },
  goal: { label: "Spark Goal" },
  loop: { label: "Spark Loop" },
  workflow_run: {
    label: "Workflow Run",
    description:
      "Execute a generated or saved JavaScript workflow through Spark workflow runtime primitives. Use for explicit dynamic workflow/fan-out requests after the script has metadata and clear stages.",
  },
  impl_workflow_runs: { label: "Spark Workflow Runs" },
  impl_status: { label: "Spark Status" },
  impl_state: { label: "Spark State" },
  impl_claim_task: { label: "Spark Claim Task" },
  impl_plan_tasks: { label: "Spark Plan Tasks" },
  impl_finish_task: { label: "Spark Finish Task" },
  impl_todo: { label: "Spark Session TODOs" },
  impl_update_task_plan_items: { label: "Spark Update Task plan items" },
  impl_run_ready_tasks: { label: "Spark Run Ready Tasks" },
  impl_recover_task_claim: { label: "Spark Recover Task Claim" },
  impl_release_task_claim: { label: "Spark Release Task Claim" },
  impl_list_projects: { label: "Spark List Projects" },
  impl_project_mutation: { label: "Spark Project Mutation" },
  impl_use_project: { label: "Spark Use Project" },
};

export function sparkProductToolCopy(
  toolName: string,
  fallback: SparkProductToolCopy,
): SparkProductToolCopy {
  const override = SPARK_PRODUCT_TOOL_COPY[toolName];
  return {
    ...fallback,
    ...override,
    promptGuidelines: override?.promptGuidelines ?? fallback.promptGuidelines,
  };
}

export const sparkProductContextProviderStrings = {
  label: "Spark context",
  description: "Bounded Spark project/task/TODO/SPARK.md context.",
} as const;

export function sparkSystemPromptLanguageDirective(language: SparkLanguage): string {
  return language === "zh"
    ? "User-facing output language: Chinese."
    : "User-facing output language: English.";
}
