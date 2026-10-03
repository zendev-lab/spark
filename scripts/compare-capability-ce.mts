#!/usr/bin/env -S node --experimental-strip-types

import { readFile } from "node:fs/promises";
import { compareCapabilityCeExperiments } from "./capability-ce-experiment.mts";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(
    "Usage: node scripts/compare-capability-ce.mts <baseline/experiment.json> <candidate/experiment.json>\n",
  );
} else {
  if (args.length !== 2)
    throw new Error("Expected baseline and candidate experiment JSON paths; use --help");
  const [baseline, candidate] = await Promise.all(
    args.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  const comparison = compareCapabilityCeExperiments(baseline, candidate);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  process.exitCode = comparison.status === "improved" || comparison.status === "unchanged" ? 0 : 1;
}
