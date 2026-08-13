import type {
  SparkReproAlignmentFinding,
  SparkReproResolution,
  SparkReproUnresolvedMismatch,
  SparkReproWorkHandoff,
  SparkReproWorkItem,
} from "./three-lane.ts";
import {
  SPARK_REPRO_WORK_SUMMARY_SCHEMA,
  type SparkReproExploreFrontier,
  type SparkReproNormativeCursor,
  type SparkReproWorkSummary,
} from "./work-summary.ts";

export const SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA = "spark.repro.work-summary/v3" as const;

export interface SparkReproWorkSummaryV3 extends Omit<
  SparkReproWorkSummary,
  "schema" | "migration" | "exploreFrontier" | "normativeCursor"
> {
  schema: typeof SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA;
  lanes: {
    implementation: {
      frontier: SparkReproExploreFrontier;
      workItemIds: string[];
    };
    exactness: {
      workItemIds: string[];
      findingIds: string[];
      mismatchIds: string[];
    };
    formalize: {
      cursor: SparkReproNormativeCursor;
      workItemIds: string[];
      formalizedTip?: string;
    };
  };
  workItems: SparkReproWorkItem[];
  findings: SparkReproAlignmentFinding[];
  mismatches: SparkReproUnresolvedMismatch[];
  handoffs: SparkReproWorkHandoff[];
  resolutions: SparkReproResolution[];
  migration?: {
    sourceSchema: typeof SPARK_REPRO_WORK_SUMMARY_SCHEMA;
    revision: 1;
    legacyProofAuthority: "not_promoted";
  };
}

/**
 * Pure work-summary/v2 -> v3 migration. Existing Explore observations become
 * Implementation input, Normative retirement becomes Formalize input, and no
 * Exactness finding, handoff, resolution, or formalized tip is invented.
 */
export function migrateSparkReproWorkSummaryV2(
  input: SparkReproWorkSummary,
): SparkReproWorkSummaryV3 {
  if (input.schema !== SPARK_REPRO_WORK_SUMMARY_SCHEMA) {
    throw new Error("work-summary/v3 migration requires work-summary/v2 input");
  }
  const {
    schema: _schema,
    migration: _migration,
    exploreFrontier,
    normativeCursor,
    ...rest
  } = structuredClone(input);
  return {
    ...rest,
    schema: SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA,
    lanes: {
      implementation: { frontier: exploreFrontier, workItemIds: [] },
      exactness: { workItemIds: [], findingIds: [], mismatchIds: [] },
      formalize: { cursor: normativeCursor, workItemIds: [] },
    },
    workItems: [],
    findings: [],
    mismatches: [],
    handoffs: [],
    resolutions: [],
    migration: {
      sourceSchema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
      revision: 1,
      legacyProofAuthority: "not_promoted",
    },
  };
}

export function normalizeSparkReproWorkSummaryV3(
  input: SparkReproWorkSummary | SparkReproWorkSummaryV3,
): SparkReproWorkSummaryV3 {
  const normalized =
    input.schema === SPARK_REPRO_WORK_SUMMARY_SCHEMA
      ? migrateSparkReproWorkSummaryV2(input)
      : structuredClone(input);
  validateSparkReproWorkSummaryV3(normalized);
  return normalized;
}

export function validateSparkReproWorkSummaryV3(summary: SparkReproWorkSummaryV3): void {
  if (summary.schema !== SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA) {
    throw new Error("unsupported work-summary/v3 schema");
  }
  if (
    summary.migration &&
    (summary.migration.sourceSchema !== SPARK_REPRO_WORK_SUMMARY_SCHEMA ||
      summary.migration.revision !== 1 ||
      summary.migration.legacyProofAuthority !== "not_promoted")
  ) {
    throw new Error("invalid work-summary/v3 migration binding");
  }
  assertUnique(
    summary.workItems.map((item) => item.workItemId),
    "workItemId",
  );
  assertUnique(
    summary.findings.map((item) => item.findingId),
    "findingId",
  );
  assertUnique(
    summary.mismatches.map((item) => item.mismatchId),
    "mismatchId",
  );
  assertUnique(
    summary.handoffs.map((item) => item.handoffId),
    "handoffId",
  );
  assertUnique(
    summary.resolutions.map((item) => item.resolutionId),
    "resolutionId",
  );
  const knownWorkItems = new Set(summary.workItems.map((item) => item.workItemId));
  for (const workItemId of [
    ...summary.lanes.implementation.workItemIds,
    ...summary.lanes.exactness.workItemIds,
    ...summary.lanes.formalize.workItemIds,
  ]) {
    if (!knownWorkItems.has(workItemId)) {
      throw new Error(`work-summary/v3 lane references unknown work item: ${workItemId}`);
    }
  }
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`work-summary/v3 ${field} must be unique`);
  }
}
