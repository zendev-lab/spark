import type { SessionStatusBarLabels, SessionStatusSnapshot } from "./types";

export type { SessionStatusBarLabels, SessionStatusSnapshot } from "./types";

function nonNegativeFinite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function trimDecimal(value: string): string {
  return value.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}

export function formatCompactTokenCount(value: number | undefined): string | undefined {
  const count = nonNegativeFinite(value);
  if (count === undefined) return undefined;

  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "k" },
  ] as const;
  const unit = units.find((candidate) => count >= candidate.threshold);
  if (!unit) return String(Math.round(count));

  const scaled = count / unit.threshold;
  const fractionDigits = scaled < 10 ? 1 : scaled < 100 && !Number.isInteger(scaled) ? 1 : 0;
  return `${trimDecimal(scaled.toFixed(fractionDigits))}${unit.suffix}`;
}

export function formatSessionStatusPercent(value: number | undefined): string | undefined {
  const percent = nonNegativeFinite(value);
  if (percent === undefined) return undefined;
  return `${trimDecimal(Math.min(percent, 100).toFixed(1))}%`;
}

export function formatSessionCost(value: number | undefined): string | undefined {
  const cost = nonNegativeFinite(value);
  if (cost === undefined) return undefined;
  const fractionDigits = cost >= 1 ? 3 : cost >= 0.01 ? 4 : 5;
  return `$${trimDecimal(cost.toFixed(fractionDigits))}`;
}

export function formatContextUsage(
  contextTokens: number | undefined,
  contextWindow: number | undefined,
): string | undefined {
  const window = nonNegativeFinite(contextWindow);
  if (window === undefined || window === 0) return undefined;

  const compactWindow = formatCompactTokenCount(window);
  const used = nonNegativeFinite(contextTokens);
  if (used === undefined) return `—/${compactWindow}`;
  return `${formatSessionStatusPercent((used / window) * 100)}/${compactWindow}`;
}

function detail(label: string, value: string | number | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return `${label}: ${value}`;
}

export function describeSessionStatus(
  labels: SessionStatusBarLabels,
  status: SessionStatusSnapshot,
): string {
  const context = formatContextUsage(status.contextTokens, status.contextWindow);
  return [
    labels.bar,
    detail(labels.workingDirectory, status.cwd.trim()),
    detail(labels.branch, status.gitBranch?.trim()),
    detail(labels.inputTokens, nonNegativeFinite(status.inputTokens)),
    detail(labels.outputTokens, nonNegativeFinite(status.outputTokens)),
    detail(labels.cacheReadTokens, nonNegativeFinite(status.cacheReadTokens)),
    detail(labels.cacheWriteTokens, nonNegativeFinite(status.cacheWriteTokens)),
    detail(labels.cacheHit, formatSessionStatusPercent(status.latestCacheHitPercent)),
    detail(labels.cost, formatSessionCost(status.costUsd)),
    detail(labels.context, context),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}
