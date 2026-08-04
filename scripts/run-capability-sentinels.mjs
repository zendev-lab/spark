#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const testFiles = [
  "src/spark-tools-capability-sentinel.test.ts",
  "src/spark-tools-repro-lifecycle.test.ts",
  "src/store/loop-cycle-review.test.ts",
  "src/spark/loop-goal-settlements.test.ts",
  "src/spark/repro-loop-evaluator.test.ts",
];
const command = ["--filter", "@zendev-lab/spark-daemon", "exec", "vp", "test", "run", ...testFiles];
const result = spawnSync("pnpm", command, {
  cwd: repositoryRoot,
  env: { ...process.env, SPARK_CAPABILITY_SENTINEL: "1" },
  stdio: "inherit",
});

if (result.error) {
  console.error(`Capability sentinel runner failed to start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
