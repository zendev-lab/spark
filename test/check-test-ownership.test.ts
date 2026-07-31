import assert from "node:assert/strict";
import { readBaselinePaths } from "../scripts/check-test-ownership.mjs";
import { test } from "vitest";

const commit = "c1f98a9707ac7fd76eb916e7a6216fda86098b39";

test("ownership baseline remains immutable when origin/main advances", () => {
  const before = readBaselinePaths(process.cwd(), commit);
  assert.equal(before.length, 130);
  assert.deepEqual(readBaselinePaths(process.cwd(), commit), before);
});

test("ownership baseline rejects invalid and missing commit OIDs fail closed", () => {
  assert.throws(() => readBaselinePaths(process.cwd(), "not-a-commit"), /complete 40-hex/u);
  assert.throws(
    () => readBaselinePaths(process.cwd(), "0000000000000000000000000000000000000000"),
    /does not resolve/u,
  );
});
