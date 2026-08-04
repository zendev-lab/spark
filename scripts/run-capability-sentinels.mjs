#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { capabilitySentinelCommand } from "./capability-sentinel-suite.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const result = spawnSync("pnpm", capabilitySentinelCommand(), {
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
