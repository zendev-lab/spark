/** Footer metrics helpers for the native TUI. */

import type { SparkRunView } from "@zendev-lab/spark-protocol";

import { numberFromRecord } from "./message-view.ts";
import type { SparkNativeFooterMetrics } from "./types.ts";

export function runTimeMs(run: SparkRunView): number {
  const completedAt = run.completedAt ? Date.parse(run.completedAt) : NaN;
  if (Number.isFinite(completedAt)) return completedAt;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (Number.isFinite(startedAt)) return startedAt;
  return 0;
}

export function ownerTreeRunDurationMs(runs: Iterable<SparkRunView>): number | undefined {
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  for (const run of runs) {
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const completed = run.completedAt ? Date.parse(run.completedAt) : NaN;
    if (!Number.isFinite(started) || !Number.isFinite(completed)) continue;
    startedAt = startedAt === undefined ? started : Math.min(startedAt, started);
    completedAt = completedAt === undefined ? completed : Math.max(completedAt, completed);
  }
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const durationMs = completedAt - startedAt;
  return durationMs > 0 ? durationMs : undefined;
}

export function footerTokensPerSecond(
  outputTokens: number | undefined,
  durationMs: number | undefined,
): number | undefined {
  if (outputTokens === undefined || outputTokens <= 0) return undefined;
  if (durationMs === undefined || durationMs <= 0) return undefined;
  const rate = outputTokens / (durationMs / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  return rate;
}

export function formatFooterTokensPerSecond(rate: number | undefined): string | undefined {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return undefined;
  return `${rate.toFixed(1)} t/s`;
}

export function footerMetricsFromRecord(record: Record<string, unknown>): SparkNativeFooterMetrics {
  return {
    inputTokens: numberFromRecord(record, "inputTokens") ?? numberFromRecord(record, "input"),
    outputTokens: numberFromRecord(record, "outputTokens") ?? numberFromRecord(record, "output"),
    cacheRead:
      numberFromRecord(record, "cacheRead") ??
      numberFromRecord(record, "cacheReadTokens") ??
      numberFromRecord(record, "promptCacheReadTokens"),
    cacheWrite:
      numberFromRecord(record, "cacheWrite") ??
      numberFromRecord(record, "cacheWriteTokens") ??
      numberFromRecord(record, "promptCacheWriteTokens"),
    costUsd:
      numberFromRecord(record, "costUsd") ??
      numberFromRecord(record, "cost") ??
      numberFromRecord(record, "costTotal"),
    latestCacheHitPercent:
      numberFromRecord(record, "latestCacheHitPercent") ??
      numberFromRecord(record, "cacheHitPercent"),
    contextTokens:
      numberFromRecord(record, "contextTokens") ?? numberFromRecord(record, "totalTokens"),
    contextWindow: numberFromRecord(record, "contextWindow"),
  };
}

export function formatFooterMetrics(
  metrics: SparkNativeFooterMetrics,
  autoCompactionEnabled: boolean,
): string | undefined {
  const hasMetric = Object.values(metrics).some((value) => value !== undefined);
  if (!hasMetric) return undefined;
  const parts: string[] = [];
  if (metrics.inputTokens) parts.push(`↑${formatFooterTokens(metrics.inputTokens)}`);
  if (metrics.outputTokens) parts.push(`↓${formatFooterTokens(metrics.outputTokens)}`);
  if (metrics.cacheRead) parts.push(`R${formatFooterTokens(metrics.cacheRead)}`);
  if (metrics.cacheWrite) parts.push(`W${formatFooterTokens(metrics.cacheWrite)}`);
  if (metrics.latestCacheHitPercent !== undefined) {
    parts.push(`CH${metrics.latestCacheHitPercent.toFixed(1)}%`);
  }
  if (metrics.costUsd) parts.push(`$${metrics.costUsd.toFixed(3)}`);
  const tokensPerSecond = formatFooterTokensPerSecond(metrics.tokensPerSecond);
  if (tokensPerSecond) parts.push(tokensPerSecond);
  if (metrics.contextWindow) {
    const contextPercent =
      metrics.contextTokens !== undefined
        ? `${((metrics.contextTokens / metrics.contextWindow) * 100).toFixed(1)}%`
        : "?";
    const autoIndicator = autoCompactionEnabled ? " (auto)" : "";
    parts.push(`${contextPercent}/${formatFooterTokens(metrics.contextWindow)}${autoIndicator}`);
  }
  return parts.join(" ") || undefined;
}

export function formatFooterTokens(count: number): string {
  if (count < 1_000) return Math.round(count).toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
