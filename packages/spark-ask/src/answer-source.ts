export type SparkAskAnswerSource = "user" | "reviewer";

export function normalizeSparkAskAnswerSource(value: unknown): SparkAskAnswerSource | undefined {
  return value === "user" || value === "reviewer" ? value : undefined;
}
