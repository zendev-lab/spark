#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { loadMutationLedger } from "./check-mutation-ce-ownership.mjs";

const { includedPackageIds } = loadMutationLedger();
let failed = 0;
for (const name of includedPackageIds) {
  console.log("\n=== mutation: " + name + " ===\n");
  const result = spawnSync("pnpm", ["--filter", name, "exec", "stryker", "run"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    failed += 1;
    console.error("\n[mutation] " + name + " exited " + (result.status ?? "signal") + "\n");
  }
}
if (failed > 0) {
  console.error("[mutation] " + failed + "/" + includedPackageIds.length + " package(s) failed");
  process.exit(1);
}
console.log(
  `[mutation] ${includedPackageIds.length}/${includedPackageIds.length} package(s) completed`,
);
