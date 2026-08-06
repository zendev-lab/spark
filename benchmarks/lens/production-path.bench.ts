import { bench, describe } from "vitest";

import {
  runDiagnosticAggregationCase,
  runPatchProposalCase,
  runStableJsonCase,
} from "./production-path-cases.ts";

describe("Spark Lens production paths", () => {
  bench("stableJson: 1,024 nested records", () => {
    runStableJsonCase();
  });

  bench("aggregateDiagnosticFindings: 1,000 findings / 500 groups", () => {
    runDiagnosticAggregationCase();
  });

  bench("createPatchProposal: 500 edits / 50 preconditions", () => {
    runPatchProposalCase();
  });
});
