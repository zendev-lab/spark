import { describe, expect, it } from "vitest";

import {
  migrateSparkReproWorkSummaryV2,
  normalizeSparkReproWorkSummaryV3,
  projectSparkReproWorkSummaryV3,
  sparkReproWorkSummaryV3Base,
} from "./three-lane-work-summary.ts";
import { createSparkSessionRepro } from "./index.ts";
import { registerSparkReproWorkItem } from "./three-lane.ts";
import { SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY, buildSparkReproWorkSummary } from "./work-summary.ts";

describe("Spark Repro work-summary/v3 migration", () => {
  it("maps v2 Explore and Normative state without inventing Exactness state", () => {
    const v2 = buildSparkReproWorkSummary({
      reproId: "repro:three-lane-migration",
      title: "Three-lane migration fixture",
      stage: "contract",
      target: {
        model: "minimum_complete",
        requiredSteps: 1,
        referenceStrategies: [],
        validationTopology: SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
      },
      profile: {
        id: "minimum",
        model: "minimum_complete",
        compute: "forward",
        steps: { completed: 0, target: 1 },
        topology: SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
      },
      gates: [],
    });

    const v3 = migrateSparkReproWorkSummaryV2(v2);

    expect(v3.schema).toBe("spark.repro.work-summary/v3");
    expect(v3.lanes.implementation.frontier).toEqual(v2.exploreFrontier);
    expect(v3.lanes.formalize.cursor).toEqual(v2.normativeCursor);
    expect(v3.lanes.exactness).toEqual({
      workItemIds: [],
      findingIds: [],
      mismatchIds: [],
    });
    expect(v3).toMatchObject({
      workItems: [],
      findings: [],
      mismatches: [],
      handoffs: [],
      resolutions: [],
      migration: {
        sourceSchema: "spark.repro.work-summary/v2",
        revision: 1,
        legacyProofAuthority: "not_promoted",
      },
    });
    expect(v3.lanes.formalize).not.toHaveProperty("formalizedTip");
    expect(normalizeSparkReproWorkSummaryV3(v3)).toEqual(v3);
  });

  it("projects current lane records while retaining canonical v2 formal facts", () => {
    const repro = createSparkSessionRepro("session:work-summary-v3");
    const v2 = buildSparkReproWorkSummary({
      reproId: repro.reproId,
      title: "Project the three lanes",
      stage: "contract",
      target: {
        model: "minimum_complete",
        requiredSteps: 1,
        referenceStrategies: [],
        validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
      },
      profile: {
        id: "minimum",
        model: "minimum_complete",
        compute: "forward",
        steps: { completed: 0, target: 1 },
        topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
      },
      gates: [],
      normativeCursor: {
        planRevision: repro.plan.currentRevision,
        orderedStepIds: [],
        retiredStepIds: [],
        candidateBuffer: [],
        retirementLog: [],
      },
    });
    const state = registerSparkReproWorkItem(repro.threeLane, "implementation", {
      workItemId: "work:projection",
      title: "Projection concern",
      scope: "owner boundary",
      planRevision: repro.plan.currentRevision,
      sourceRevision: "commit:candidate",
      status: "open",
      evidenceRefs: [],
      unresolvedIds: [],
    });

    const v3 = projectSparkReproWorkSummaryV3({ work: v2, state });

    expect(v3.lanes.implementation.workItemIds).toEqual(["work:projection"]);
    expect(v3.lanes.exactness.workItemIds).toEqual([]);
    expect(v3.lanes.formalize).not.toHaveProperty("formalizedTip");
    expect(sparkReproWorkSummaryV3Base(v3)).toEqual(v2);
    expect(normalizeSparkReproWorkSummaryV3(v3)).toEqual(v3);
  });
});
