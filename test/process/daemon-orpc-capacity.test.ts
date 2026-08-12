import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import type { DaemonOrpcCapacityReport } from "../support/daemon-orpc-capacity-contract.ts";
import {
  DAEMON_ORPC_CAPACITY_CONCURRENCY,
  DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS,
  DAEMON_ORPC_CAPACITY_MAX_RPC_MS,
  DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES,
  DAEMON_ORPC_CAPACITY_SESSION_COUNT,
} from "../support/daemon-orpc-capacity-contract.ts";
import {
  CAPACITY_MODEL_REF,
  CAPACITY_STREAM_CHUNK_COUNT,
  CAPACITY_STREAM_TICK_MS,
} from "../support/daemon-orpc-capacity-provider.ts";
import { runSparkProcess } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ATTEMPT_TIMEOUT_MS = 90_000;

test(
  "50 fake-provider AgentLoops stream while direct oRPC stays responsive",
  async () => {
    const temporary = await mkdtemp(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-orpc-capacity-process-"),
    );
    await chmod(temporary, 0o700);
    try {
      const report = await runCapacityAttempt(temporary);
      assertCapacityReportExceptMaxEventLoopGap(report);
      assert.ok(
        report.scenario.eventLoop.maxGapMs <= DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS,
        `loaded event-loop gap exceeded the hard gate: ${hostSchedulingAudit(report)}`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  ATTEMPT_TIMEOUT_MS + 10_000,
);

test("keeps the RPC latency limit as an independent hard gate", () => {
  assert.throws(
    () =>
      assertRpcLatencyWithinHardGate("loaded turn.status RTT", DAEMON_ORPC_CAPACITY_MAX_RPC_MS + 1),
    /loaded turn\.status RTT 501ms exceeded 500ms/u,
  );
});

async function runCapacityAttempt(temporary: string): Promise<DaemonOrpcCapacityReport> {
  const result = await runSparkProcess(
    {
      command: resolve(root, "node_modules/.bin/tsx"),
      cwd: root,
      env: { ...process.env, SPARK_HOME: resolve(temporary, "spark-home") },
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    },
    ["test/support/daemon-orpc-capacity-child.ts"],
  );
  return JSON.parse(result.stdout) as DaemonOrpcCapacityReport;
}

function assertCapacityReportExceptMaxEventLoopGap(report: DaemonOrpcCapacityReport): void {
  const scenario = report.scenario;

  assert.equal(report.version, 3);
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
      assertRpcLatencyWithinHardGate("loaded daemon.status RTT", probe.daemonStatus.maxMs);
      assertRpcLatencyWithinHardGate("loaded turn.status RTT", probe.turnStatus.maxMs);
    }
  }
  assert.equal(scenario.probes.held.persistent.rounds, 20);
  assert.equal(scenario.probes.held.fresh.rounds, 10);
  assert.equal(scenario.probes.streaming.persistent.rounds, 20);
  assert.equal(scenario.probes.streaming.fresh.rounds, 10);

  assert.ok(scenario.eventLoop.sampleCount >= DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES);
  assert.ok(scenario.eventLoop.p95GapMs <= scenario.eventLoop.maxGapMs);
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
  assert.equal(
    scenario.persistence.invocationEvents,
    scenario.persistence.attemptEventOutputs + scenario.persistence.lifecycleEvents,
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

function assertRpcLatencyWithinHardGate(label: string, maxMs: number): void {
  assert.ok(
    maxMs <= DAEMON_ORPC_CAPACITY_MAX_RPC_MS,
    `${label} ${maxMs}ms exceeded ${DAEMON_ORPC_CAPACITY_MAX_RPC_MS}ms`,
  );
}

function hostSchedulingAudit(report: DaemonOrpcCapacityReport): string {
  const { eventLoop, hostScheduling } = report.scenario;
  return JSON.stringify({
    eventLoopMaxGapMs: eventLoop.maxGapMs,
    eventLoopMaxGapAtMs: eventLoop.maxGapAtMs,
    eventLoopHardGateMs: DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS,
    maxGapProcessCpuMs: eventLoop.maxGapProcessCpuMs,
    maxGapProcessCpuToWallRatio: eventLoop.maxGapProcessCpuToWallRatio,
    maxGapThreadCpuMs: eventLoop.maxGapThreadCpuMs,
    maxGapThreadCpuToWallRatio: eventLoop.maxGapThreadCpuToWallRatio,
    maxGapInvoluntaryContextSwitchesDelta: eventLoop.maxGapInvoluntaryContextSwitchesDelta,
    observedWallMs: hostScheduling.observedWallMs,
    processCpuTotalMsDelta: hostScheduling.processCpuTotalMsDelta,
    observedProcessCpuToWallRatio: hostScheduling.observedProcessCpuToWallRatio,
    involuntaryContextSwitchesDelta: hostScheduling.involuntaryContextSwitchesDelta,
  });
}

function counts(queued: number, running: number, succeeded: number) {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}
