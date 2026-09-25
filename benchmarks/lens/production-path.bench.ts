import { test } from "vitest";

import {
  runDiagnosticAggregationCase,
  runPatchProposalCase,
  runStableJsonCase,
} from "./production-path-cases.ts";

test("Spark Lens production paths", async ({ bench }) => {
  await bench("stableJson: 1,024 nested records", () => {
    runStableJsonCase();
  }).run();

  await bench("aggregateDiagnosticFindings: 1,000 findings / 500 groups", () => {
    runDiagnosticAggregationCase();
  }).run();

  await bench("createPatchProposal: 500 edits / 50 preconditions", () => {
    runPatchProposalCase();
  }).run();
});
