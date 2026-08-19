#!/usr/bin/env -S node --experimental-strip-types

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const model = process.env.SPARK_REPRO_LIVE_MODEL?.trim();
if (!model || !model.includes("/") || model.startsWith("spark-scripted/")) {
  throw new Error(
    "SPARK_REPRO_LIVE_MODEL must name a configured real provider/model; scripted providers are rejected",
  );
}

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vp",
    "test",
    "run",
    "--config",
    "vitest.journey.config.ts",
    "test/journey/repro-golden-journey.test.ts",
    "-t",
    "real configured model completes a compacted multi-repository Repro",
  ],
  {
    cwd: repositoryRoot,
    env: { ...process.env, CI: "1" },
    stdio: "inherit",
    timeout: 900_000,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
