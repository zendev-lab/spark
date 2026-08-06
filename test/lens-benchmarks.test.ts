import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_GROUP_COUNT,
  PATCH_EDIT_COUNT,
  runDiagnosticAggregationCase,
  runPatchProposalCase,
  runStableJsonCase,
  STABLE_JSON_ITEM_COUNT,
} from "../benchmarks/lens/production-path-cases.ts";

describe("Lens benchmark correctness", () => {
  it("serializes every nested input record deterministically", () => {
    const first = runStableJsonCase();
    expect(first).toBe(runStableJsonCase());
    expect(first.match(/item-/gu)).toHaveLength(STABLE_JSON_ITEM_COUNT);
  });

  it("aggregates the expected diagnostic groups with corroborated providers", () => {
    const observations = runDiagnosticAggregationCase();
    expect(observations).toHaveLength(DIAGNOSTIC_GROUP_COUNT);
    expect(observations.every((observation) => observation.agreement === "corroborated")).toBe(
      true,
    );
    expect(observations.filter((observation) => observation.severity === "error")).toHaveLength(50);
  });

  it("normalizes and digests every patch edit", () => {
    const proposal = runPatchProposalCase();
    expect(proposal.edits).toHaveLength(PATCH_EDIT_COUNT);
    expect(proposal.preconditions).toHaveLength(50);
    expect(proposal.ref).toMatch(/^patch-proposal:[a-f0-9]{64}$/u);
    expect(proposal.ref).toBe(runPatchProposalCase().ref);
  });
});
