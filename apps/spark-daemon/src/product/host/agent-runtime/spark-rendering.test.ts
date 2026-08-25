import assert from "node:assert/strict";
import { test } from "vitest";

import { taskViewFromCandidate } from "./view-projection.ts";

test("task view projection rejects mixed evidence and Artifact prefixes", () => {
  assert.equal(
    taskViewFromCandidate(
      {
        ref: "task:mixed-evidence",
        title: "Mixed evidence",
        status: "running",
        evidenceRefs: ["evidence:ok", "artifact:wrong-lane"],
      },
      {},
    ),
    undefined,
  );
  assert.equal(
    taskViewFromCandidate(
      {
        ref: "task:mixed-product",
        title: "Mixed product",
        status: "running",
        artifactRefs: ["artifact:ok", "evidence:wrong-lane"],
      },
      {},
    ),
    undefined,
  );
});
