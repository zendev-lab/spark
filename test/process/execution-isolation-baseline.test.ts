import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { test } from "vitest";

import { runSparkProcess } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = resolve(import.meta.dirname, "execution-isolation-baseline.schema.json");
let generatedBaselineReport: Promise<BaselineReport> | undefined;

interface BaselineFixture {
  id: string;
  classification: string;
  executionPath: string;
  probe: {
    maxGapMs: number;
    p95GapMs: number;
    rssBytes: { before: number; peak: number; after: number };
    samples: Array<{
      heartbeat: number;
      primaryStatus: string | null;
      secondStatus: string | null;
      secondTerminalAtMs: number | null;
    }>;
  };
  primary?: { status: string; startedAtMs: number | null; terminalAtMs: number | null };
  second?: { startedAtMs: number | null; terminalAtMs: number | null };
  releaseAtMs?: number;
  terminalBeforeExecutorSettlement?: boolean;
  secondQueuedUntilRelease?: boolean;
  attachment?: {
    bytes: number;
    materializationStartedAtMs: number;
    materializationCompletedAtMs: number;
    materializationDurationMs: number;
    probeGapBeforeMs: number;
    probeGapAcrossMs: number;
    probeGapAfterMs: number;
  };
  child?: {
    pid: number;
    spawnedAtMs: number;
    cancelAtMs: number;
    aliveAfterProductionCancel: boolean;
    termSentAtMs: number;
    killSentAtMs: number | null;
    childExitAtMs: number;
    executorSettledAtMs: number;
    sessionFenceReleasedAtMs: number;
    harnessCleanupAtMs: number;
    cleanupOwner: string;
    productionCleanupObserved: boolean;
  };
  teardown: { liveChildPidCount: number };
}

interface BaselineReport {
  version: number;
  environment: {
    platform: string;
    release: string;
    arch: string;
    node: string;
    commit: string;
    sourceTreeDirty: boolean;
    schedulerConcurrency: number;
    controlProbeIntervalMs: number;
    controlResponsiveGapLimitMs: number;
    measurementUnits: { timestamps: string; durations: string; memory: string };
  };
  assertions: Record<string, boolean>;
  fixtures: BaselineFixture[];
}

test("source process records the single-daemon execution isolation baseline", async () => {
  const report = await baselineReport();
  const validate = await reportValidator();
  assert.equal(validate(report), true, renderSchemaErrors(validate.errors ?? []));

  assert.equal(report.version, 2);
  assert.ok(["darwin", "linux"].includes(report.environment.platform));
  assert.ok(report.environment.release.length > 0);
  assert.ok(report.environment.arch.length > 0);
  assert.match(report.environment.node, /^v26\./u);
  assert.match(report.environment.commit, /^[0-9a-f]{40}$/u);
  assert.equal(typeof report.environment.sourceTreeDirty, "boolean");
  assert.equal(report.environment.schedulerConcurrency, 2);
  assert.equal(report.environment.controlProbeIntervalMs, 100);
  assert.equal(report.environment.controlResponsiveGapLimitMs, 250);
  assert.deepEqual(report.environment.measurementUnits, {
    timestamps: "unix-ms",
    durations: "ms",
    memory: "bytes",
  });
  assert.deepEqual(
    report.fixtures.map((fixture) => fixture.id),
    [
      "idle-control",
      "sync-cpu",
      "async-provider",
      "abort-ignoring-tool",
      "attachment-sync-io",
      "hung-external-child",
    ],
  );
  assert.ok(Object.values(report.assertions).every(Boolean));
  for (const observed of report.fixtures) {
    assert.ok(observed.probe.p95GapMs <= observed.probe.maxGapMs);
    assert.equal(observed.teardown.liveChildPidCount, 0);
  }

  const cpu = fixture(report, "sync-cpu");
  assert.equal(cpu.classification, "event-loop-blocked");
  assert.equal(cpu.executionPath, "SparkAgentLoop.provider");
  assert.ok(cpu.probe.maxGapMs >= 4_000);
  assert.ok(["succeeded", "failed", "cancelled"].includes(cpu.primary?.status ?? ""));
  assert.ok(requiredNumber(cpu.primary?.terminalAtMs) >= requiredNumber(cpu.primary?.startedAtMs));
  assert.ok(requiredNumber(cpu.second?.terminalAtMs) >= requiredNumber(cpu.releaseAtMs));

  const provider = fixture(report, "async-provider");
  assert.equal(provider.classification, "async-wait");
  assert.equal(provider.executionPath, "SparkAgentLoop.provider");
  assert.ok(provider.probe.maxGapMs < 250);
  assert.ok(requiredNumber(provider.second?.terminalAtMs) < requiredNumber(provider.releaseAtMs));
  assert.ok(
    provider.probe.samples.some(
      (sample) => sample.primaryStatus === "running" && sample.secondStatus === "succeeded",
    ),
  );

  const abortIgnoring = fixture(report, "abort-ignoring-tool");
  assert.equal(abortIgnoring.classification, "session-fence-occupancy");
  assert.equal(abortIgnoring.executionPath, "SparkAgentLoop.tool");
  assert.ok(abortIgnoring.probe.maxGapMs < 250);
  assert.ok(
    abortIgnoring.probe.samples.some(
      (sample) => sample.primaryStatus === "failed" && sample.secondStatus === "queued",
    ),
  );

  const attachment = fixture(report, "attachment-sync-io");
  assert.equal(attachment.classification, "sync-io");
  assert.equal(attachment.executionPath, "sessionRunPrompt.materializeTurnFiles");
  assert.equal(attachment.attachment?.bytes, 12 * 1024 * 1024);
  assert.ok(
    requiredNumber(attachment.attachment?.materializationCompletedAtMs) >=
      requiredNumber(attachment.attachment?.materializationStartedAtMs),
  );
  assert.equal(
    attachment.attachment?.materializationDurationMs,
    requiredNumber(attachment.attachment?.materializationCompletedAtMs) -
      requiredNumber(attachment.attachment?.materializationStartedAtMs),
  );
  assert.ok(requiredNumber(attachment.attachment?.probeGapBeforeMs) >= 0);
  assert.ok(requiredNumber(attachment.attachment?.probeGapAcrossMs) >= 0);
  assert.ok(requiredNumber(attachment.attachment?.probeGapAfterMs) >= 0);

  const child = fixture(report, "hung-external-child");
  assert.equal(child.classification, "external-child-lifecycle");
  assert.equal(child.executionPath, "SparkAgentLoop.tool");
  assert.ok(child.probe.maxGapMs < 250);
  assert.equal(child.terminalBeforeExecutorSettlement, true);
  assert.equal(child.secondQueuedUntilRelease, true);
  assert.equal(child.child?.aliveAfterProductionCancel, true);
  assert.ok(requiredNumber(child.child?.spawnedAtMs) <= requiredNumber(child.child?.cancelAtMs));
  assert.ok(
    requiredNumber(child.primary?.terminalAtMs) <= requiredNumber(child.child?.termSentAtMs),
  );
  assert.ok(requiredNumber(child.child?.cancelAtMs) <= requiredNumber(child.child?.termSentAtMs));
  assert.ok(requiredNumber(child.child?.termSentAtMs) <= requiredNumber(child.child?.killSentAtMs));
  assert.ok(
    requiredNumber(child.child?.killSentAtMs) <= requiredNumber(child.child?.childExitAtMs),
  );
  assert.ok(
    requiredNumber(child.child?.childExitAtMs) <= requiredNumber(child.child?.harnessCleanupAtMs),
  );
  assert.ok(
    requiredNumber(child.child?.harnessCleanupAtMs) <=
      requiredNumber(child.child?.executorSettledAtMs),
  );
  assert.ok(
    requiredNumber(child.child?.executorSettledAtMs) <=
      requiredNumber(child.child?.sessionFenceReleasedAtMs),
  );
  assert.equal(child.child?.sessionFenceReleasedAtMs, requiredNumber(child.second?.startedAtMs));
  assert.equal(child.child?.cleanupOwner, "test-harness");
  assert.equal(child.child?.productionCleanupObserved, false);
  assert.equal(processExists(requiredNumber(child.child?.pid)), false);
}, 90_000);

test("report schema rejects missing fields, missing environment metadata, and illegal units", async () => {
  const validate = await reportValidator();
  const valid = structuredClone(await baselineReport()) as unknown as Record<string, unknown>;
  assert.equal(validate(valid), true, renderSchemaErrors(validate.errors ?? []));

  const missingRequired = structuredClone(valid);
  delete (fixtureRecord(missingRequired, "sync-cpu").probe as Record<string, unknown>).p95GapMs;
  assertSchemaRejected(validate, missingRequired, "missing p95GapMs");

  const missingEnvironment = structuredClone(valid);
  delete (missingEnvironment.environment as Record<string, unknown>).commit;
  assertSchemaRejected(validate, missingEnvironment, "missing environment commit");

  const illegalUnits = structuredClone(valid);
  (
    (illegalUnits.environment as Record<string, unknown>).measurementUnits as Record<
      string,
      unknown
    >
  ).durations = "seconds";
  assertSchemaRejected(validate, illegalUnits, "illegal duration unit");

  const relaxedResponsiveGap = structuredClone(valid);
  (
    fixtureRecord(relaxedResponsiveGap, "async-provider").probe as Record<string, unknown>
  ).maxGapMs = 250;
  assertSchemaRejected(validate, relaxedResponsiveGap, "responsive max gap at 250ms");
});

function baselineReport(): Promise<BaselineReport> {
  generatedBaselineReport ??= generateBaselineReport();
  return generatedBaselineReport;
}

async function generateBaselineReport(): Promise<BaselineReport> {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-isolation-baseline-"),
  );
  await chmod(temporary, 0o700);
  try {
    const result = await runSparkProcess(
      {
        command: resolve(root, "node_modules/.bin/tsx"),
        cwd: root,
        env: {
          ...process.env,
          SPARK_HOME: resolve(temporary, "spark-home"),
        },
        timeoutMs: 90_000,
      },
      ["apps/spark-daemon/scripts/execution-isolation-baseline.mts"],
    );
    return JSON.parse(result.stdout) as BaselineReport;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function reportValidator(): Promise<ValidateFunction> {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u },
  });
  return ajv.compile(schema);
}

function fixture(report: BaselineReport, id: string): BaselineFixture {
  const value = report.fixtures.find((candidate) => candidate.id === id);
  assert.ok(value, `missing baseline fixture ${id}`);
  return value;
}

function fixtureRecord(report: Record<string, unknown>, id: string): Record<string, unknown> {
  const fixtures = report.fixtures as Array<Record<string, unknown>>;
  const value = fixtures.find((candidate) => candidate.id === id);
  assert.ok(value, `missing baseline fixture ${id}`);
  return value;
}

function assertSchemaRejected(validate: ValidateFunction, value: unknown, label: string): void {
  assert.equal(validate(value), false, `${label} unexpectedly passed schema validation`);
  assert.ok((validate.errors?.length ?? 0) > 0, `${label} did not produce schema errors`);
}

function requiredNumber(value: number | null | undefined): number {
  if (typeof value !== "number") throw new Error("expected a recorded number");
  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function renderSchemaErrors(errors: ErrorObject[]): string {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "schema error"}`)
    .join("\n");
}
