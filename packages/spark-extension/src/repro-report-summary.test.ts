import { describe, expect, it } from "vitest";

import type { EvidenceRef } from "@zendev-lab/spark-core";
import type { SparkTokenUsageAggregate } from "@zendev-lab/spark-protocol/token-usage";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  buildSparkReproWorkSummary,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproWorkStage,
} from "@zendev-lab/spark-repro/work-summary";
import {
  composeSparkReproReportSummary,
  parseSparkReproReportSummary,
  serializeSparkReproReportSummary,
} from "./repro-report-summary.ts";

const evidence = (id: string) => `evidence:${id}` as EvidenceRef;

describe("Repro report summary composition", () => {
  it("joins canonical work and daemon usage without deriving either projection", () => {
    const work = workSummary("run-42");
    const tokenUsage = usage("run-42");
    const summary = composeSparkReproReportSummary({ work, tokenUsage });

    expect(summary).toEqual({ format: "spark-repro-summary/v1", work, tokenUsage });
    expect(serializeSparkReproReportSummary(summary)).toBe(`${JSON.stringify(summary, null, 2)}\n`);
    expect(parseSparkReproReportSummary(structuredClone(summary))).toEqual(summary);
  });

  it("rejects usage attributed to another Repro run", () => {
    expect(() =>
      composeSparkReproReportSummary({
        work: workSummary("run-42"),
        tokenUsage: usage("run-elsewhere"),
      }),
    ).toThrow("token usage scope run-elsewhere does not match work summary run-42");
  });

  it("rejects persisted derived work facts that drift from canonical gates and decisions", () => {
    const summary = composeSparkReproReportSummary({ work: workSummary("run-42") });
    const stale = structuredClone(summary) as unknown as {
      work: { status: string; progress: { percent: number } };
    };
    stale.work.status = "complete";
    stale.work.progress.percent = 100;

    expect(() => parseSparkReproReportSummary(stale)).toThrow(
      "work.status does not match derived canonical facts",
    );
  });
});

function workSummary(reproId: string) {
  return buildSparkReproWorkSummary({
    reproId,
    title: "Minimum-complete alignment",
    stage: "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 10,
      referenceStrategies: [],
      validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    },
    profile: profile(),
    gates: [
      gate("contract", "contract", "accepted"),
      gate("reference", "reference", "accepted", profile()),
      gate("target", "target", "accepted", profile()),
      gate("alignment", "alignment", "open", profile()),
      gate("delivery", "delivery", "open"),
    ],
  });
}

function gate(
  id: string,
  stage: SparkReproWorkStage,
  status: SparkReproEvidenceGate["status"],
  gateProfile?: SparkReproProfile,
): SparkReproEvidenceGate {
  return {
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status,
    weight: 1,
    evidenceRefs: status === "accepted" ? [evidence(id)] : [],
    ...(gateProfile ? { profile: gateProfile } : {}),
  };
}

function profile(): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed: 1, target: 10 },
    topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
  };
}

function usage(reproId: string): SparkTokenUsageAggregate {
  const reported = {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
  };
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  return {
    scope: { kind: "repro", reproId },
    reported,
    estimated: zero,
    totalTokens: 10,
    responseCount: 1,
    missingResponseCount: 0,
    activeExecutionCount: 0,
    quality: "exact",
    byExecutionKind: { root_session: reported },
    byModel: { model: reported },
    asOf: "2026-08-03T12:00:00.000Z",
  };
}
