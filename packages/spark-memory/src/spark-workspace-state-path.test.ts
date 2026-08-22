import assert from "node:assert/strict";
import { join } from "node:path";

import { test } from "vitest";

import { defaultSparkMemoryStore, sparkMemoryStorePath } from "./index.ts";

test("sparkStateRoot override that is not named .spark owns memory default paths", () => {
  const cwd = "/tmp/spark-workspace-state-path/workspace";
  const sparkStateRoot = "/tmp/spark-workspace-state-path/custom-state";
  const ctx = { sparkStateRoot };
  const memoryPath = sparkMemoryStorePath(cwd, "workspace", {}, ctx);
  assert.equal(memoryPath, join(sparkStateRoot, "memory", "memory.json"));
  assert.equal(
    defaultSparkMemoryStore(cwd, "workspace", undefined, undefined, ctx).filePath,
    memoryPath,
  );
  assert.ok(!memoryPath.includes(`${join(cwd, ".spark")}`));
});
