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
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 90_000;
// The loaded child is normally CPU-saturated (about 0.9 locally). Keep this
// deliberately low so daemon CPU work or ordinary timer variance cannot be
// mislabeled as host preemption on either macOS or Linux runners.
const HOST_PREEMPTION_MAX_PROCESS_CPU_TO_WALL_RATIO = 0.5;

type CapacityAttemptDisposition = "pass" | "host-preempted" | "performance-failure";

test(
  "50 fake-provider AgentLoops stream while direct oRPC stays responsive",
  async () => {
    const temporary = await mkdtemp(
      join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-orpc-capacity-process-"),
    );
    await chmod(temporary, 0o700);
    try {
      const hostPreemptedAttempts: string[] = [];
      const dispositions: CapacityAttemptDisposition[] = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const report = await runCapacityAttempt(temporary);
        assertCapacityReportExceptMaxEventLoopGap(report);
        const disposition = classifyEventLoopAttempt(report.scenario.eventLoop);
        dispositions.push(disposition);

        if (disposition === "pass") {
          return;
        }

        const audit = hostSchedulingAudit(report, attempt);
        assert.equal(
          disposition,
          "host-preempted",
          `loaded event-loop gap exceeded the hard gate and was not eligible for a host-preemption retry: ${audit}`,
        );
        hostPreemptedAttempts.push(audit);
        const seriesDisposition = classifyAttemptSeries(dispositions);
        if (seriesDisposition === "host-preempted") {
          process.stderr.write(
            `[daemon-orpc-capacity] retrying host-preempted attempt: ${audit}\n`,
          );
          continue;
        }
        assert.equal(seriesDisposition, "infrastructure-failure");
      }

      assert.fail(
        `capacity harness infrastructure failure: all ${MAX_ATTEMPTS} attempts were host-preempted; no attempt satisfied the ${DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS}ms event-loop hard gate:\n${hostPreemptedAttempts.join("\n")}`,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + 10_000,
);

test("classifies an over-limit max-gap tick with aligned low CPU and preemption as retryable", () => {
  assert.equal(
    classifyEventLoopAttempt({
      maxGapMs: DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS + 1,
      maxGapProcessCpuToWallRatio: 0.4,
      maxGapInvoluntaryContextSwitchesDelta: 1,
    }),
    "host-preempted",
  );
});

test("does not excuse an over-limit max-gap tick that consumed process CPU", () => {
  assert.equal(
    classifyEventLoopAttempt({
      maxGapMs: DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS + 1,
      maxGapProcessCpuToWallRatio: 0.6,
      maxGapInvoluntaryContextSwitchesDelta: 100,
    }),
    "performance-failure",
  );
});

test("keeps the RPC hard gate outside host-preemption retry classification", () => {
  assert.throws(
    () =>
      assertRpcLatencyWithinHardGate("loaded turn.status RTT", DAEMON_ORPC_CAPACITY_MAX_RPC_MS + 1),
    /loaded turn\.status RTT 501ms exceeded 500ms/u,
  );
});

test("classifies three host-preempted attempts as an infrastructure failure", () => {
  assert.equal(
    classifyAttemptSeries(["host-preempted", "host-preempted", "host-preempted"]),
    "infrastructure-failure",
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

  assert.equal(report.version, 2);
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

function classifyEventLoopAttempt(
  eventLoop: Pick<
    DaemonOrpcCapacityReport["scenario"]["eventLoop"],
    "maxGapMs" | "maxGapProcessCpuToWallRatio" | "maxGapInvoluntaryContextSwitchesDelta"
  >,
): CapacityAttemptDisposition {
  if (eventLoop.maxGapMs <= DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS) return "pass";
  if (
    eventLoop.maxGapProcessCpuToWallRatio <= HOST_PREEMPTION_MAX_PROCESS_CPU_TO_WALL_RATIO &&
    eventLoop.maxGapInvoluntaryContextSwitchesDelta > 0
  ) {
    return "host-preempted";
  }
  return "performance-failure";
}

function classifyAttemptSeries(
  dispositions: readonly CapacityAttemptDisposition[],
): CapacityAttemptDisposition | "infrastructure-failure" {
  if (dispositions.includes("pass")) return "pass";
  if (dispositions.includes("performance-failure")) return "performance-failure";
  return dispositions.length >= MAX_ATTEMPTS ? "infrastructure-failure" : "host-preempted";
}

function hostSchedulingAudit(report: DaemonOrpcCapacityReport, attempt: number): string {
  const { eventLoop, hostScheduling } = report.scenario;
  return JSON.stringify({
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    eventLoopMaxGapMs: eventLoop.maxGapMs,
    eventLoopHardGateMs: DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS,
    maxGapProcessCpuMs: eventLoop.maxGapProcessCpuMs,
    maxGapProcessCpuToWallRatio: eventLoop.maxGapProcessCpuToWallRatio,
    maxGapInvoluntaryContextSwitchesDelta: eventLoop.maxGapInvoluntaryContextSwitchesDelta,
    observedWallMs: hostScheduling.observedWallMs,
    processCpuTotalMsDelta: hostScheduling.processCpuTotalMsDelta,
    observedProcessCpuToWallRatio: hostScheduling.observedProcessCpuToWallRatio,
    hostPreemptionMaxProcessCpuToWallRatio: HOST_PREEMPTION_MAX_PROCESS_CPU_TO_WALL_RATIO,
    involuntaryContextSwitchesDelta: hostScheduling.involuntaryContextSwitchesDelta,
  });
}

function counts(queued: number, running: number, succeeded: number) {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}
