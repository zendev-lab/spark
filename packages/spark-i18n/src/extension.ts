import {
  detectSparkLanguage,
  languageToLocale,
  message,
  normalizeSparkLanguage as normalizeSharedSparkLanguage,
  type SparkLanguage,
} from "./index.ts";

export type { SparkLanguage } from "./index.ts";

export interface SparkProjectLike {
  outputLanguage?: unknown;
}

export interface SparkGoalLike {
  objective: string;
  pauseReason?: string | null;
  completedReason?: string | null;
}

export const DEFAULT_SPARK_LANGUAGE: SparkLanguage = "en";

export interface SparkLanguageContext {
  project?: SparkProjectLike;
  goal?: SparkGoalLike | null;
  fallbackText?: string;
  fallback?: SparkLanguage;
}

export function sparkLanguageForProject(input: SparkLanguageContext): SparkLanguage {
  const projectLanguage = normalizeSparkLanguage(input.project?.outputLanguage);
  if (projectLanguage) return projectLanguage;
  if (input.goal) {
    const goalSamples = [
      input.goal.objective,
      input.goal.pauseReason ?? "",
      input.goal.completedReason ?? "",
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n");
    if (goalSamples) return detectSparkLanguage(goalSamples);
  }
  if (input.fallbackText) return detectSparkLanguage(input.fallbackText);
  return input.fallback ?? DEFAULT_SPARK_LANGUAGE;
}

export function normalizeSparkLanguage(value: unknown): SparkLanguage | undefined {
  return normalizeSharedSparkLanguage(value);
}

export interface GoalNotificationStrings {
  active: (objective: string, projectLabel: string) => string;
  continuing: (objective: string, projectLabel: string) => string;
  paused: (objective: string) => string;
  pauseBlocked: (objective: string) => string;
  pauseAfterAbort: (failure: string) => string;
  noActiveGoal: string;
  inferDispatched: string;
  noSessionGoal: string;
  staleClearedFor: (projectTitle: string) => string;
  staleReplaced: string;
  goalContinuingHeader: (objective: string, projectLabel: string) => string;
  goalActiveHeader: (objective: string, projectLabel: string) => string;
  goalTickHeader: (objective: string, projectLabel: string) => string;
}

const ACTIVE_LABEL: Record<SparkLanguage, string> = {
  en: message("goal_active", languageToLocale("en")),
  zh: message("goal_active", languageToLocale("zh")),
};

const CONTINUING_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal continuing",
  zh: "Spark 目标继续推进",
};

const PAUSED_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal paused",
  zh: "Spark 目标已暂停",
};

const PAUSE_BLOCKED_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal pause blocked by reviewer",
  zh: "Spark 目标暂停被 reviewer 拒绝",
};

const TICK_LABEL: Record<SparkLanguage, string> = {
  en: "Spark goal tick",
  zh: "Spark 目标节拍",
};

const NOTIFICATIONS: Record<SparkLanguage, GoalNotificationStrings> = {
  en: {
    active: (objective, label) => `${ACTIVE_LABEL.en}${label} · goal: ${objective}`,
    continuing: (objective, label) => `${CONTINUING_LABEL.en}${label} · ${objective}`,
    paused: (objective) => `${PAUSED_LABEL.en} · goal: ${objective}`,
    pauseBlocked: (objective) => `${PAUSE_BLOCKED_LABEL.en} · goal: ${objective}`,
    pauseAfterAbort: (failure) =>
      `Spark goal paused after manual abort; resume with /goal when ready: ${failure}`,
    noActiveGoal: "Spark has no active goal; main agent will infer one from the current context.",
    inferDispatched: "Spark goal needs to be set; agent will infer it now.",
    noSessionGoal: message("goal_not_set", languageToLocale("en")),
    staleClearedFor: (title) => `Cleared stale Spark goal for completed project: ${title}`,
    staleReplaced: "Spark goal replaced a stale completed-project goal with the new objective.",
    goalContinuingHeader: (objective, label) => `${CONTINUING_LABEL.en}${label} · ${objective}`,
    goalActiveHeader: (objective, label) => `${ACTIVE_LABEL.en}${label} · goal: ${objective}`,
    goalTickHeader: (objective, label) => `${TICK_LABEL.en}${label} · goal: ${objective}`,
  },
  zh: {
    active: (objective, label) => `${ACTIVE_LABEL.zh}${label} · 目标：${objective}`,
    continuing: (objective, label) => `${CONTINUING_LABEL.zh}${label} · ${objective}`,
    paused: (objective) => `${PAUSED_LABEL.zh} · 目标：${objective}`,
    pauseBlocked: (objective) => `${PAUSE_BLOCKED_LABEL.zh} · 目标：${objective}`,
    pauseAfterAbort: (failure) => `Spark 目标因手动中止而暂停，准备好后用 /goal 继续：${failure}`,
    noActiveGoal: "Spark 当前没有活动目标；主 agent 会基于当前上下文自行推断。",
    inferDispatched: "需要设置 Spark 目标；agent 现在会自行推断。",
    noSessionGoal: message("goal_not_set", languageToLocale("zh")),
    staleClearedFor: (title) => `清理已完成项目的过期 Spark 目标：${title}`,
    staleReplaced: "Spark 目标已用新目标替换原先与已完成项目绑定的过期目标。",
    goalContinuingHeader: (objective, label) => `${CONTINUING_LABEL.zh}${label} · ${objective}`,
    goalActiveHeader: (objective, label) => `${ACTIVE_LABEL.zh}${label} · 目标：${objective}`,
    goalTickHeader: (objective, label) => `${TICK_LABEL.zh}${label} · 目标：${objective}`,
  },
};

export function goalNotifications(language: SparkLanguage): GoalNotificationStrings {
  return NOTIFICATIONS[language];
}
