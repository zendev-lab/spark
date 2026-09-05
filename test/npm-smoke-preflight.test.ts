import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { test } from "vitest";

import { nativeNpmDistributions } from "../scripts/npm-distributions.mjs";

const execFileAsync = promisify(execFile);

test("source npm smoke fails early with an actionable native-payload diagnostic", async () => {
  const emptyNativeRoot = await mkdtemp(join(tmpdir(), "spark-native-payloads-test-"));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ["scripts/smoke-npm-product.mjs"], {
        cwd: process.cwd(),
        env: { ...process.env, SPARK_NATIVE_BIN_DIR: emptyNativeRoot },
        timeout: 30_000,
      }),
      (error: Error & { stderr?: string }) => {
        const stderr = error.stderr ?? "";
        assert.match(stderr, /\[NATIVE_PAYLOADS_MISSING\]/u);
        for (const distribution of nativeNpmDistributions) {
          assert.ok(stderr.includes(distribution.target));
        }
        return true;
      },
    );
  } finally {
    await rm(emptyNativeRoot, { recursive: true, force: true });
  }
});
