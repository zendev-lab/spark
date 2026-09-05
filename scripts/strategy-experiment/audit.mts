import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AssistantMessage } from "@zendev-lab/spark-llm-providers";

import {
  holdoutOrder,
  listTrialDirectories,
  parseStrategy,
  trialId,
  type Candidate,
  type Freeze,
  type Selection,
} from "./experiment.mts";
import { addUsage, emptyUsage, type ModelRun } from "./runtime.mts";
import { matches, verifyTask, type Verification } from "./sandbox.mts";
import {
  scoreCandidate,
  selectCandidate,
  summarizeHoldout,
  trialPassed,
  type Trial,
} from "./report.mts";
import {
  digest,
  fileInventory,
  isEditableSource,
  materializeSources,
  readJson,
  within,
  writeJson,
  type Budget,
  type TestCase,
} from "./suite.mts";

function requireEqual(actual: unknown, expected: unknown, description: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Evidence mismatch: ${description}`);
}

export async function verifyFiles(root: string, entries: Array<[string, string]>): Promise<void> {
  if (new Set(entries.map(([path]) => path)).size !== entries.length)
    throw new Error("Duplicate evidence path");
  for (const [path, expected] of entries) {
    if (isAbsolute(path) || !within(root, resolve(root, path)))
      throw new Error("Evidence path escapes root");
    requireEqual(digest(await readFile(join(root, path))), expected, path);
  }
}

export function auditAcceptance(acceptance: Verification, cases: TestCase[]): void {
  if (acceptance.buildError) {
    requireEqual(acceptance.cases, [], "build failure case inventory");
    requireEqual(acceptance.passed, false, "build failure cannot pass");
    return;
  }
  requireEqual(
    acceptance.cases.map((entry) => entry.id),
    cases.map((entry) => entry.id),
    "acceptance case inventory",
  );
  for (const [index, entry] of acceptance.cases.entries()) {
    const expected = cases[index]!.expected;
    requireEqual(entry.expected, expected, `frozen expected ${entry.id}`);
    let actual: unknown;
    let valid = entry.process.code === 0 && entry.process.signal === null;
    try {
      actual = JSON.parse(entry.process.stdout);
    } catch {
      valid = false;
    }
    if (valid) requireEqual(entry.actual, actual, `raw stdout ${entry.id}`);
    requireEqual(
      entry.passed,
      valid && matches(actual, expected),
      `recomputed acceptance ${entry.id}`,
    );
  }
  requireEqual(
    acceptance.passed,
    acceptance.cases.every((entry) => entry.passed),
    "acceptance aggregate",
  );
}

type ProviderRecord = {
  kind: string;
  call: number;
  message?: AssistantMessage;
  context?: unknown;
  options?: Record<string, unknown>;
  model?: { id: string; provider: string };
};
async function jsonLines<T>(path: string, optional = false): Promise<T[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function auditModel(
  root: string,
  model: ModelRun,
  freeze: Freeze,
  budget: Budget,
): Promise<void> {
  requireEqual(model.modelIdentity, freeze.model, "model identity/catalog");
  const records = await jsonLines<ProviderRecord>(join(root, "provider.jsonl"), true);
  const requests = records.filter((entry) => entry.kind === "request");
  const responses = records.filter((entry) => entry.kind === "response");
  requireEqual(
    requests.map((entry) => entry.call),
    Array.from({ length: model.modelCalls }, (_, index) => index + 1),
    "model request inventory",
  );
  requireEqual(
    responses.map((entry) => entry.call),
    requests.map((entry) => entry.call),
    "model response inventory",
  );
  if (!model.modelCalls || model.invalidReasons.length) throw new Error("Invalid model execution");
  const usage = emptyUsage();
  for (const request of requests) {
    requireEqual(
      request.model,
      { provider: freeze.model.provider, id: freeze.model.id },
      "requested model",
    );
    requireEqual(
      request.options,
      {
        maxTokens: budget.maxOutputTokens,
        maxRetries: 0,
        ...(freeze.suite.protocol.temperature === null
          ? {}
          : { temperature: freeze.suite.protocol.temperature }),
        reasoning: freeze.suite.protocol.reasoning,
        cacheRetention: "none",
      },
      "provider settings",
    );
  }
  for (const response of responses) {
    const message = response.message!;
    if (
      message.model !== freeze.model.id ||
      message.provider !== freeze.model.provider ||
      message.stopReason === "error" ||
      !addUsage(usage, message)
    )
      throw new Error("Invalid provider response/usage");
    const price = freeze.model.cost as {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    const calculated =
      (message.usage.input * price.input +
        message.usage.output * price.output +
        message.usage.cacheRead * price.cacheRead +
        message.usage.cacheWrite * price.cacheWrite) /
      1_000_000;
    if (Math.abs(calculated - message.usage.cost.total) > 1e-9)
      throw new Error("Usage cost differs from frozen catalog");
    if (
      message.usage.output > budget.maxOutputTokens &&
      !model.budgetFailures.includes("maxOutputTokens")
    )
      throw new Error("Unreported output budget overshoot");
  }
  if (model.status === "completed") {
    requireEqual(
      model.finalText,
      responses
        .at(-1)!
        .message!.content.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      "raw final model text",
    );
  }
  requireEqual(model.usage, usage, "provider usage aggregate");
  const calls = (
    await jsonLines<{ kind: string; id: string }>(join(root, "tools.jsonl"), true)
  ).filter((entry) => entry.kind === "call");
  requireEqual(calls.length, model.toolCalls, "tool inventory");
  if (new Set(calls.map((entry) => entry.id)).size !== calls.length)
    throw new Error("Duplicate tool invocation");
  const outcomes = (
    await jsonLines<{ type: string; outcome?: { status: string } }>(join(root, "events.jsonl"))
  ).filter((entry) => entry.type === "run_outcome");
  if (model.status === "completed")
    requireEqual(outcomes.at(-1)?.outcome?.status, "completed", "Spark run outcome");
  requireEqual(
    Date.parse(model.finishedAt) - Date.parse(model.startedAt),
    model.durationMs,
    "solver duration",
  );
}

export async function auditExperiment(output: string) {
  const seal = await readJson<{ schema: string; files: Array<[string, string]> }>(
    join(output, "seal.json"),
  );
  if (seal.schema !== "spark.strategy-seal/v1") throw new Error("Unsupported evidence seal");
  await verifyFiles(output, seal.files);
  const freeze = await readJson<Freeze>(join(output, "freeze.json"));
  const freezeDigest = digest(await readFile(join(output, "freeze.json")));
  const selection = await readJson<Selection>(join(output, "selection.json"));
  const completed = await readJson<{
    at: string;
    freezeDigest: string;
    trialIds: string[];
    candidateIds: string[];
  }>(join(output, "completed.json"));
  const suite = freeze.suite;
  if (
    freeze.schema !== "spark.strategy-freeze/v1" ||
    !freeze.source.clean ||
    suite.protocol.repetitions !== 2 ||
    suite.protocol.maxCandidates !== 3
  )
    throw new Error("Invalid frozen protocol/source");
  requireEqual(selection.freezeDigest, freezeDigest, "selection freeze");
  requireEqual(completed.freezeDigest, freezeDigest, "completion freeze");
  requireEqual(
    freeze.sourceDigest,
    digest(JSON.stringify(freeze.sourceInventory)),
    "source inventory digest",
  );
  await verifyFiles(join(output, "preflight"), freeze.preflight);
  for (const task of suite.tasks)
    for (const state of ["fixed", "broken"]) {
      const verification = await readJson<Verification>(
        join(output, "preflight", `${state}-${task.id}.json`),
      );
      auditAcceptance(verification, suite.cases[task.id]!);
      requireEqual(verification.passed, state === "fixed", "evaluator positive/negative control");
      if (verification.buildError || verification.cases.some((entry) => entry.error))
        throw new Error("Invalid evaluator control");
    }
  const candidateIds = selection.candidateIds;
  if (!candidateIds.length || candidateIds.length > suite.protocol.maxCandidates)
    throw new Error("Invalid candidate count");
  requireEqual(
    candidateIds,
    candidateIds.map((_, index) => `candidate-${index + 1}`),
    "candidate sequence",
  );
  const candidates = await Promise.all(
    candidateIds.map((id) => readJson<Candidate>(join(output, "candidates", id, "candidate.json"))),
  );
  const expectedDev = ["baseline", ...candidateIds].flatMap((strategyId) =>
    suite.tasks
      .filter((task) => task.split === "development")
      .flatMap((task) =>
        Array.from({ length: suite.protocol.repetitions }, (_, index) =>
          trialId(task, strategyId, index + 1),
        ),
      ),
  );
  const expectedIds = [
    ...expectedDev,
    ...holdoutOrder(suite, selection.selectedId).map((entry) => entry.id),
  ];
  requireEqual(selection.developmentTrialIds, expectedDev, "development selection inventory");
  requireEqual(completed.trialIds, expectedIds, "ordered experiment inventory");
  requireEqual(completed.candidateIds, candidateIds, "completed candidate inventory");
  requireEqual(
    await listTrialDirectories(output),
    [...expectedIds].sort(),
    "exact trial directories",
  );
  const trials = await Promise.all(
    expectedIds.map((id) => readJson<Trial>(join(output, "trials", id, "result.json"))),
  );
  for (const [index, candidate] of candidates.entries()) {
    requireEqual(candidate.id, candidateIds[index], "candidate identity");
    requireEqual(candidate.index, index + 1, "candidate index");
    requireEqual(candidate.freezeDigest, freezeDigest, "candidate freeze");
    requireEqual(candidate.strategyDigest, digest(candidate.strategy), "strategy digest");
    requireEqual(
      parseStrategy(candidate.model.finalText, suite.protocol.candidateMaxChars),
      { strategy: candidate.strategy, hypothesis: candidate.hypothesis },
      "model-generated strategy",
    );
    await verifyFiles(join(output, "candidates", candidate.id), candidate.raw);
    await auditModel(
      join(output, "candidates", candidate.id, "raw"),
      candidate.model,
      freeze,
      suite.protocol.generatorBudget,
    );
    if (candidate.model.budgetFailures.length || candidate.model.status !== "completed")
      throw new Error("Invalid strategy generation");
    if (Date.parse(candidate.model.finishedAt) > Date.parse(selection.lockedAt))
      throw new Error("Candidate generated after selection");
  }
  for (const [index, trial] of trials.entries()) {
    requireEqual(trial.id, expectedIds[index], "trial identity");
    const task = suite.tasks.find((entry) => entry.id === trial.taskId);
    if (!task) throw new Error("Unknown trial task");
    requireEqual(trial.id, trialId(task, trial.strategyId, trial.repetition), "trial coordinates");
    requireEqual(trial.split, task.split, "trial split");
    requireEqual(trial.freezeDigest, freezeDigest, "trial freeze");
    requireEqual(trial.before, freeze.source, "trial source before");
    requireEqual(trial.after, freeze.source, "trial source after");
    requireEqual(trial.inputSnapshotDigest, freeze.sourceDigest, "trial source input");
    const strategy =
      trial.strategyId === "baseline"
        ? suite.protocol.baselineStrategy
        : candidates.find((candidate) => candidate.id === trial.strategyId)?.strategy;
    if (!strategy) throw new Error("Unknown strategy");
    requireEqual(trial.strategyDigest, digest(strategy), "trial strategy");
    const root = join(output, "trials", trial.id);
    await verifyFiles(root, trial.raw);
    await auditModel(join(root, "raw"), trial.model, freeze, suite.protocol.budget);
    auditAcceptance(trial.acceptance, suite.cases[task.id]!);
    requireEqual(
      trial.acceptance,
      await readJson(join(root, "acceptance.json")),
      "acceptance receipt",
    );
    const changes = await readJson<
      Array<{ path: string; beforeDigest: string; digest: string; content: string }>
    >(join(root, "changes.json"));
    const inventory = new Map(freeze.sourceInventory);
    for (const change of changes) {
      if (!isEditableSource(change.path) || !inventory.has(change.path))
        throw new Error("Patch changes a forbidden file");
      requireEqual(change.beforeDigest, inventory.get(change.path), "patch base");
      requireEqual(change.digest, digest(change.content), "patch content");
      inventory.set(change.path, change.digest);
    }
    const after = [...inventory].sort(([left], [right]) => left.localeCompare(right));
    requireEqual(
      await readJson(join(root, "output-inventory.json")),
      after,
      "patch output inventory",
    );
    requireEqual(trial.outputSnapshotDigest, digest(JSON.stringify(after)), "patch output digest");
    const start = Date.parse(trial.model.startedAt);
    const end = Date.parse(trial.model.finishedAt);
    if (
      !Number.isFinite(start) ||
      start < Date.parse(freeze.createdAt) ||
      end > Date.parse(completed.at) ||
      (trial.split === "holdout"
        ? start < Date.parse(selection.lockedAt)
        : end > Date.parse(selection.lockedAt))
    )
      throw new Error("Trial crossed freeze/selection time boundary");
  }
  const baseline = trials.filter(
    (trial) => trial.split === "development" && trial.strategyId === "baseline",
  );
  const ranking = selectCandidate(
    baseline,
    candidates.map((candidate) => ({
      id: candidate.id,
      index: candidate.index,
      trials: trials.filter(
        (trial) => trial.split === "development" && trial.strategyId === candidate.id,
      ),
    })),
    suite.protocol.budget,
  );
  requireEqual(
    {
      selectedId: selection.selectedId,
      scores: selection.scores,
      eligibilityFallback: selection.eligibilityFallback,
    },
    ranking,
    "development-only selection",
  );
  for (const [index, candidate] of candidates.entries()) {
    const score = scoreCandidate(
      baseline,
      trials.filter((trial) => trial.split === "development" && trial.strategyId === candidate.id),
      suite.protocol.budget,
    );
    const improved =
      score.eligible &&
      score.passes > baseline.filter((trial) => trialPassed(trial, suite.protocol.budget)).length;
    if (
      improved
        ? index !== candidates.length - 1
        : index === candidates.length - 1 && candidates.length < suite.protocol.maxCandidates
    )
      throw new Error("Frozen stopping rule violated");
  }
  const result = summarizeHoldout(
    trials.filter((trial) => trial.split === "holdout" && trial.strategyId === "baseline"),
    trials.filter(
      (trial) => trial.split === "holdout" && trial.strategyId === selection.selectedId,
    ),
    suite.protocol,
  );
  const allModels = [
    ...trials.map((trial) => trial.model),
    ...candidates.map((candidate) => candidate.model),
  ];
  const estimatedCostUsd = allModels.reduce((sum, model) => sum + model.usage.estimatedCostUsd, 0);
  if (estimatedCostUsd > suite.protocol.maxExperimentEstimatedCostUsd)
    throw new Error("Experiment cost budget exceeded");
  return {
    schema: "spark.strategy-report/v1",
    comparable: true,
    freezeDigest,
    source: freeze.source,
    model: freeze.model,
    startedAt: freeze.createdAt,
    completedAt: completed.at,
    selection: ranking,
    development: {
      baselinePasses: baseline.filter((trial) => trialPassed(trial, suite.protocol.budget)).length,
      trialsPerStrategy: baseline.length,
      candidates: ranking.scores,
    },
    holdout: result,
    totals: {
      trials: trials.length,
      generatedCandidates: candidates.length,
      modelCalls: allModels.reduce((sum, model) => sum + model.modelCalls, 0),
      tokens: allModels.reduce((sum, model) => sum + model.usage.totalTokens, 0),
      estimatedCostUsd,
      billedCostUsd: null,
      modelDurationMs: allModels.reduce((sum, model) => sum + model.durationMs, 0),
    },
    trials: trials.map((trial) => ({
      id: trial.id,
      passed: trialPassed(trial, suite.protocol.budget),
      tokens: trial.model.usage.totalTokens,
      budgetFailures: trial.model.budgetFailures,
      failedCaseIds: trial.acceptance.cases
        .filter((entry) => !entry.passed)
        .map((entry) => entry.id),
      evidenceRef: trial.evidenceRef,
      receipt: `trials/${trial.id}/result.json`,
    })),
    limitations: [suite.protocol.scope, suite.protocol.cost, result.uncertainty],
  };
}

interface Archive {
  schema: "spark.strategy-archive/v1";
  files: Array<[string, string]>;
  shards?: Array<{ path: string; sha256: string }>;
}

export async function exportExperiment(output: string, destination: string): Promise<void> {
  const report = await auditExperiment(output);
  const seal = await readJson<{ files: Array<[string, string]> }>(join(output, "seal.json"));
  const groups = new Map<string, string[]>();
  for (const path of [...seal.files.map(([path]) => path), "seal.json"]) {
    const group = path.startsWith("trials/")
      ? `trials/${path.split("/")[1]}.json.gz`
      : "evidence.json.gz";
    groups.set(group, [...(groups.get(group) ?? []), path]);
  }
  await mkdir(destination, { recursive: false });
  const shards: Array<{ path: string; sha256: string }> = [];
  let archiveSha256 = "";
  for (const path of [...groups.keys()].sort(
    (left, right) => Number(left === "evidence.json.gz") - Number(right === "evidence.json.gz"),
  )) {
    const files = await Promise.all(
      groups
        .get(path)!
        .map(
          async (name) => [name, await readFile(join(output, name), "utf8")] as [string, string],
        ),
    );
    const manifest: Archive = {
      schema: "spark.strategy-archive/v1",
      files,
      ...(path === "evidence.json.gz" ? { shards } : {}),
    };
    const archive = gzipSync(JSON.stringify(manifest), { level: 9 });
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await writeFile(join(destination, path), archive, { flag: "wx" });
    if (path === "evidence.json.gz") archiveSha256 = digest(archive);
    else shards.push({ path, sha256: digest(archive) });
  }
  await writeJson(join(destination, "receipt.json"), { archiveSha256, ...report });
}

export async function unpackExperiment(archivePath: string, output: string): Promise<void> {
  const decode = (bytes: Buffer): Archive => {
    const archive = JSON.parse(
      gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }).toString(),
    ) as Archive;
    if (archive.schema !== "spark.strategy-archive/v1" || !Array.isArray(archive.files))
      throw new Error("Unsupported archive");
    return archive;
  };
  const archive = decode(await readFile(archivePath));
  const files = [...archive.files];
  for (const shard of archive.shards ?? []) {
    const root = dirname(archivePath);
    if (isAbsolute(shard.path) || !within(root, resolve(root, shard.path)))
      throw new Error("Invalid shard path");
    const bytes = await readFile(join(root, shard.path));
    requireEqual(digest(bytes), shard.sha256, "archive shard");
    const child = decode(bytes);
    if (child.shards) throw new Error("Nested archive shards are unsupported");
    files.push(...child.files);
  }
  for (const [path, content] of files) {
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      isAbsolute(path) ||
      !within(output, resolve(output, path))
    )
      throw new Error("Invalid archive path/content");
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), content, { flag: "wx" });
  }
}

export async function replayTrial(output: string, id: string) {
  const report = await auditExperiment(output);
  if (!report.trials.some((trial) => trial.id === id)) throw new Error("Unknown trial id");
  const freeze = await readJson<Freeze>(join(output, "freeze.json"));
  const trial = await readJson<Trial>(join(output, "trials", id, "result.json"));
  const root = await mkdtemp(join(tmpdir(), "spark-strategy-replay-"));
  try {
    const workspace = join(root, "source");
    await materializeSources(workspace, freeze.suite);
    const changes = await readJson<Array<{ path: string; content: string }>>(
      join(output, "trials", id, "changes.json"),
    );
    for (const change of changes) await writeFile(join(workspace, change.path), change.content);
    requireEqual(
      digest(JSON.stringify(await fileInventory(workspace))),
      trial.outputSnapshotDigest,
      "replay patched source",
    );
    const acceptance = await verifyTask(
      workspace,
      freeze.suite.tasks.find((task) => task.id === trial.taskId)!,
      freeze.suite.cases[trial.taskId]!,
    );
    requireEqual(
      acceptance.cases.map((entry) => [entry.id, entry.passed]),
      trial.acceptance.cases.map((entry) => [entry.id, entry.passed]),
      "replayed acceptance",
    );
    requireEqual(acceptance.passed, trial.acceptance.passed, "replayed pass");
    return { id, matchesRecordedAcceptance: true, acceptance };
  } finally {
    await rm(root, { recursive: true });
  }
}
