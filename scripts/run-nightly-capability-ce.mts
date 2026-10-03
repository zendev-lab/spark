#!/usr/bin/env -S node --experimental-strip-types

import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  summarizeSparkBehaviorCe,
  type SparkBehaviorCeSample,
} from "../apps/spark-daemon/src/product/host/agent-runtime/behavior-ce.ts";
import {
  capabilitySentinelCommand,
  capabilitySentinelTestFiles,
} from "../vitest.capability.config.ts";
import { assertSafeCapabilityCeOutputDirectory } from "./capability-ce-output-directory.mts";
import {
  captureCapabilityCeSnapshot,
  type CapabilityCeExperiment,
} from "./capability-ce-experiment.mts";

interface NightlyCapabilityCeConfiguration {
  runs: number;
  maxFailureRate: number;
  maxDurationP95Ms: number;
  runTimeoutMs: number;
  outputDir: string;
}

interface ParsedAssertion {
  caseId: string;
  passed: boolean;
  durationMs?: number;
  failure?: string;
}

interface RunRecord {
  runId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  assertions: number;
  passedAssertions: number;
  failedAssertions: number;
  reporterParsed: boolean;
  timedOut: boolean;
  failure?: string;
  reportPath: string;
  logPath: string;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const configuration = parseConfiguration(process.argv.slice(2), process.env);
const before = await captureCapabilityCeSnapshot(repositoryRoot, capabilitySentinelTestFiles);
await assertSafeCapabilityCeOutputDirectory({
  repositoryRoot,
  outputDir: configuration.outputDir,
});
await rm(configuration.outputDir, { recursive: true, force: true });
const rawDirectory = join(configuration.outputDir, "raw");
await mkdir(rawDirectory, { recursive: true });

const expectedRunIds = Array.from(
  { length: configuration.runs },
  (_, index) => `run-${String(index + 1).padStart(2, "0")}`,
);
const samples: SparkBehaviorCeSample[] = [];
const runs: RunRecord[] = [];
const invalidRunIds: string[] = [];

for (const runId of expectedRunIds) {
  const reportPath = join(rawDirectory, `${runId}.json`);
  const logPath = join(rawDirectory, `${runId}.log`);
  const startedAt = performance.now();
  const result = spawnSync(
    "pnpm",
    capabilitySentinelCommand(["--reporter=json", `--outputFile=${reportPath}`]),
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CI: "1",
        SPARK_CAPABILITY_SENTINEL: "1",
        SPARK_NIGHTLY_CE_RUN_ID: runId,
      },
      encoding: "utf8",
      timeout: configuration.runTimeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const durationMs = Math.round(performance.now() - startedAt);
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const parsed = await parseVitestReport(reportPath);
  const processFailure = renderProcessFailure(result, parsed.error);
  const assertions = parsed.assertions;
  if (
    result.error ||
    result.signal ||
    (result.status !== 0 && result.status !== 1) ||
    parsed.error ||
    (result.status === 1 && assertions.every((assertion) => assertion.passed))
  ) {
    invalidRunIds.push(runId);
  }
  const runnerPassed =
    result.status === 0 &&
    parsed.error === undefined &&
    assertions.length > 0 &&
    assertions.every((assertion) => assertion.passed);

  samples.push({
    runId,
    caseId: "@runner",
    passed: runnerPassed,
    durationMs,
    metrics: {
      assertions: assertions.length,
      exitCode: result.status ?? -1,
      timedOut: timedOut ? 1 : 0,
    },
    ...(runnerPassed ? {} : { failure: processFailure ?? "capability CE runner failed" }),
  });
  for (const assertion of assertions) {
    samples.push({
      runId,
      caseId: assertion.caseId,
      passed: assertion.passed,
      ...(assertion.durationMs === undefined ? {} : { durationMs: assertion.durationMs }),
      ...(assertion.failure ? { failure: assertion.failure } : {}),
    });
  }

  await writeFile(
    logPath,
    [
      `runId=${runId}`,
      `exitCode=${result.status ?? "null"}`,
      `signal=${result.signal ?? "none"}`,
      `durationMs=${durationMs}`,
      `timedOut=${timedOut}`,
      "",
      "## stdout",
      result.stdout ?? "",
      "",
      "## stderr",
      result.stderr ?? "",
      "",
      ...(processFailure ? ["## failure", processFailure, ""] : []),
    ].join("\n"),
    "utf8",
  );

  const record: RunRecord = {
    runId,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    assertions: assertions.length,
    passedAssertions: assertions.filter((assertion) => assertion.passed).length,
    failedAssertions: assertions.filter((assertion) => !assertion.passed).length,
    reporterParsed: parsed.error === undefined,
    timedOut,
    ...(processFailure ? { failure: processFailure } : {}),
    reportPath: relative(repositoryRoot, reportPath),
    logPath: relative(repositoryRoot, logPath),
  };
  runs.push(record);
  await writeFile(
    join(rawDirectory, `${runId}.meta.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}

const summary = summarizeSparkBehaviorCe(samples, {
  expectedRunIds,
  maxFailureRate: configuration.maxFailureRate,
  maxDurationP95Ms: configuration.maxDurationP95Ms,
  failureSampleLimit: 5,
});
const report = {
  schema: "spark.capability-ce/v1",
  generatedAt: new Date().toISOString(),
  commitSha: process.env.GITHUB_SHA?.trim() || undefined,
  configuration: {
    ...configuration,
    outputDir: relative(repositoryRoot, configuration.outputDir),
    testFiles: capabilitySentinelTestFiles,
    providerTokenPolicy: "zero",
  },
  runs,
  summary,
};
const markdown = renderMarkdownReport(report);
const experiment: CapabilityCeExperiment = {
  schema: "spark.capability-ce-experiment/v1",
  before,
  after: await captureCapabilityCeSnapshot(repositoryRoot, capabilitySentinelTestFiles),
  configuration: {
    runs: configuration.runs,
    maxFailureRate: configuration.maxFailureRate,
    maxDurationP95Ms: configuration.maxDurationP95Ms,
    runTimeoutMs: configuration.runTimeoutMs,
    providerTokenPolicy: "zero",
  },
  invalidRunIds,
  samples,
};
await writeFile(
  join(configuration.outputDir, "experiment.json"),
  `${JSON.stringify(experiment, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(configuration.outputDir, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
await writeFile(join(configuration.outputDir, "summary.md"), markdown, "utf8");
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { encoding: "utf8", flag: "a" });
}
process.stdout.write(markdown);
process.exitCode = summary.passed ? 0 : 1;

function parseConfiguration(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): NightlyCapabilityCeConfiguration {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (normalizedArgs.includes("--help") || normalizedArgs.includes("-h")) {
    process.stdout.write(
      [
        "Usage: node --experimental-strip-types scripts/run-nightly-capability-ce.mts [options]",
        "",
        "Options:",
        "  --runs <1-50>",
        "  --output-dir <path under reports/>",
        "  --max-failure-rate <0-1>",
        "  --max-duration-p95-ms <milliseconds>",
        "  --run-timeout-ms <milliseconds>",
        "",
      ].join("\n"),
    );
    process.exit(0);
  }
  const known = new Set([
    "--runs",
    "--output-dir",
    "--max-failure-rate",
    "--max-duration-p95-ms",
    "--run-timeout-ms",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const name = normalizedArgs[index]!;
    if (!known.has(name)) throw new Error(`Unknown Nightly CE option: ${name}`);
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const outputDir = resolve(
    repositoryRoot,
    values.get("--output-dir") ?? env.SPARK_NIGHTLY_CE_OUTPUT_DIR ?? "reports/capability-ce",
  );
  return {
    runs: parseInteger(values.get("--runs") ?? env.SPARK_NIGHTLY_CE_RUNS ?? "8", "runs", 1, 50),
    outputDir,
    maxFailureRate: parseRate(
      values.get("--max-failure-rate") ?? env.SPARK_NIGHTLY_CE_MAX_FAILURE_RATE ?? "0",
      "max-failure-rate",
    ),
    maxDurationP95Ms: parseInteger(
      values.get("--max-duration-p95-ms") ?? env.SPARK_NIGHTLY_CE_MAX_DURATION_P95_MS ?? "30000",
      "max-duration-p95-ms",
      1,
      600_000,
    ),
    runTimeoutMs: parseInteger(
      values.get("--run-timeout-ms") ?? env.SPARK_NIGHTLY_CE_RUN_TIMEOUT_MS ?? "120000",
      "run-timeout-ms",
      1_000,
      900_000,
    ),
  };
}

async function parseVitestReport(
  reportPath: string,
): Promise<{ assertions: ParsedAssertion[]; error?: string }> {
  try {
    await access(reportPath);
    const raw = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    const root = record(raw);
    const testResults = Array.isArray(root?.testResults) ? root.testResults : [];
    const assertions: ParsedAssertion[] = [];
    for (const rawResult of testResults) {
      const result = record(rawResult);
      const fileName = normalizeFileName(result?.name);
      const assertionResults = Array.isArray(result?.assertionResults)
        ? result.assertionResults
        : [];
      for (const rawAssertion of assertionResults) {
        const assertion = record(rawAssertion);
        const title = stringValue(assertion?.title) ?? "unnamed assertion";
        const ancestorTitles = Array.isArray(assertion?.ancestorTitles)
          ? assertion.ancestorTitles.flatMap((value) => {
              const title = stringValue(value);
              return title ? [title] : [];
            })
          : [];
        const status = stringValue(assertion?.status) ?? "unknown";
        const durationMs = finiteNumber(assertion?.duration);
        const failure = renderAssertionFailure(assertion, status);
        assertions.push({
          caseId: [fileName, ...ancestorTitles, title].filter(Boolean).join(" > "),
          passed: status === "passed",
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(failure ? { failure } : {}),
        });
      }
    }
    const missingFiles = capabilitySentinelTestFiles.filter(
      (file) => !assertions.some((assertion) => assertion.caseId.startsWith(`${file} > `)),
    );
    if (missingFiles.length > 0)
      return {
        assertions,
        error: `Missing sentinel files in reporter: ${missingFiles.join(", ")}`,
      };
    return assertions.length > 0
      ? { assertions }
      : { assertions: [], error: "Vitest JSON report contained no assertions" };
  } catch (error) {
    return {
      assertions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeFileName(value: unknown): string {
  const name = stringValue(value) ?? "unknown-file";
  const absolute = resolve(name);
  const pathFromRoot = relative(repositoryRoot, absolute);
  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)
    ? name.replaceAll("\\", "/")
    : pathFromRoot.replaceAll("\\", "/");
}

function renderAssertionFailure(
  assertion: Record<string, unknown> | undefined,
  status: string,
): string | undefined {
  if (status === "passed") return undefined;
  const messages = Array.isArray(assertion?.failureMessages)
    ? assertion.failureMessages.flatMap((value) => {
        const message = stringValue(value)?.trim();
        return message ? [message] : [];
      })
    : [];
  return truncate(messages.join("\n") || `Vitest assertion status=${status}`, 4_000);
}

function renderProcessFailure(
  result: ReturnType<typeof spawnSync>,
  reporterError: string | undefined,
): string | undefined {
  const parts = [
    result.error ? `spawn error: ${result.error.message}` : undefined,
    result.status === 0 ? undefined : `exit code: ${result.status ?? "null"}`,
    result.signal ? `signal: ${result.signal}` : undefined,
    reporterError ? `reporter: ${reporterError}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function renderMarkdownReport(report: {
  generatedAt: string;
  commitSha?: string;
  configuration: NightlyCapabilityCeConfiguration & {
    testFiles: readonly string[];
    providerTokenPolicy: string;
  };
  summary: ReturnType<typeof summarizeSparkBehaviorCe>;
}): string {
  const { summary } = report;
  const status = summary.passed ? "PASS ✅" : "FAIL ❌";
  const lines = [
    "# Nightly Capability CE",
    "",
    `**Status:** ${status}`,
    `**Generated:** ${report.generatedAt}`,
    ...(report.commitSha ? [`**Commit:** \`${report.commitSha}\``] : []),
    `**Runs:** ${summary.totals.observedRuns}/${summary.totals.expectedRuns}`,
    `**Cases:** ${summary.totals.cases}`,
    `**Samples:** ${summary.totals.passes} passed, ${summary.totals.failedSamples} failed, ${summary.totals.missingSamples} missing`,
    `**Flaky cases:** ${summary.totals.flakyCases}`,
    `**Inventory stable:** ${summary.inventoryStable}`,
    `**Provider-token policy:** ${report.configuration.providerTokenPolicy}`,
    "",
    "| Case | Pass rate | Failed | Missing | p95 | CV | Violations |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...summary.cases
      .map((entry) =>
        [
          escapeMarkdown(entry.caseId),
          formatPercent(entry.passRate),
          String(entry.failedSamples),
          String(entry.missingRunIds.length),
          entry.durationMs ? formatMilliseconds(entry.durationMs.p95) : "—",
          entry.durationMs?.coefficientOfVariation === null ||
          entry.durationMs?.coefficientOfVariation === undefined
            ? "—"
            : entry.durationMs.coefficientOfVariation.toFixed(3),
          entry.violations.length > 0 ? escapeMarkdown(entry.violations.join("; ")) : "—",
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
  ];
  const inventoryDrift = summary.runInventories.filter(
    (run) => run.missingCaseIds.length > 0 || run.unexpectedCaseIds.length > 0,
  );
  if (
    summary.missingRunIds.length > 0 ||
    summary.unexpectedRunIds.length > 0 ||
    inventoryDrift.length > 0
  ) {
    lines.push("", "## Inventory failures", "");
    if (summary.missingRunIds.length > 0) {
      lines.push(`- Missing runs: ${summary.missingRunIds.join(", ")}`);
    }
    if (summary.unexpectedRunIds.length > 0) {
      lines.push(`- Unexpected runs: ${summary.unexpectedRunIds.join(", ")}`);
    }
    for (const run of inventoryDrift) {
      lines.push(
        `- ${run.runId}: missing=${run.missingCaseIds.join(",") || "none"}; unexpected=${run.unexpectedCaseIds.join(",") || "none"}`,
      );
    }
  }
  const failures = summary.cases.filter(
    (entry) => !entry.passed || entry.failureSamples.length > 0,
  );
  if (failures.length > 0) {
    lines.push("", "## Failure samples", "");
    for (const entry of failures) {
      lines.push(`### ${entry.caseId}`, "");
      if (entry.failureSamples.length === 0) lines.push("No assertion message was recorded.", "");
      else {
        for (const failure of entry.failureSamples) lines.push("```text", failure, "```", "");
      }
    }
  }
  lines.push(
    "",
    "## Configuration",
    "",
    `- Repetitions: ${report.configuration.runs}`,
    `- Maximum failure rate: ${report.configuration.maxFailureRate}`,
    `- Maximum case p95: ${report.configuration.maxDurationP95Ms} ms`,
    `- Per-run timeout: ${report.configuration.runTimeoutMs} ms`,
    `- Test files: ${report.configuration.testFiles.length}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function parseInteger(value: string, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseRate(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum
    ? value
    : `${value.slice(0, maximum)}\n[truncated ${value.length - maximum} chars]`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMilliseconds(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}
