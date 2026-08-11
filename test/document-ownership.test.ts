import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import { findDocumentOwnershipFailures } from "../scripts/check-document-ownership.mjs";

test("document ownership accepts durable contracts and procedures", async () => {
  await withFixture(
    {
      "SPARK.md": "# Project intent\n\n## Current direction\n\nKeep one owner.\n",
      "docs/specs/session.md":
        "# Session contract\n\n## Migration invariants\n\nReads are idempotent.\n",
      "docs/operations/release.md": "# Release\n\n## Rollback\n\nRestore the snapshot.\n",
      "packages/example/README.md": "# example\n\nOwns the example contract.\n",
    },
    async (root) => {
      assert.deepEqual(await findDocumentOwnershipFailures(root), []);
    },
  );
});

test("document ownership rejects transient plans and checked-in run results", async () => {
  await withFixture(
    {
      "SPARK.md": "# Project intent\n\n## 近期收尾任务\n\n- merged already\n",
      "docs/specs/session.md": "# Session contract\n\n## Implementation sequence\n\n### PR 1\n",
      "docs/specs/pr-link.md": "# Delivery contract\n\nTracked by GitHub PR **#42**.\n",
      "docs/operations/release.md":
        "# Release\n\n## Timing comparison (local)\n\n| Run | Seconds |\n",
      "docs/operations/scores.md": "# Mutation\n\n### L1 smoke scores\n\n| Package | Score |\n",
      "packages/example/MERGE-EVAL.md": "# Merge evaluation\n",
    },
    async (root) => {
      const failures = await findDocumentOwnershipFailures(root);
      assert.equal(failures.length, 6);
      assert.ok(failures.some((failure) => failure.startsWith("SPARK.md:")));
      assert.ok(failures.some((failure) => failure.startsWith("docs/specs/session.md:")));
      assert.ok(failures.some((failure) => failure.startsWith("docs/specs/pr-link.md:")));
      assert.ok(failures.some((failure) => failure.startsWith("docs/operations/release.md:")));
      assert.ok(failures.some((failure) => failure.startsWith("docs/operations/scores.md:")));
      assert.ok(failures.some((failure) => failure.startsWith("packages/example/MERGE-EVAL.md:")));
    },
  );
});

async function withFixture(files: Record<string, string>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "spark-document-ownership-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
