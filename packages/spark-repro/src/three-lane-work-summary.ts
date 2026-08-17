import type {
  SparkReproAlignmentFinding,
  SparkReproResolution,
  SparkReproUnresolvedMismatch,
  SparkReproWorkHandoff,
  SparkReproWorkItem,
  SparkReproThreeLaneSessionState,
} from "./three-lane.ts";
import {
  migrateSparkReproWorkSummaryV1,
  normalizeSparkReproWorkSummary,
  SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
  SPARK_REPRO_WORK_SUMMARY_SCHEMA,
  type SparkReproExploreFrontier,
  type SparkReproNormativeCursor,
  type SparkReproWorkSummary,
  type SparkReproWorkSummaryMigration,
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
    sourceV2Migration?: SparkReproWorkSummaryMigration;
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
      ...(input.migration ? { sourceV2Migration: structuredClone(input.migration) } : {}),
    },
  };
}

export function normalizeSparkReproWorkSummaryV3(
  input: SparkReproWorkSummary | SparkReproWorkSummaryV3,
): SparkReproWorkSummaryV3 {
  const candidate =
    input.schema === SPARK_REPRO_WORK_SUMMARY_SCHEMA
      ? migrateSparkReproWorkSummaryV2(input)
      : structuredClone(input);
  const normalizedBase = sparkReproWorkSummaryV3Base(candidate);
  const {
    migration: _baseMigration,
    exploreFrontier: _baseExploreFrontier,
    normativeCursor: _baseNormativeCursor,
    ...baseWithoutLegacyLanes
  } = normalizedBase;
  const normalized: SparkReproWorkSummaryV3 = {
    ...baseWithoutLegacyLanes,
    schema: SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA,
    lanes: structuredClone(candidate.lanes),
    workItems: structuredClone(candidate.workItems),
    findings: structuredClone(candidate.findings),
    mismatches: structuredClone(candidate.mismatches),
    handoffs: structuredClone(candidate.handoffs),
    resolutions: structuredClone(candidate.resolutions),
    ...(candidate.migration ? { migration: structuredClone(candidate.migration) } : {}),
  };
  validateSparkReproWorkSummaryV3(normalized);
  return normalized;
}

export function projectSparkReproWorkSummaryV3(input: {
  work: SparkReproWorkSummary;
  state: SparkReproThreeLaneSessionState;
}): SparkReproWorkSummaryV3 {
  if (input.work.normativeCursor.planRevision !== input.state.planRevision) {
    throw new Error("work-summary/v3 projection requires the current Repro plan revision");
  }
  return normalizeSparkReproWorkSummaryV3({
    ...migrateSparkReproWorkSummaryV2(input.work),
    lanes: {
      implementation: {
        frontier: structuredClone(input.work.exploreFrontier),
        workItemIds: [...input.state.implementation.workItemIds],
      },
      exactness: {
        workItemIds: [...input.state.exactness.workItemIds],
        findingIds: [...input.state.exactness.findingIds],
        mismatchIds: [...input.state.exactness.mismatchIds],
      },
      formalize: {
        cursor: structuredClone(input.work.normativeCursor),
        workItemIds: [...input.state.formalize.workItemIds],
        ...(input.state.formalize.formalizedTip
          ? { formalizedTip: input.state.formalize.formalizedTip }
          : {}),
      },
    },
    workItems: structuredClone(input.state.workItems),
    findings: structuredClone(input.state.findings),
    mismatches: structuredClone(input.state.mismatches),
    handoffs: structuredClone(input.state.handoffs),
    resolutions: structuredClone(input.state.resolutions),
  });
}

/** Reconstruct the v2 formal-authority input without interpreting lane records. */
export function sparkReproWorkSummaryV3Base(
  summary: SparkReproWorkSummaryV3,
): SparkReproWorkSummary {
  const {
    schema: _schema,
    lanes,
    workItems: _workItems,
    findings: _findings,
    mismatches: _mismatches,
    handoffs: _handoffs,
    resolutions: _resolutions,
    migration: _migration,
    ...base
  } = structuredClone(summary);
  if (summary.migration?.sourceV2Migration) {
    return migrateSparkReproWorkSummaryV1({
      schema: SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
      reproId: summary.reproId,
      title: summary.title,
      stage: summary.stage,
      target: summary.target,
      profile: summary.profile,
      gates: summary.gates,
      pendingDecisions: summary.pendingDecisions,
      ...(summary.frontier ? { frontier: summary.frontier } : {}),
      tasks: summary.tasks,
      todos: summary.todos,
      conclusions: summary.conclusions,
      artifactRefs: summary.artifactRefs,
      ...(summary.reportArtifactRef ? { reportArtifactRef: summary.reportArtifactRef } : {}),
    });
  }
  return normalizeSparkReproWorkSummary({
    ...base,
    schema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
    exploreFrontier: lanes.implementation.frontier,
    normativeCursor: lanes.formalize.cursor,
  });
}

export function validateSparkReproWorkSummaryV3(summary: SparkReproWorkSummaryV3): void {
  if (summary.schema !== SPARK_REPRO_THREE_LANE_WORK_SUMMARY_SCHEMA) {
    throw new Error("unsupported work-summary/v3 schema");
  }
  if (
    summary.migration &&
    (summary.migration.sourceSchema !== SPARK_REPRO_WORK_SUMMARY_SCHEMA ||
      summary.migration.revision !== 1 ||
      summary.migration.legacyProofAuthority !== "not_promoted" ||
      (summary.migration.sourceV2Migration !== undefined &&
        (summary.migration.sourceV2Migration.sourceSchema !== "spark.repro.work-summary/v1" ||
          summary.migration.sourceV2Migration.revision !== 1 ||
          summary.migration.sourceV2Migration.legacyProofAuthority !== "not_promoted")))
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
  for (const laneIds of [
    summary.lanes.implementation.workItemIds,
    summary.lanes.exactness.workItemIds,
    summary.lanes.formalize.workItemIds,
  ]) {
    assertUnique(laneIds, "lane.workItemIds");
  }
  for (const item of summary.workItems) {
    if (item.planRevision !== summary.lanes.formalize.cursor.planRevision) {
      throw new Error("work-summary/v3 contains a stale work item plan revision");
    }
    assertRef(item.taskRef, "task", "workItem.taskRef");
    assertRef(item.runRef, "run", "workItem.runRef");
    assertRef(item.gitChangeRef, "artifact", "workItem.gitChangeRef");
    item.evidenceRefs.forEach((ref) => assertRef(ref, "evidence", "workItem.evidenceRefs"));
  }
  for (const finding of summary.findings) {
    assertKnownWorkItem(knownWorkItems, finding.workItemId);
    finding.evidenceRefs.forEach((ref) => assertRef(ref, "evidence", "finding.evidenceRefs"));
  }
  for (const mismatch of summary.mismatches) {
    assertKnownWorkItem(knownWorkItems, mismatch.workItemId);
    if (mismatch.disposition === "skip" && (!mismatch.isolation || !mismatch.resynchronization)) {
      throw new Error("work-summary/v3 skipped mismatch requires isolate and resynchronize");
    }
  }
  for (const handoff of summary.handoffs) {
    assertKnownWorkItem(knownWorkItems, handoff.workItemId);
    const item = summary.workItems.find(
      (candidate) => candidate.workItemId === handoff.workItemId,
    )!;
    if (
      !(
        (handoff.from === "implementation" && handoff.to === "exactness") ||
        (handoff.from === "exactness" && handoff.to === "formalize")
      )
    ) {
      throw new Error("work-summary/v3 handoff must move one lane forward");
    }
    if (
      handoff.planRevision !== summary.lanes.formalize.cursor.planRevision ||
      (handoff.status !== "stale" &&
        handoff.status !== "superseded" &&
        handoff.sourceRevision !== item.sourceRevision)
    ) {
      throw new Error("work-summary/v3 contains a stale handoff revision");
    }
  }
  for (const resolution of summary.resolutions) {
    assertKnownWorkItem(knownWorkItems, resolution.workItemId);
    if (
      !(
        (resolution.from === "formalize" && resolution.to === "exactness") ||
        (resolution.from === "exactness" && resolution.to === "implementation")
      )
    ) {
      throw new Error("work-summary/v3 resolution must move one lane backward");
    }
    if (resolution.from === "exactness") {
      const parent = summary.resolutions.find(
        (candidate) => candidate.resolutionId === resolution.parentResolutionId,
      );
      if (
        !parent ||
        parent.from !== "formalize" ||
        parent.workItemId !== resolution.workItemId ||
        parent.canonicalRevision !== resolution.canonicalRevision
      ) {
        throw new Error("work-summary/v3 backward resolution requires its Formalize parent");
      }
    }
  }
  const acceptedFormalResolution = [...summary.resolutions]
    .reverse()
    .find((resolution) => resolution.from === "formalize" && resolution.status !== "rejected");
  if (summary.lanes.formalize.formalizedTip !== acceptedFormalResolution?.canonicalRevision) {
    throw new Error("work-summary/v3 formalizedTip does not match Formalize resolution");
  }
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`work-summary/v3 ${field} must be unique`);
  }
}

function assertKnownWorkItem(known: ReadonlySet<string>, workItemId: string): void {
  if (!known.has(workItemId)) {
    throw new Error(`work-summary/v3 references unknown work item: ${workItemId}`);
  }
}

function assertRef(
  value: string | undefined,
  kind: "task" | "run" | "artifact" | "evidence",
  field: string,
): void {
  if (value !== undefined && !value.startsWith(`${kind}:`)) {
    throw new Error(`work-summary/v3 ${field} is invalid`);
  }
}
