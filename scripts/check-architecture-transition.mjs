#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateArchitectureTransitionFromGitRef } from "./architecture-governance-transition.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let baseRef;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--") continue;
  if (arg === "--base-ref") {
    baseRef = args[index + 1];
    if (!baseRef || baseRef.startsWith("--")) {
      throw new Error("--base-ref requires one git ref");
    }
    index += 1;
    continue;
  }
  throw new Error(`Unknown architecture transition option: ${arg}`);
}
if (!baseRef) throw new Error("Architecture transition check requires --base-ref <git-ref>");

const currentInventory = JSON.parse(
  readFileSync(path.join(rootDir, "architecture/packages.json"), "utf8"),
);
const failures = validateArchitectureTransitionFromGitRef(rootDir, baseRef, currentInventory);
if (failures.length > 0) {
  console.error(`Architecture transition from ${baseRef} failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Architecture transition from ${baseRef} passed.`);
}
