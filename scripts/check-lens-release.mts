#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import {
  evaluateLensScorecard,
  type LensReleaseScorecard,
  type LensScorecardMeasurements,
} from "../packages/spark-lens/src/scorecard.ts";
import { jsonFile, lensFixtureDigest } from "./lens-scorecard-io.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDigest = await lensFixtureDigest(root);
const configuredScorecard = process.env.SPARK_LENS_SCORECARD?.trim();
const scorecard = configuredScorecard
  ? await jsonFile<LensReleaseScorecard>(resolve(root, configuredScorecard))
  : evaluateLensScorecard(
      await jsonFile<LensScorecardMeasurements>(
        resolve(root, "benchmarks/lens/pending-measurements.fixture.json"),
      ),
      fixtureDigest,
    );
const evaluated = evaluateLensScorecard(scorecard.measurements, fixtureDigest);
const violations: string[] = [];

if (
  scorecard.measurements.baseline.package !== "pi-lens" ||
  scorecard.measurements.baseline.version !== "3.8.73" ||
  scorecard.measurements.baseline.commit !== "dc4d6f4d5dfd0d5ddbc6a473efac9e9d1ea84d57"
) {
  violations.push("scorecard baseline is not pi-lens@3.8.73 dc4d6f4");
}
if (scorecard.fixtureDigest !== fixtureDigest) {
  violations.push("scorecard fixture digest is stale");
}
if (
  !isDeepStrictEqual(scorecard.gates, evaluated.gates) ||
  scorecard.overall !== evaluated.overall
) {
  violations.push("scorecard gates do not match the machine evaluator");
}

const extensionSource = await readFile(
  resolve(
    root,
    process.env.SPARK_LENS_REGISTRATION_SOURCE ?? "packages/spark-extension/src/extension/index.ts",
  ),
  "utf8",
);
const publicRegistration = /registerSparkTool\(\s*createSparkLensToolConfig\(\)\s*\)/u.test(
  extensionSource,
);
const internalRegistration =
  /registerSparkImplementationTool\(\s*createSparkLensToolConfig\(\)\s*\)/u.test(extensionSource);
if (!internalRegistration && !publicRegistration) {
  violations.push("Lens tool registration is missing");
}

const publicFiles = [
  resolve(root, "README.md"),
  ...(await filesUnder(resolve(root, "apps/spark-docs/src/content/docs"))),
];
const publicText = (
  await Promise.all(publicFiles.map(async (path) => await readFile(path, "utf8")))
).join("\n");
const publicDocumentation = /\bSpark Lens\b|spark\s+lens\b|lens\s*\(\s*\{/iu.test(publicText);
const leadingClaim =
  /(?:outperform(?:s|ed|ing)?|faster than|better than)\s+pi-lens|(?:超越|领先于)\s*pi-lens/iu.test(
    publicText,
  );

if (scorecard.overall !== "pass") {
  if (publicRegistration) violations.push("Lens is public before every scorecard gate passes");
  if (publicDocumentation) {
    violations.push("Lens is documented as public before every scorecard gate passes");
  }
  if (leadingClaim) violations.push("Lens claims leadership before every scorecard gate passes");
}

if (violations.length > 0) {
  throw new Error(`Spark Lens release gate failed:\n- ${violations.join("\n- ")}`);
}
process.stdout.write(
  scorecard.overall === "pass"
    ? "Spark Lens release scorecard passes; public enablement is permitted.\n"
    : `Spark Lens release gate remains closed (${scorecard.overall}); internal registration verified.\n`,
);

async function filesUnder(path: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(child)));
    else if (entry.isFile() && /\.mdx?$/u.test(entry.name)) output.push(child);
  }
  return output;
}
