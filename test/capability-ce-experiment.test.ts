import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import {
  captureCapabilityCeSnapshot,
  compareCapabilityCeExperiments,
  type CapabilityCeExperiment,
} from "../scripts/capability-ce-experiment.mts";

function experiment(): CapabilityCeExperiment {
  const snapshot = {
    commitSha: "a".repeat(40),
    clean: true,
    evaluatorDigest: "b".repeat(64),
    dependencyDigest: "c".repeat(64),
    environment: { node: "v24.0.0", platform: "linux", release: "6", arch: "x64", cpu: "test-cpu" },
  };
  return {
    schema: "spark.capability-ce-experiment/v1",
    before: structuredClone(snapshot),
    after: structuredClone(snapshot),
    configuration: {
      runs: 2,
      maxFailureRate: 0,
      maxDurationP95Ms: 1000,
      runTimeoutMs: 10000,
      providerTokenPolicy: "zero",
    },
    invalidRunIds: [],
    samples: ["run-01", "run-02"].flatMap((runId) =>
      ["@runner", "goal", "repro"].map((caseId) => ({
        runId,
        caseId,
        passed: true,
        durationMs: 20,
      })),
    ),
  };
}

test("compares observed failures without awarding faster timings a capability improvement", () => {
  const baseline = experiment();
  const candidate = experiment();
  candidate.before.commitSha = candidate.after.commitSha = "d".repeat(40);
  candidate.samples.forEach((sample) => {
    sample.durationMs = 1;
  });
  const unchanged = compareCapabilityCeExperiments(baseline, candidate);
  assert.equal(unchanged.status, "unchanged");
  assert.notEqual(unchanged.baselineExperimentDigest, unchanged.candidateExperimentDigest);
  assert.equal(unchanged.cases.find((entry) => entry.caseId === "goal")?.candidateDurationP95Ms, 1);
  baseline.samples.find((sample) => sample.caseId === "goal")!.passed = false;
  const improved = compareCapabilityCeExperiments(baseline, candidate);
  assert.equal(improved.status, "improved");
  assert.notEqual(improved.baselineExperimentDigest, unchanged.baselineExperimentDigest);
  assert.equal(improved.candidateExperimentDigest, unchanged.candidateExperimentDigest);
  assert.equal(compareCapabilityCeExperiments(candidate, baseline).status, "candidate_failed");
});

test("rejects a per-case regression even when aggregate failures improve", () => {
  const baseline = experiment();
  const candidate = experiment();
  baseline.configuration.maxFailureRate = candidate.configuration.maxFailureRate = 1;
  baseline.samples
    .filter((sample) => sample.caseId === "goal")
    .forEach((sample) => {
      sample.passed = false;
    });
  candidate.samples.find((sample) => sample.caseId === "repro")!.passed = false;
  const result = compareCapabilityCeExperiments(baseline, candidate);
  assert.equal(result.status, "regressed");
  assert.deepEqual(result.reasons, ["additional failures: repro"]);
});

test("candidate acceptance budgets remain mandatory", () => {
  const candidate = experiment();
  candidate.samples[0]!.durationMs = 2000;
  assert.equal(compareCapabilityCeExperiments(experiment(), candidate).status, "candidate_failed");
});

test("incomplete, duplicate, changed, or invalid run evidence is incomparable", () => {
  const mutations: Array<(value: CapabilityCeExperiment) => void> = [
    (value) => {
      value.samples.pop();
    },
    (value) => {
      value.samples.push({ ...value.samples[0]! });
    },
    (value) => {
      value.samples = value.samples.filter((sample) => sample.runId !== "run-02");
    },
    (value) => {
      value.samples.forEach((sample) => {
        if (sample.caseId === "goal") sample.caseId = "different";
      });
    },
    (value) => {
      value.samples = value.samples.filter((sample) => sample.caseId !== "@runner");
    },
    (value) => {
      value.invalidRunIds.push("run-01");
    },
    (value) => {
      value.before.clean = false;
    },
    (value) => {
      value.after.commitSha = "e".repeat(40);
    },
    (value) => {
      value.before.evaluatorDigest = value.after.evaluatorDigest = "e".repeat(64);
    },
    (value) => {
      value.before.dependencyDigest = value.after.dependencyDigest = "e".repeat(64);
    },
    (value) => {
      value.before.environment.node = value.after.environment.node = "v25.0.0";
    },
    (value) => {
      value.configuration.maxFailureRate = 0.5;
    },
  ];
  for (const mutate of mutations) {
    const candidate = experiment();
    mutate(candidate);
    assert.equal(compareCapabilityCeExperiments(experiment(), candidate).status, "incomparable");
    assert.equal(compareCapabilityCeExperiments(candidate, experiment()).status, "incomparable");
  }
});

test("validates artifact versions, unknown fields, and numeric measurements", () => {
  const baseline = experiment();
  for (const value of [
    { ...baseline, schema: "spark.capability-ce/v1" },
    { ...baseline, summary: { passed: true } },
    { ...baseline, samples: [{ ...baseline.samples[0], durationMs: undefined }] },
    { ...baseline, samples: [{ ...baseline.samples[0], durationMs: NaN }] },
    { ...baseline, samples: [{ ...baseline.samples[0], durationMs: -1 }] },
  ])
    assert.throws(
      () => compareCapabilityCeExperiments(baseline, value),
      /Invalid capability CE experiment/u,
    );
});

test("captures real Git provenance and fingerprints evaluator support independently of production", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-ce-snapshot-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    await mkdir(join(root, "test"), { recursive: true });
    await mkdir(join(root, "apps/spark-daemon/src/product/host/agent-runtime"), {
      recursive: true,
    });
    for (const path of [
      ".node-version",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "test/check.test.ts",
      "test/helper.ts",
      "runtime.ts",
      "apps/spark-daemon/src/product/host/agent-runtime/behavior-ce.ts",
    ]) {
      await writeFile(join(root, path), "initial\n");
    }
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=CE Test",
      "-c",
      "user.email=ce@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    const before = await captureCapabilityCeSnapshot(root, ["test/check.test.ts"]);
    assert.equal(before.clean, true);
    assert.equal(before.commitSha, git("rev-parse", "HEAD").toString().trim());
    await writeFile(join(root, "runtime.ts"), "changed implementation\n");
    const changedRuntime = await captureCapabilityCeSnapshot(root, ["test/check.test.ts"]);
    assert.equal(changedRuntime.clean, false);
    assert.equal(changedRuntime.evaluatorDigest, before.evaluatorDigest);
    await writeFile(join(root, "test/helper.ts"), "changed fixture\n");
    assert.notEqual(
      (await captureCapabilityCeSnapshot(root, ["test/check.test.ts"])).evaluatorDigest,
      before.evaluatorDigest,
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "changed dependencies\n");
    assert.notEqual(
      (await captureCapabilityCeSnapshot(root, ["test/check.test.ts"])).dependencyDigest,
      before.dependencyDigest,
    );
    await assert.rejects(captureCapabilityCeSnapshot(root, ["test/deleted.test.ts"]), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison CLI emits JSON and fails on incomparable reports without rewriting input", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-ce-compare-"));
  const baselinePath = join(root, "baseline.json");
  const candidatePath = join(root, "candidate.json");
  const cli = resolve(import.meta.dirname, "../scripts/compare-capability-ce.mts");
  try {
    const baselineText = JSON.stringify(experiment());
    await writeFile(baselinePath, baselineText);
    await writeFile(candidatePath, baselineText);
    const valid = spawnSync(process.execPath, [cli, baselinePath, candidatePath], {
      encoding: "utf8",
    });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).status, "unchanged");
    const candidate = experiment();
    candidate.before.clean = false;
    await writeFile(candidatePath, JSON.stringify(candidate));
    const invalid = spawnSync(process.execPath, [cli, baselinePath, candidatePath], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(JSON.parse(invalid.stdout).status, "incomparable");
    assert.equal(await readFile(baselinePath, "utf8"), baselineText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
