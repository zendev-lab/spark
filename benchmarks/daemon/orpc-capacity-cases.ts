import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DaemonOrpcCapacityReport } from "../../test/support/daemon-orpc-capacity-contract.ts";
import {
  DAEMON_ORPC_CAPACITY_CONCURRENCY,
  DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES,
  DAEMON_ORPC_CAPACITY_SESSION_COUNT,
} from "../../test/support/daemon-orpc-capacity-contract.ts";
import {
  CAPACITY_MODEL_REF,
  CAPACITY_STREAM_CHUNK_COUNT,
  CAPACITY_STREAM_TICK_MS,
} from "../../test/support/daemon-orpc-capacity-provider.ts";
import { runSparkProcess } from "../../test/support/spark-process-harness.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
export const DAEMON_ORPC_CAPACITY_ATTEMPT_TIMEOUT_MS = 90_000;

export async function runDaemonOrpcCapacityCase(): Promise<DaemonOrpcCapacityReport> {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-orpc-capacity-process-"),
  );
  await chmod(temporary, 0o700);
  try {
    const result = await runSparkProcess(
      {
        command: resolve(REPOSITORY_ROOT, "node_modules/.bin/tsx"),
        cwd: REPOSITORY_ROOT,
        env: { ...process.env, SPARK_HOME: resolve(temporary, "spark-home") },
        timeoutMs: DAEMON_ORPC_CAPACITY_ATTEMPT_TIMEOUT_MS,
      },
      ["test/support/daemon-orpc-capacity-child.ts"],
    );
    return JSON.parse(result.stdout) as DaemonOrpcCapacityReport;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function assertDaemonOrpcCapacityCase(report: DaemonOrpcCapacityReport): void {
  const scenario = report.scenario;

  assert.equal(report.version, 4);
  assert.match(report.environment.sourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(report.environment.runner, "tsx-source");
  assert.equal(report.transport.kind, "direct-orpc");
  assert.equal(report.transport.clientFactory, "createSparkDaemonOrpcClient");
  assert.equal(report.transport.legacyFallback, false);
  assert.equal(report.transport.rpcTimeoutMs, 5_000);

  assert.equal(scenario.configuredConcurrency, DAEMON_ORPC_CAPACITY_CONCURRENCY);
  assert.equal(scenario.effectiveConcurrency, DAEMON_ORPC_CAPACITY_CONCURRENCY);
  assert.equal(scenario.statusBuildFingerprint, report.environment.sourceCommit);
  assert.deepEqual(scenario.cardinality, {
    workspaces: 80,
    sessions: DAEMON_ORPC_CAPACITY_SESSION_COUNT,
    turns: DAEMON_ORPC_CAPACITY_SESSION_COUNT,
  });
  assert.equal(scenario.model.ref, CAPACITY_MODEL_REF);
  assert.equal(scenario.model.default, true);
  assert.equal(scenario.model.scoped, true);
  assert.equal(scenario.model.available, true);
  assert.equal(scenario.model.providerAuthKind, "none");
  assert.equal(scenario.model.providerAuthConfigured, true);
  assert.deepEqual(scenario.model.diagnostics, []);

  assert.deepEqual(scenario.loadedCounts, counts(0, 50, 0));
  assert.equal(
    Object.values(scenario.loadedTurnStatuses).filter((status) => status === "running").length,
    50,
  );
  assert.deepEqual(scenario.terminalCounts, counts(0, 0, 50));
  assert.ok(Object.values(scenario.terminalTurnStatuses).every((status) => status === "succeeded"));

  assert.equal(scenario.provider.expectedRequests, 50);
  assert.equal(scenario.provider.calls, 50);
  assert.equal(scenario.provider.entered, 50);
  assert.equal(scenario.provider.completed, 50);
  assert.equal(scenario.provider.maxInFlight, 50);
  assert.equal(scenario.provider.uniqueRequestCount, 50);
  assert.equal(scenario.provider.chunkCount, CAPACITY_STREAM_CHUNK_COUNT);
  assert.equal(scenario.provider.tickMs, CAPACITY_STREAM_TICK_MS);
  assert.equal(scenario.provider.emittedTextDeltas, 50 * CAPACITY_STREAM_CHUNK_COUNT);
  assert.ok(
    scenario.provider.streamWindowMs >= 500,
    `provider stream window ${scenario.provider.streamWindowMs}ms was shorter than 500ms`,
  );

  for (const phase of [scenario.probes.held, scenario.probes.streaming]) {
    for (const probe of [phase.persistent, phase.fresh]) {
      assert.equal(probe.failures, 0);
      assert.equal(probe.daemonStatus.requestCount, probe.rounds);
      assert.equal(probe.turnStatus.requestCount, probe.rounds);
      assertLatencySummary(probe.daemonStatus);
      assertLatencySummary(probe.turnStatus);
    }
  }
  assert.equal(scenario.probes.held.persistent.rounds, 20);
  assert.equal(scenario.probes.held.fresh.rounds, 10);
  assert.equal(scenario.probes.streaming.persistent.rounds, 20);
  assert.equal(scenario.probes.streaming.fresh.rounds, 10);

  assert.ok(scenario.eventLoop.sampleCount >= DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES);
  assert.ok(Number.isFinite(scenario.eventLoop.p95GapMs));
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapMs));
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapAtMs));
  assert.ok(scenario.eventLoop.p95GapMs >= 0);
  assert.ok(scenario.eventLoop.p95GapMs <= scenario.eventLoop.maxGapMs);
  assert.ok(scenario.eventLoop.maxGapAtMs >= 0);
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapProcessCpuMs));
  assert.ok(scenario.eventLoop.maxGapProcessCpuMs >= 0);
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapProcessCpuToWallRatio));
  assert.ok(scenario.eventLoop.maxGapProcessCpuToWallRatio >= 0);
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapThreadCpuMs));
  assert.ok(scenario.eventLoop.maxGapThreadCpuMs >= 0);
  assert.ok(Number.isFinite(scenario.eventLoop.maxGapThreadCpuToWallRatio));
  assert.ok(scenario.eventLoop.maxGapThreadCpuToWallRatio >= 0);
  assert.ok(Number.isInteger(scenario.eventLoop.maxGapInvoluntaryContextSwitchesDelta));
  assert.ok(scenario.eventLoop.maxGapInvoluntaryContextSwitchesDelta >= 0);
  assert.ok(Number.isFinite(scenario.hostScheduling.observedWallMs));
  assert.ok(scenario.hostScheduling.observedWallMs > 0);
  assert.ok(Number.isFinite(scenario.hostScheduling.processCpuUserMsDelta));
  assert.ok(scenario.hostScheduling.processCpuUserMsDelta >= 0);
  assert.ok(Number.isFinite(scenario.hostScheduling.processCpuSystemMsDelta));
  assert.ok(scenario.hostScheduling.processCpuSystemMsDelta >= 0);
  assert.ok(Number.isFinite(scenario.hostScheduling.processCpuTotalMsDelta));
  assert.equal(
    scenario.hostScheduling.processCpuTotalMsDelta,
    scenario.hostScheduling.processCpuUserMsDelta + scenario.hostScheduling.processCpuSystemMsDelta,
  );
  assert.ok(Number.isFinite(scenario.hostScheduling.observedProcessCpuToWallRatio));
  assert.ok(scenario.hostScheduling.observedProcessCpuToWallRatio >= 0);
  assert.ok(Number.isInteger(scenario.hostScheduling.involuntaryContextSwitchesDelta));
  assert.ok(scenario.hostScheduling.involuntaryContextSwitchesDelta >= 0);
  assert.ok(scenario.rssBytes.before > 0);
  assert.ok(scenario.rssBytes.peak >= scenario.rssBytes.before);
  assert.ok(scenario.rssBytes.peak >= scenario.rssBytes.after);

  assert.equal(scenario.persistence.invocations, 50);
  assert.equal(scenario.persistence.attempts, 50);
  assert.equal(scenario.persistence.succeededAttempts, 50);
  assert.equal(scenario.persistence.lifecycleEvents, 100);
  assert.equal(scenario.persistence.receiptContextEvents, 50);
  assert.equal(
    scenario.persistence.invocationEvents,
    scenario.persistence.attemptEventOutputs +
      scenario.persistence.lifecycleEvents +
      scenario.persistence.receiptContextEvents,
  );
  assert.ok(scenario.persistence.streamingSnapshots >= 50);
  assert.ok(
    scenario.persistence.streamingSnapshots <= scenario.persistence.streamingSnapshotUpperBound,
    `persisted ${scenario.persistence.streamingSnapshots} streaming snapshots above coalescer bound ${scenario.persistence.streamingSnapshotUpperBound}`,
  );
  assert.ok(
    scenario.persistence.streamingSnapshots < 50 * (CAPACITY_STREAM_CHUNK_COUNT + 1),
    "streaming snapshots were not coalesced below raw provider projection count",
  );
  assert.equal(scenario.persistence.terminalAssistantMessages, 50);
  assert.equal(scenario.persistence.exactFinalResults, 50);
  assert.equal(scenario.persistence.monotonicEventSequences, true);
}

export function daemonOrpcCapacityDiagnostics(report: DaemonOrpcCapacityReport) {
  const { eventLoop, hostScheduling, probes, provider, persistence, rssBytes } = report.scenario;
  return {
    eventLoop,
    hostScheduling,
    probes,
    providerStreamWindowMs: provider.streamWindowMs,
    persistence,
    rssBytes,
  };
}

function assertLatencySummary(summary: {
  requestCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}): void {
  assert.ok(Number.isFinite(summary.p50Ms));
  assert.ok(Number.isFinite(summary.p95Ms));
  assert.ok(Number.isFinite(summary.maxMs));
  assert.ok(summary.p50Ms >= 0);
  assert.ok(summary.p50Ms <= summary.p95Ms);
  assert.ok(summary.p95Ms <= summary.maxMs);
}

function counts(queued: number, running: number, succeeded: number) {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}
