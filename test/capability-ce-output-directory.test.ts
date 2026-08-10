import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { assertSafeCapabilityCeOutputDirectory } from "../scripts/capability-ce-output-directory.mts";

test("capability CE output cleanup cannot traverse reports symlinks", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "spark-capability-ce-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "spark-capability-ce-outside-"));
  try {
    const reportsRoot = join(repositoryRoot, "reports");
    await mkdir(reportsRoot, { recursive: true });
    await symlink(outside, join(reportsRoot, "redirect"));

    await assert.rejects(
      assertSafeCapabilityCeOutputDirectory({
        repositoryRoot,
        outputDir: join(reportsRoot, "redirect", "run"),
      }),
      /must not traverse a symbolic link/u,
    );
    await assert.doesNotReject(
      assertSafeCapabilityCeOutputDirectory({
        repositoryRoot,
        outputDir: join(reportsRoot, "capability-ce"),
      }),
    );
  } finally {
    await Promise.all([
      rm(repositoryRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
