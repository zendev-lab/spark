import assert from "node:assert/strict";
import { test } from "vitest";

import {
  summarizeSparkBehaviorCe,
  summarizeSparkBehaviorCeNumbers,
  type SparkBehaviorCeSample,
} from "./behavior-ce.ts";

test("repeated behavior CE passes only when every expected case is stable", () => {
  const summary = summarizeSparkBehaviorCe(
    [
      sample("run-1", "goal", true, 10, { toolCalls: 2 }),
      sample("run-1", "loop", true, 5, { toolCalls: 1 }),
      sample("run-2", "goal", true, 12, { toolCalls: 3 }),
      sample("run-2", "loop", true, 6, { toolCalls: 1 }),
    ],
    {
      expectedRunIds: ["run-1", "run-2"],
      expectedCaseIds: ["goal", "loop"],
      maxDurationP95Ms: 20,
    },
  );

  assert.equal(summary.passed, true);
  assert.equal(summary.inventoryStable, true);
  assert.deepEqual(summary.missingRunIds, []);
  assert.deepEqual(summary.unexpectedRunIds, []);
  assert.deepEqual(summary.totals, {
    expectedRuns: 2,
    observedRuns: 2,
    cases: 2,
    samples: 4,
    passes: 4,
    failedSamples: 0,
    missingSamples: 0,
    flakyCases: 0,
  });
  const goal = summary.cases.find((entry) => entry.caseId === "goal");
  assert.ok(goal);
  assert.equal(goal.passRate, 1);
  assert.equal(goal.flaky, false);
  assert.deepEqual(goal.durationMs, {
    count: 2,
    min: 10,
    max: 12,
    mean: 11,
    p50: 10,
    p95: 12,
    coefficientOfVariation: 0.090909,
  });
  assert.deepEqual(goal.metrics.toolCalls, {
    count: 2,
    min: 2,
    max: 3,
    mean: 2.5,
    p50: 2,
    p95: 3,
    coefficientOfVariation: 0.2,
  });
});

test("repeated behavior CE exposes flakes and inventory drift instead of averaging them away", () => {
  const summary = summarizeSparkBehaviorCe(
    [
      sample("run-1", "goal", true, 10),
      { ...sample("run-2", "goal", false, 11), failure: "stale settlement applied" },
      sample("run-2", "repro", true, 8),
    ],
    { expectedRunIds: ["run-1", "run-2"] },
  );

  assert.equal(summary.passed, false);
  assert.equal(summary.inventoryStable, false);
  assert.deepEqual(summary.canonicalCaseIds, ["goal", "repro"]);
  assert.deepEqual(summary.runInventories, [
    {
      runId: "run-1",
      caseIds: ["goal"],
      missingCaseIds: ["repro"],
      unexpectedCaseIds: [],
    },
    {
      runId: "run-2",
      caseIds: ["goal", "repro"],
      missingCaseIds: [],
      unexpectedCaseIds: [],
    },
  ]);
  const goal = summary.cases.find((entry) => entry.caseId === "goal");
  const repro = summary.cases.find((entry) => entry.caseId === "repro");
  assert.ok(goal);
  assert.ok(repro);
  assert.equal(goal.flaky, true);
  assert.equal(goal.passRate, 0.5);
  assert.equal(goal.failureRate, 0.5);
  assert.deepEqual(goal.failureSamples, ["stale settlement applied"]);
  assert.equal(repro.flaky, true);
  assert.deepEqual(repro.missingRunIds, ["run-1"]);
  assert.equal(summary.totals.missingSamples, 1);
});

test("repeated behavior CE rejects duplicate samples and unexpected runs", () => {
  const summary = summarizeSparkBehaviorCe(
    [
      sample("run-1", "loop", true, 5),
      sample("run-1", "loop", true, 6),
      sample("run-extra", "loop", true, 5),
    ],
    { expectedRunIds: ["run-1"], expectedCaseIds: ["loop"] },
  );

  assert.equal(summary.passed, false);
  assert.equal(summary.inventoryStable, false);
  assert.deepEqual(summary.duplicateSamples, [{ runId: "run-1", caseId: "loop" }]);
  assert.deepEqual(summary.unexpectedRunIds, ["run-extra"]);
});

test("repeated behavior CE keeps failure and duration budgets independent", () => {
  const samples = [
    sample("run-1", "repro", true, 10),
    sample("run-2", "repro", true, 20),
    sample("run-3", "repro", true, 30),
    { ...sample("run-4", "repro", false, 50), failure: "recover ask missing" },
  ];
  const durationFailure = summarizeSparkBehaviorCe(samples, {
    expectedRunIds: ["run-1", "run-2", "run-3", "run-4"],
    expectedCaseIds: ["repro"],
    maxFailureRate: 0.25,
    maxDurationP95Ms: 40,
  });
  const allowed = summarizeSparkBehaviorCe(samples, {
    expectedRunIds: ["run-1", "run-2", "run-3", "run-4"],
    expectedCaseIds: ["repro"],
    maxFailureRate: 0.25,
    maxDurationP95Ms: 50,
  });

  assert.equal(durationFailure.inventoryStable, true);
  assert.equal(durationFailure.passed, false);
  assert.deepEqual(durationFailure.cases[0]?.violations, [
    "duration_p95_ms observed=50 maximum=40",
  ]);
  assert.equal(allowed.passed, true);
  assert.equal(allowed.cases[0]?.failureRate, 0.25);
});

test("numeric CE summaries make zero-mean variability explicit", () => {
  assert.deepEqual(summarizeSparkBehaviorCeNumbers([-1, 1]), {
    count: 2,
    min: -1,
    max: 1,
    mean: 0,
    p50: -1,
    p95: 1,
    coefficientOfVariation: null,
  });
  assert.equal(summarizeSparkBehaviorCeNumbers([]), undefined);
});

function sample(
  runId: string,
  caseId: string,
  passed: boolean,
  durationMs: number,
  metrics?: Record<string, number>,
): SparkBehaviorCeSample {
  return { runId, caseId, passed, durationMs, ...(metrics ? { metrics } : {}) };
}
