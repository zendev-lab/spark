import assert from "node:assert/strict";
import { join } from "node:path";

import { test } from "vitest";

import { defaultArtifactStore } from "./artifact/store.ts";
import { defaultEvidenceStore } from "./index.ts";

test("sparkStateRoot override that is not named .spark owns artifact and evidence default paths", () => {
  const cwd = "/tmp/spark-workspace-state-path/workspace";
  const sparkStateRoot = "/tmp/spark-workspace-state-path/custom-state";
  const ctx = { sparkStateRoot };
  assert.equal(defaultArtifactStore(cwd, ctx).rootDir, join(sparkStateRoot, "artifacts"));
  assert.equal(defaultEvidenceStore(cwd, ctx).rootDir, join(sparkStateRoot, "evidence"));
  assert.ok(!defaultArtifactStore(cwd, ctx).rootDir.startsWith(join(cwd, ".spark")));
  assert.ok(!defaultEvidenceStore(cwd, ctx).rootDir.startsWith(join(cwd, ".spark")));
});
