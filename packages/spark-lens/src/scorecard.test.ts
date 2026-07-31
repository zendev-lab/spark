import { expect, test } from "vitest";

import {
  evaluateLensScorecard,
  LENS_REQUIRED_CAPABILITIES,
  type LensScorecardMeasurements,
} from "./scorecard.ts";

test("keeps unmeasured results pending and fails any observed threshold violation", () => {
  const pending = measurements();
  expect(evaluateLensScorecard(pending, "fixture").overall).toBe("pending");

  const failed = measurements();
  failed.correctness.acceptedStaleResults = 1;
  expect(evaluateLensScorecard(failed, "fixture")).toMatchObject({
    overall: "fail",
    gates: { correctness: { status: "fail" } },
  });
});

test("passes only when every capability, comparison, and protocol threshold passes", () => {
  const complete = measurements();
  complete.protocol = {
    sameMachine: true,
    fixedModel: true,
    fixedPrompt: true,
    repetitions: 3,
  };
  complete.correctness = {
    acceptedStaleResults: 0,
    passesWithoutAffirmativeClean: 0,
    staleReceiptBypasses: 0,
  };
  for (const language of ["typescript", "python", "rust"] as const) {
    complete.capabilities[language] = {
      covered: [...LENS_REQUIRED_CAPABILITIES],
      independentDiagnosticProviders: 2,
    };
    complete.performance.warmP95Ratio[language] = 1;
  }
  complete.concurrency = {
    maxProcessesPerProviderWorktree: 1,
    fourSessionRssRatio: 0.6,
    orphanProvidersAfterRestart: 0,
    acceptedPreRestartResults: 0,
  };
  complete.performance = {
    ...complete.performance,
    warmGeomeanSpeedup: 0.2,
    coldP95Ratio: 1.1,
    discoveryHitRate: 0.95,
    visibleTokenRatio: 0.7,
  };
  complete.agentEffect = {
    sparkCompletionRate: 0.8,
    baselineCompletionRate: 0.8,
    sparkDefectRecall: 0.9,
    baselineDefectRecall: 0.9,
    sparkFalsePositiveRate: 0.1,
    baselineFalsePositiveRate: 0.1,
    invalidWorkReduction: 0.2,
  };
  expect(evaluateLensScorecard(complete, "fixture").overall).toBe("pass");
});

function measurements(): LensScorecardMeasurements {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-31T00:00:00.000Z",
    baseline: {
      package: "pi-lens",
      version: "3.8.73",
      commit: "dc4d6f4d5dfd0d5ddbc6a473efac9e9d1ea84d57",
    },
    protocol: {
      sameMachine: null,
      fixedModel: null,
      fixedPrompt: null,
      repetitions: null,
    },
    correctness: {
      acceptedStaleResults: null,
      passesWithoutAffirmativeClean: null,
      staleReceiptBypasses: null,
    },
    capabilities: {
      typescript: { covered: [], independentDiagnosticProviders: null },
      python: { covered: [], independentDiagnosticProviders: null },
      rust: { covered: [], independentDiagnosticProviders: null },
    },
    concurrency: {
      maxProcessesPerProviderWorktree: null,
      fourSessionRssRatio: null,
      orphanProvidersAfterRestart: null,
      acceptedPreRestartResults: null,
    },
    performance: {
      warmP95Ratio: { typescript: null, python: null, rust: null },
      warmGeomeanSpeedup: null,
      coldP95Ratio: null,
      discoveryHitRate: null,
      visibleTokenRatio: null,
    },
    agentEffect: {
      sparkCompletionRate: null,
      baselineCompletionRate: null,
      sparkDefectRecall: null,
      baselineDefectRecall: null,
      sparkFalsePositiveRate: null,
      baselineFalsePositiveRate: null,
      invalidWorkReduction: null,
    },
    evidenceRefs: [],
  };
}
