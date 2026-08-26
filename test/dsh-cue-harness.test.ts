import assert from "node:assert/strict";
import { test } from "vitest";

import { runDshCueHarness } from "../scripts/dsh-cue-harness.mts";

test("dsh-cue harness reports blockers when cue-tui is missing", async () => {
  const report = await runDshCueHarness({
    strict: false,
    exercise: false,
    outputPath: "/tmp/dsh-cue-harness-unit-test.json",
  });
  assert.equal(report.backend, "cue");
  assert.equal(typeof report.capabilities.cueTuiAvailable, "boolean");
  if (!report.capabilities.cueTuiAvailable) {
    assert.match(report.blockers.join("\n"), /cue-tui is not available/u);
  }
});
