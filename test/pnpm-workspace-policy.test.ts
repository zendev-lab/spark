import assert from "node:assert/strict";
import { test } from "vitest";

import { validatePnpmWorkspacePolicy } from "../scripts/check-pnpm-workspace-policy.mjs";

test("pnpm workspace policy keeps hook-time dependency checks read-only", () => {
  assert.deepEqual(validatePnpmWorkspacePolicy("verifyDepsBeforeRun: warn\n"), []);
  assert.match(
    validatePnpmWorkspacePolicy("verifyDepsBeforeRun: install\n").join("\n"),
    /must remain warn/u,
  );
});
