import { isDeepStrictEqual } from "node:util";

import {
  sparkTokenUsageAggregateSchema,
  type SparkTokenUsageAggregate,
} from "@zendev-lab/spark-protocol/token-usage";
import {
  buildSparkReproWorkSummary,
  type SparkReproWorkSummary,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";

export const SPARK_REPRO_REPORT_SUMMARY_FORMAT = "spark-repro-summary/v1" as const;
export const SPARK_REPRO_REPORT_SUMMARY_PATH = "outputs/spark-summary.json" as const;

/**
 * The bounded, storage-neutral wire value consumed by report renderers.
 *
 * Work remains owned by spark-repro and token accounting remains daemon-owned.
 * This composition layer only joins their public projections; it never scans a
 * transcript or reaches into either store.
 */
export interface SparkReproReportSummary {
  format: typeof SPARK_REPRO_REPORT_SUMMARY_FORMAT;
  work: SparkReproWorkSummary;
  tokenUsage?: SparkTokenUsageAggregate;
}

export interface SparkReproReportSummaryInput {
  work: SparkReproWorkSummary;
  tokenUsage?: SparkTokenUsageAggregate;
}

export function composeSparkReproReportSummary(
  input: SparkReproReportSummaryInput,
): SparkReproReportSummary {
  if (input.work.schema !== "spark.repro.work-summary/v1") {
    throw new Error(`unsupported Repro work summary schema: ${String(input.work.schema)}`);
  }

  const tokenUsage = input.tokenUsage
    ? sparkTokenUsageAggregateSchema.parse(input.tokenUsage)
    : undefined;
  if (tokenUsage && tokenUsage.scope.reproId !== input.work.reproId) {
    throw new Error(
      `token usage scope ${tokenUsage.scope.reproId} does not match work summary ${input.work.reproId}`,
    );
  }

  return {
    format: SPARK_REPRO_REPORT_SUMMARY_FORMAT,
    work: input.work,
    ...(tokenUsage ? { tokenUsage } : {}),
  };
}

/**
 * Validate a persisted report projection and re-derive its canonical work
 * facts. Stored status, progress, and technical-goal fields are checked rather
 * than trusted so Artifact metadata cannot drift from the ReportModel input.
 */
export function parseSparkReproReportSummary(value: unknown): SparkReproReportSummary {
  if (!isRecord(value)) throw new Error("Repro report summary must be a JSON object");
  if (value.format !== SPARK_REPRO_REPORT_SUMMARY_FORMAT) {
    throw new Error(`unsupported Repro report summary format: ${String(value.format)}`);
  }
  if (!isRecord(value.work)) throw new Error("Repro report summary work must be an object");

  const storedWork = value.work;
  const work = buildSparkReproWorkSummary(storedWork as unknown as SparkReproWorkSummaryInput);
  assertCanonicalField(storedWork, work, "schema");
  assertCanonicalField(storedWork, work, "status");
  assertCanonicalField(storedWork, work, "progress");
  assertCanonicalField(storedWork, work, "technicalGoal");

  return composeSparkReproReportSummary({
    work,
    ...(value.tokenUsage !== undefined
      ? { tokenUsage: value.tokenUsage as SparkTokenUsageAggregate }
      : {}),
  });
}

/** Stable JSON text suitable for an atomic caller-owned file write. */
export function serializeSparkReproReportSummary(summary: SparkReproReportSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

function assertCanonicalField(
  stored: Record<string, unknown>,
  canonical: SparkReproWorkSummary,
  field: "schema" | "status" | "progress" | "technicalGoal",
): void {
  if (!isDeepStrictEqual(stored[field], canonical[field])) {
    throw new Error(`Repro report summary work.${field} does not match derived canonical facts`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
