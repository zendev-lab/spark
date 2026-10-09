import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "vitest";
import {
  auditAcceptance,
  auditExperiment,
  unpackExperiment,
  verifyFiles,
} from "../scripts/strategy-experiment/audit.mts";
import {
  developmentFeedback,
  holdoutOrder,
  parseStrategy,
} from "../scripts/strategy-experiment/experiment.mts";
import { emptyUsage } from "../scripts/strategy-experiment/runtime.mts";
import {
  oneSidedSignTest,
  selectCandidate,
  summarizeHoldout,
  trialPassed,
  type Trial,
} from "../scripts/strategy-experiment/report.mts";
import {
  bundleTask,
  probeSandbox,
  runSandboxed,
  type Verification,
} from "../scripts/strategy-experiment/sandbox.mts";
import {
  digest,
  fencedPath,
  loadSuite,
  writeJson,
  type Budget,
  type Task,
} from "../scripts/strategy-experiment/suite.mts";

const suite = await loadSuite();
const budget = suite.protocol.budget;

test("published model experiment reproduces its full receipt without model calls", async () => {
  const dataset = new URL("../experiments/strategy-v1/results/gpt6-r1/", import.meta.url);
  const archivePath = new URL("evidence.json.gz", dataset);
  const { archiveSha256, ...receipt } = JSON.parse(
    await readFile(new URL("receipt.json", dataset), "utf8"),
  );
  assert.equal(digest(await readFile(archivePath)), archiveSha256);
  const root = await mkdtemp(join(tmpdir(), "spark-strategy-published-test-"));
  try {
    await unpackExperiment(fileURLToPath(archivePath), root);
    assert.deepEqual(await auditExperiment(root), receipt);
    const strategies = JSON.parse(await readFile(new URL("strategies.json", dataset), "utf8"));
    for (const strategy of strategies) {
      const candidate = JSON.parse(
        await readFile(join(root, "candidates", strategy.id, "candidate.json"), "utf8"),
      );
      for (const [key, value] of Object.entries(strategy)) assert.deepEqual(candidate[key], value);
    }
    const missingTrial = join(root, "trials", receipt.trials[0].id);
    await rm(missingTrial, { recursive: true });
    await assert.rejects(auditExperiment(root));
  } finally {
    await rm(root, { recursive: true });
  }
});

function trial(taskId: string, passed: boolean, tokens = 10): Trial {
  return {
    schema: "spark.strategy-trial/v1",
    id: taskId,
    taskId,
    split: "development",
    repetition: 1,
    strategyId: "baseline",
    strategyDigest: "strategy",
    freezeDigest: "freeze",
    inputSnapshotDigest: "input",
    outputSnapshotDigest: "output",
    before: {} as Trial["before"],
    after: {} as Trial["after"],
    evidenceRef: "evidence:test",
    raw: [],
    gradingDurationMs: 1,
    model: {
      startedAt: "2026-09-05T00:00:00.000Z",
      finishedAt: "2026-09-05T00:00:00.001Z",
      durationMs: 1,
      status: "completed",
      finalText: "done",
      modelCalls: 1,
      toolCalls: 1,
      usage: { ...emptyUsage(), input: tokens, totalTokens: tokens },
      budgetFailures: [],
      invalidReasons: [],
      modelIdentity: { id: "test", api: "test", baseUrl: "test", provider: "test", cost: {} },
    },
    acceptance: {
      passed,
      cases: [
        {
          id: "hidden",
          passed,
          expected: "withheld",
          actual: "observed",
          durationMs: 1,
          process: { code: 0, signal: null, stdout: '"observed"', stderr: "" },
        },
      ],
    },
  };
}

test("candidate selection enforces per-task nonregression, token ties and fallback", () => {
  const baseline = [trial("a", true), trial("b", false), trial("c", false)];
  const regressed = {
    id: "c1",
    index: 1,
    trials: [trial("a", false), trial("b", true), trial("c", true)],
  };
  const eligible = {
    id: "c2",
    index: 2,
    trials: [trial("a", true), trial("b", false), trial("c", false)],
  };
  const tied = {
    id: "c3",
    index: 3,
    trials: eligible.trials.map((entry) => trial(entry.taskId, entry.acceptance.passed, 1)),
  };
  assert.equal(selectCandidate(baseline, [regressed, eligible, tied], budget).selectedId, "c3");
  assert.deepEqual(selectCandidate(baseline, [regressed], budget).scores[0]!.regressions, ["a"]);
  assert.equal(selectCandidate(baseline, [regressed], budget).eligibilityFallback, true);
  tied.trials = eligible.trials;
  assert.equal(selectCandidate(baseline, [tied, eligible], budget).selectedId, "c2");
});

test("repetitions do not inflate the sign-test sample; improvements and regressions remain explicit", () => {
  const before = ["a", "b", "c", "d", "e"].flatMap((id) => [trial(id, false), trial(id, false)]);
  const after = before.map((entry) => trial(entry.taskId, true));
  assert.equal(oneSidedSignTest(5, 0), 0.03125);
  assert.equal(oneSidedSignTest(0, 0), 1);
  const result = summarizeHoldout(before, after, suite.protocol);
  assert.equal(result.signTest.wins, 5);
  assert.equal(result.status, "reliable_improvement_on_frozen_suite");
  after[0] = trial("a", false);
  after[1] = trial("a", false);
  assert.equal(
    summarizeHoldout(before, after, suite.protocol).status,
    "observed_improvement_uncertain",
  );
  before[0] = trial("a", true);
  assert.equal(summarizeHoldout(before, after, suite.protocol).status, "regressed");
  assert.equal(summarizeHoldout(after, after, suite.protocol).status, "no_reliable_improvement");
});

test("passing acceptance cannot hide invalid execution or exhausted budgets", () => {
  const good = trial("a", true);
  assert.equal(trialPassed(good, budget), true);
  for (const change of [
    (value: Trial) => value.model.invalidReasons.push("missing usage"),
    (value: Trial) => value.model.budgetFailures.push("tokenReservation"),
    (value: Trial) => {
      value.model.status = "aborted";
    },
    (value: Trial) => {
      value.model.usage.totalTokens = 0;
    },
    (value: Trial) => {
      value.acceptance.cases = [];
    },
  ]) {
    const bad = structuredClone(good);
    change(bad);
    assert.equal(trialPassed(bad, budget), false);
  }
  for (const key of [
    "modelCalls",
    "toolCalls",
    "totalTokens",
    "wallTimeMs",
    "maxEstimatedCostUsd",
  ] as const) {
    const limited: Budget = { ...budget, [key]: 0 };
    const value = structuredClone(good);
    value.model.usage.estimatedCostUsd = 0.01;
    assert.equal(trialPassed(value, limited), false);
  }
});

test("grader recomputes outcomes from raw observations and frozen expectations", () => {
  const cases = [{ id: "x", visibility: "hidden" as const, input: {}, expected: 42 }];
  const result: Verification = {
    passed: true,
    cases: [
      {
        id: "x",
        expected: 42,
        actual: 42,
        passed: true,
        durationMs: 1,
        process: { code: 0, signal: null, stdout: "42", stderr: "" },
      },
    ],
  };
  auditAcceptance(result, cases);
  for (const change of [
    (value: Verification) => {
      value.cases[0]!.process.stdout = "0";
    },
    (value: Verification) => {
      value.cases[0]!.expected = 0;
    },
    (value: Verification) => {
      value.cases[0]!.process.code = 1;
    },
    (value: Verification) => {
      value.cases.push(value.cases[0]!);
    },
    (value: Verification) => {
      value.cases = [];
    },
  ]) {
    const bad = structuredClone(result);
    change(bad);
    assert.throws(() => auditAcceptance(bad, cases));
  }
});

test("generator sees only development feedback and public traces, while final candidates are bounded data", () => {
  const task = suite.tasks.find((entry) => entry.split === "development")!;
  const feedback = developmentFeedback(task, trial(task.id, false), "public-only");
  assert.deepEqual(feedback.failedAcceptanceIds, ["hidden"]);
  assert.equal(JSON.stringify(feedback).includes("withheld"), false);
  assert.equal(JSON.stringify(feedback).includes("observed"), false);
  assert.throws(() =>
    developmentFeedback({ ...task, split: "holdout" }, trial(task.id, false), ""),
  );
  assert.deepEqual(parseStrategy('{"hypothesis":"h","strategy":"s"}', 1), {
    hypothesis: "h",
    strategy: "s",
  });
  for (const value of [
    '{"hypothesis":"h","strategy":"long"}',
    '{"hypothesis":"h","strategy":[]}',
    '{"hypothesis":"","strategy":"s"}',
  ])
    assert.throws(() => parseStrategy(value, 1));
  const order = holdoutOrder(suite, "candidate-1");
  assert.equal(order.length, 20);
  assert.equal(new Set(order.map((entry) => entry.id)).size, 20);
  assert.deepEqual(
    order.slice(0, 4).map((entry) => entry.strategyId),
    ["baseline", "candidate-1", "candidate-1", "baseline"],
  );
});

test("evidence rejects corruption, missing bytes, overwrites, duplicates and archive traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-strategy-evidence-test-"));
  try {
    await writeJson(join(root, "record.json"), { x: 1 });
    await assert.rejects(writeJson(join(root, "record.json"), { x: 2 }));
    const entries: Array<[string, string]> = [
      ["record.json", digest(await readFile(join(root, "record.json")))],
    ];
    await verifyFiles(root, entries);
    await assert.rejects(verifyFiles(root, [...entries, ...entries]));
    await writeFile(join(root, "record.json"), "changed");
    await assert.rejects(verifyFiles(root, entries));
    await assert.rejects(verifyFiles(root, [["missing", digest("")]]));
    await assert.rejects(verifyFiles(root, [["../escape", digest("")]]));
    await writeFile(
      join(root, "bad.gz"),
      gzipSync(
        JSON.stringify({ schema: "spark.strategy-archive/v1", files: [["../escape", "bad"]] }),
      ),
    );
    await assert.rejects(unpackExperiment(join(root, "bad.gz"), join(root, "unpack")));
  } finally {
    await rm(root, { recursive: true });
  }
});

test("source fence rejects escaping paths, symlinks and nonproduction edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-strategy-fence-test-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "packages/demo/src"), { recursive: true });
    await writeFile(join(source, "packages/demo/src/code.ts"), "export {};\n");
    await writeFile(join(source, "package.json"), "{}");
    await symlink(join(root, "secret"), join(source, "leak"));
    await writeFile(join(root, "secret"), "secret");
    assert.equal(
      await fencedPath(source, "packages/demo/src/code.ts", true),
      "packages/demo/src/code.ts",
    );
    for (const path of ["../secret", join(root, "secret"), "leak"])
      await assert.rejects(fencedPath(source, path));
    await assert.rejects(fencedPath(source, "package.json", true));
    const task = {
      ...suite.tasks.find((entry) => entry.id === "cross-realm")!,
      path: "packages/demo/src/code.ts",
    };
    await writeFile(
      join(source, task.path),
      `export * from ${JSON.stringify(join(root, "secret"))};`,
    );
    await assert.rejects(bundleTask(source, task));
  } finally {
    await rm(root, { recursive: true });
  }
});

test.skipIf(process.platform !== "darwin")(
  "OS sandbox denies host I/O and network, and terminates runaway code",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-strategy-sandbox-test-"));
    try {
      const forbidden = join(root, "private");
      await writeFile(forbidden, "unchanged");
      await probeSandbox(forbidden);
      assert.equal(await readFile(forbidden, "utf8"), "unchanged");
      const result = await runSandboxed("while (true) {}", {}, 1000);
      assert.equal(result.signal, "SIGKILL");
      assert.ok(result.durationMs < 10_000);
    } finally {
      await rm(root, { recursive: true });
    }
  },
);
