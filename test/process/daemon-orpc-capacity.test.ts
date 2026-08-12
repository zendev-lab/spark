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

test("50 fake-provider AgentLoops stream while direct oRPC stays responsive", async () => {
  const temporary = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spark-orpc-capacity-process-"),
  );
  await chmod(temporary, 0o700);
  try {
    const result = await runSparkProcess(
      {
        command: resolve(root, "node_modules/.bin/tsx"),
        cwd: root,
        env: { ...process.env, SPARK_HOME: resolve(temporary, "spark-home") },
        timeoutMs: 90_000,
      },
      ["test/support/daemon-orpc-capacity-child.ts"],
    );
    const report = JSON.parse(result.stdout) as DaemonOrpcCapacityReport;
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
    assert.ok(
      Object.values(scenario.terminalTurnStatuses).every((status) => status === "succeeded"),
    );

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
        assert.ok(
          probe.daemonStatus.maxMs <= DAEMON_ORPC_CAPACITY_MAX_RPC_MS,
          `loaded daemon.status RTT ${probe.daemonStatus.maxMs}ms exceeded ${DAEMON_ORPC_CAPACITY_MAX_RPC_MS}ms`,
        );
        assert.ok(
          probe.turnStatus.maxMs <= DAEMON_ORPC_CAPACITY_MAX_RPC_MS,
          `loaded turn.status RTT ${probe.turnStatus.maxMs}ms exceeded ${DAEMON_ORPC_CAPACITY_MAX_RPC_MS}ms`,
        );
      }
    }
    assert.equal(scenario.probes.held.persistent.rounds, 20);
    assert.equal(scenario.probes.held.fresh.rounds, 10);
    assert.equal(scenario.probes.streaming.persistent.rounds, 20);
    assert.equal(scenario.probes.streaming.fresh.rounds, 10);

    assert.ok(scenario.eventLoop.sampleCount >= DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES);
    assert.ok(scenario.eventLoop.p95GapMs <= scenario.eventLoop.maxGapMs);
    assert.ok(
      scenario.eventLoop.maxGapMs <= DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS,
      `loaded event-loop gap ${scenario.eventLoop.maxGapMs}ms exceeded ${DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS}ms`,
    );
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
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 90_000);

function counts(queued: number, running: number, succeeded: number) {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}
