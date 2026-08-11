import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";

import {
  LENS_REQUIRED_CAPABILITIES,
  evaluateLensScorecard,
  type LensScorecardMeasurements,
} from "@zendev-lab/spark-lens";
import { lensFixtureDigest } from "../scripts/lens-scorecard-io.mts";

test("Lens benchmark fixtures cover every language surface and declared fault", async () => {
  const tasks = JSON.parse(await readFile("benchmarks/lens/tasks.json", "utf8")) as {
    tasks: {
      id: string;
      language: "typescript" | "python" | "rust";
      capabilities: string[];
      faultInjection?: string;
    }[];
  };
  const faults = JSON.parse(await readFile("benchmarks/lens/fault-injections.json", "utf8")) as {
    cases: { id: string }[];
  };
  const faultIds = new Set(faults.cases.map((item) => item.id));
  for (const language of ["typescript", "python", "rust"] as const) {
    const languageTasks = tasks.tasks.filter((task) => task.language === language);
    assert.ok(languageTasks.length >= 3, `${language} requires at least three fixed tasks`);
    const capabilities = new Set(languageTasks.flatMap((task) => task.capabilities));
    assert.deepEqual(
      LENS_REQUIRED_CAPABILITIES.filter((capability) => !capabilities.has(capability)),
      [],
      `${language} benchmark capability gap`,
    );
  }
  for (const task of tasks.tasks) {
    if (task.faultInjection) {
      assert.ok(faultIds.has(task.faultInjection), `${task.id} references an unknown fault`);
    }
  }
  for (const required of [
    "stale-provider-result",
    "provider-timeout",
    "provider-silence",
    "verifier-conflict",
    "file-cas-race",
    "daemon-restart",
    "orphan-provider",
    "stale-receipt-gate",
  ]) {
    assert.ok(faultIds.has(required), `missing fault injection ${required}`);
  }
});

test("pending Lens measurements keep the release gate closed", async () => {
  const measurements = JSON.parse(
    await readFile("benchmarks/lens/pending-measurements.fixture.json", "utf8"),
  ) as LensScorecardMeasurements;
  const fixtureDigest = await lensFixtureDigest(resolve("."));
  const scorecard = evaluateLensScorecard(measurements, fixtureDigest);
  assert.equal(scorecard.fixtureDigest, fixtureDigest);
  assert.equal(scorecard.overall, "pending");
});
