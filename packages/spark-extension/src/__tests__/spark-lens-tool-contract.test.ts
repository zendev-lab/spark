import assert from "node:assert/strict";
import { test } from "vitest";
import { createSparkLensToolConfig } from "../extension/spark-lens-tool.ts";

test("lens tool exposes the canonical action ADT", () => {
  const schema = JSON.stringify(createSparkLensToolConfig().parameters);
  for (const action of ["status", "inspect", "check", "fix", "triage", "verify"]) {
    assert.ok(schema.includes(`\"const\":\"${action}\"`));
  }
  for (const retired of ["health", "propose_patch", "apply_patch"]) {
    assert.equal(schema.includes(`\"const\":\"${retired}\"`), false);
  }
});
