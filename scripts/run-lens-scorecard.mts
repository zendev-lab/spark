#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateLensScorecard,
  type LensScorecardMeasurements,
} from "../packages/spark-lens/src/scorecard.ts";
import { jsonFile, lensFixtureDigest } from "./lens-scorecard-io.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const measurementsPath = resolve(root, process.argv[2] ?? "benchmarks/lens/measurements.json");
const outputPath = resolve(root, process.argv[3] ?? "benchmarks/lens/scorecard.json");
const measurements = await jsonFile<LensScorecardMeasurements>(measurementsPath);
const scorecard = evaluateLensScorecard(measurements, await lensFixtureDigest(root));
await writeFile(outputPath, `${JSON.stringify(scorecard, null, 2)}\n`);
process.stdout.write(
  `Spark Lens scorecard ${scorecard.overall}: ${outputPath.replace(`${root}/`, "")}\n`,
);
