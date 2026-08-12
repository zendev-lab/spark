import type { SparkModelRef } from "@zendev-lab/spark-protocol/daemon";
import type { SparkSessionView } from "@zendev-lab/spark-protocol/presentation";

export {
  describeSessionStatus,
  formatCompactTokenCount,
  formatContextUsage,
  formatSessionCost,
  formatSessionStatusPercent,
} from "@zendev-lab/spark-ui/conversation";
export type {
  SessionStatusBarLabels,
  SessionStatusSnapshot,
} from "@zendev-lab/spark-ui/conversation";

export interface SessionStatusUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextTokenSource?: "reported" | "tokenizer" | "estimated";
  contextWindow?: number;
}

export interface SessionStatusIdentityInput {
  sessionModel?: SparkModelRef;
  defaultModel?: SparkModelRef;
  sessionThinkingLevel?: string;
}

/** Prefer session-scoped control truth, then the canonical session snapshot, over global defaults. */
export function sessionStatusIdentity(
  session: SparkSessionView | null,
  control: SessionStatusIdentityInput,
): { model?: SparkModelRef; thinkingLevel?: string } {
  const model = control.sessionModel ?? session?.model ?? control.defaultModel;
  const thinkingLevel = control.sessionThinkingLevel ?? session?.thinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/** Project the daemon-owned session lifetime snapshot without double-counting run totals. */
export function sessionStatusUsage(
  session: SparkSessionView | null,
  contextWindow?: number,
): SessionStatusUsage {
  const baseline = session?.usage;
  const hasBaselineTotals = Boolean(
    baseline &&
    (baseline.inputTokens !== undefined ||
      baseline.outputTokens !== undefined ||
      baseline.cacheReadTokens !== undefined ||
      baseline.cacheWriteTokens !== undefined ||
      baseline.costUsd !== undefined),
  );
  let usage: SessionStatusUsage = baseline ? { ...baseline } : {};
  for (const run of session?.runs ?? []) {
    if (run.kind !== "session") continue;
    const totals = recordValue(run.metadata.usageTotals);
    if (!totals) continue;
    const latestCacheHitPercent =
      numberValue(totals.latestCacheHitPercent) ?? usage.latestCacheHitPercent;
    const latestContextTokens = numberValue(totals.contextTokens) ?? usage.contextTokens;
    const latestContextTokenSource =
      totals.contextTokenSource === "reported" ||
      totals.contextTokenSource === "tokenizer" ||
      totals.contextTokenSource === "estimated"
        ? totals.contextTokenSource
        : usage.contextTokenSource;
    const latestContextWindow =
      contextWindow ?? numberValue(totals.contextWindow) ?? usage.contextWindow;
    usage = {
      ...usage,
      ...(!hasBaselineTotals
        ? {
            inputTokens: (usage.inputTokens ?? 0) + (numberValue(totals.inputTokens) ?? 0),
            outputTokens: (usage.outputTokens ?? 0) + (numberValue(totals.outputTokens) ?? 0),
            cacheReadTokens:
              (usage.cacheReadTokens ?? 0) + (numberValue(totals.cacheReadTokens) ?? 0),
            cacheWriteTokens:
              (usage.cacheWriteTokens ?? 0) + (numberValue(totals.cacheWriteTokens) ?? 0),
            costUsd: (usage.costUsd ?? 0) + (numberValue(totals.costUsd) ?? 0),
          }
        : {}),
      ...(latestCacheHitPercent !== undefined ? { latestCacheHitPercent } : {}),
      ...(latestContextTokens !== undefined ? { contextTokens: latestContextTokens } : {}),
      ...(latestContextTokenSource ? { contextTokenSource: latestContextTokenSource } : {}),
      ...(latestContextWindow !== undefined ? { contextWindow: latestContextWindow } : {}),
    };
  }
  if (contextWindow) usage = { ...usage, contextWindow };
  return usage;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
