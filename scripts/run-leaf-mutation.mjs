#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { loadMutationLedger } from "./check-mutation-ce-ownership.mjs";

const { includedEntries } = loadMutationLedger();
const requested = new Set(process.argv.slice(2));
const known = new Set(includedEntries.map((entry) => entry.name));
const unknown = [...requested].filter((name) => !known.has(name));
if (unknown.length > 0) {
  console.error("[mutation] unknown or deferred package(s): " + unknown.join(", "));
  process.exit(1);
}
const selected = requested.size
  ? includedEntries.filter((entry) => requested.has(entry.name))
  : includedEntries;
if (selected.length === 0) {
  console.error("[mutation] no included mutation packages selected");
  process.exit(1);
}

let failed = 0;
for (const entry of selected) {
  console.log("\n=== mutation: " + entry.name + " ===");
  console.log("$ " + entry.command + "\n");
  const result = spawnSync(entry.command, {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(
      "\n[mutation] " + entry.name + " exited " + (result.status ?? "signal") + "\n",
    );
  }
}
if (failed > 0) {
  console.error("[mutation] " + failed + "/" + selected.length + " package(s) failed");
  process.exit(1);
}
console.log(`[mutation] ${selected.length}/${selected.length} package(s) completed`);
