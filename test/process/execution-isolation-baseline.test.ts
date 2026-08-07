import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { test } from "vitest";

import { runSparkProcess } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schemaPath = resolve(import.meta.dirname, "execution-isolation-baseline.schema.json");

interface BaselineFixture {
  id: string;
  classification: string;
  executionPath: string;
  probe: {
    maxGapMs: number;
    samples: Array<{
      heartbeat: number;
      primaryStatus: string | null;
      secondStatus: string | null;
      secondTerminalAtMs: number | null;
    }>;
  };
  primary?: { terminalAtMs: number | null };
  second?: { terminalAtMs: number | null };
  releaseAtMs?: number;
  terminalBeforeExecutorSettlement?: boolean;
  secondQueuedUntilRelease?: boolean;
  child?: {
    pid: number;
    termSentAtMs: number;
    killSentAtMs: number | null;
    exitedAtMs: number;
    cleanupOwner: string;
    productionCleanupObserved: boolean;
  };
}

interface BaselineReport {
  version: number;
  environment: {
    platform: string;
    node: string;
    commit: string;
    sourceTreeDirty: boolean;
    schedulerConcurrency: number;
    controlProbeIntervalMs: number;
    controlResponsiveGapLimitMs: number;
  };
  assertions: Record<string, boolean>;
  fixtures: BaselineFixture[];
}

test("source process records the single-daemon execution isolation baseline", async () => {
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
    const report = JSON.parse(result.stdout) as BaselineReport;
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      formats: { "date-time": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u },
    });
    const validate = ajv.compile(schema);
    assert.equal(validate(report), true, renderSchemaErrors(validate.errors ?? []));

    assert.equal(report.version, 1);
    assert.ok(["darwin", "linux"].includes(report.environment.platform));
    assert.match(report.environment.node, /^v26\./u);
    assert.match(report.environment.commit, /^[0-9a-f]{40}$/u);
    assert.equal(typeof report.environment.sourceTreeDirty, "boolean");
    assert.equal(report.environment.schedulerConcurrency, 2);
    assert.equal(report.environment.controlProbeIntervalMs, 100);
    assert.ok(report.environment.controlResponsiveGapLimitMs >= 250);
    assert.ok(report.environment.controlResponsiveGapLimitMs <= 1_000);
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

    const cpu = fixture(report, "sync-cpu");
    assert.equal(cpu.classification, "event-loop-blocked");
    assert.equal(cpu.executionPath, "SparkAgentLoop.provider");
    assert.ok(cpu.probe.maxGapMs >= 4_000);
    assert.ok(requiredNumber(cpu.second?.terminalAtMs) >= requiredNumber(cpu.releaseAtMs));

    const provider = fixture(report, "async-provider");
    assert.equal(provider.classification, "async-wait");
    assert.equal(provider.executionPath, "SparkAgentLoop.provider");
    assert.ok(provider.probe.maxGapMs < report.environment.controlResponsiveGapLimitMs);
    assert.ok(requiredNumber(provider.second?.terminalAtMs) < requiredNumber(provider.releaseAtMs));
    assert.ok(
      provider.probe.samples.some(
        (sample) => sample.primaryStatus === "running" && sample.secondStatus === "succeeded",
      ),
    );

    const abortIgnoring = fixture(report, "abort-ignoring-tool");
    assert.equal(abortIgnoring.classification, "session-fence-occupancy");
    assert.equal(abortIgnoring.executionPath, "SparkAgentLoop.tool");
    assert.ok(abortIgnoring.probe.maxGapMs < report.environment.controlResponsiveGapLimitMs);
    assert.ok(
      abortIgnoring.probe.samples.some(
        (sample) => sample.primaryStatus === "failed" && sample.secondStatus === "queued",
      ),
    );

    const attachment = fixture(report, "attachment-sync-io");
    assert.equal(attachment.classification, "sync-io");
    assert.equal(attachment.executionPath, "sessionRunPrompt.materializeTurnFiles");

    const child = fixture(report, "hung-external-child");
    assert.equal(child.classification, "external-child-lifecycle");
    assert.equal(child.executionPath, "SparkAgentLoop.tool");
    assert.equal(child.terminalBeforeExecutorSettlement, true);
    assert.equal(child.secondQueuedUntilRelease, true);
    assert.ok(
      requiredNumber(child.primary?.terminalAtMs) <= requiredNumber(child.child?.termSentAtMs),
    );
    assert.ok(
      requiredNumber(child.child?.termSentAtMs) <= requiredNumber(child.child?.killSentAtMs),
    );
    assert.ok(requiredNumber(child.child?.killSentAtMs) <= requiredNumber(child.child?.exitedAtMs));
    assert.equal(child.child?.cleanupOwner, "test-harness");
    assert.equal(child.child?.productionCleanupObserved, false);
    assert.equal(processExists(requiredNumber(child.child?.pid)), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 90_000);

function fixture(report: BaselineReport, id: string): BaselineFixture {
  const value = report.fixtures.find((candidate) => candidate.id === id);
  assert.ok(value, `missing baseline fixture ${id}`);
  return value;
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
