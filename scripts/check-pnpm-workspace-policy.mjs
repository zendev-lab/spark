#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const workspacePath = resolve(import.meta.dirname, "..", "pnpm-workspace.yaml");

export function validatePnpmWorkspacePolicy(source) {
  return /^verifyDepsBeforeRun:\s*warn\s*$/mu.test(source)
    ? []
    : [
        "pnpm-workspace.yaml: verifyDepsBeforeRun must remain warn so hooks do not mutate hidden manifests",
      ];
}

async function main() {
  const violations = validatePnpmWorkspacePolicy(await readFile(workspacePath, "utf8"));
  if (violations.length > 0) {
    console.error("pnpm workspace policy failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("pnpm workspace policy passed (hook-time dependency checks are read-only).");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
