import assert from "node:assert/strict";
import { test } from "vitest";

import { SPARK_PROTOCOL_VERSION, type SparkRunView } from "@zendev-lab/spark-protocol";

import {
  footerTokensPerSecond,
  formatFooterMetrics,
  formatFooterTokensPerSecond,
  ownerTreeRunDurationMs,
} from "./footer-metrics.ts";

function runView(input: { id: string; startedAt?: string; completedAt?: string }): SparkRunView {
  return {
    version: SPARK_PROTOCOL_VERSION,
    id: input.id,
    kind: "session",
    status: "succeeded",
    evidenceRefs: [],
    artifactRefs: [],
    metadata: {},
    ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
}

test("formats finite positive TPM and hides missing or non-positive rates", () => {
  assert.equal(formatFooterTokensPerSecond(12.34), "12.3 t/s");
  assert.equal(formatFooterTokensPerSecond(undefined), undefined);
  assert.equal(formatFooterTokensPerSecond(0), undefined);
  assert.equal(formatFooterTokensPerSecond(-1), undefined);
  assert.equal(formatFooterTokensPerSecond(Number.POSITIVE_INFINITY), undefined);
  assert.equal(formatFooterTokensPerSecond(Number.NaN), undefined);
  assert.match(
    formatFooterMetrics({ outputTokens: 123, tokensPerSecond: 12.3 }, true) ?? "",
    /↓123 12\.3 t\/s/,
  );
  assert.doesNotMatch(
    formatFooterMetrics({ outputTokens: 123, tokensPerSecond: 0 }, true) ?? "",
    /t\/s/,
  );
});

test("computes owner-tree TPM from output tokens and completed run span", () => {
  const durationMs = ownerTreeRunDurationMs([
    runView({
      id: "run:early",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:04.000Z",
    }),
    runView({
      id: "run:late",
      startedAt: "2026-08-17T00:00:02.000Z",
      completedAt: "2026-08-17T00:00:10.000Z",
    }),
  ]);
  assert.equal(durationMs, 10_000);
  assert.equal(footerTokensPerSecond(123, durationMs), 12.3);
  assert.equal(footerTokensPerSecond(0, durationMs), undefined);
  assert.equal(footerTokensPerSecond(123, 0), undefined);
  assert.equal(footerTokensPerSecond(123, undefined), undefined);
  assert.equal(
    ownerTreeRunDurationMs([runView({ id: "run:open", startedAt: "2026-08-17T00:00:00.000Z" })]),
    undefined,
  );
});
