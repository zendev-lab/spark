import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import type {
  DaemonInvocationCounts,
  DaemonOrpcCapacityReport,
} from "../support/daemon-orpc-capacity-contract.ts";
import { DAEMON_ORPC_CAPACITY_MIN_FIVE_WAY_SAMPLES } from "../support/daemon-orpc-capacity-contract.ts";
import { runSparkProcess } from "../support/spark-process-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("source daemon enforces configurable capacity while direct oRPC stays responsive", async () => {
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

    assert.equal(report.version, 1);
    assert.match(report.environment.sourceCommit, /^[0-9a-f]{40}$/u);
    assert.equal(report.environment.runner, "tsx-source");
    assert.equal(report.transport.kind, "direct-orpc");
    assert.equal(report.transport.clientFactory, "createSparkDaemonOrpcClient");
    assert.equal(report.transport.legacyFallback, false);
    assert.equal(report.transport.rpcTimeoutMs, 5_000);
    assert.deepEqual(
      report.scenarios.map((scenario) => scenario.configuredConcurrency),
      [2, 5],
    );

    for (const scenario of report.scenarios) {
      const concurrency = scenario.configuredConcurrency;
      assert.equal(scenario.effectiveConcurrency, concurrency);
      assert.equal(scenario.statusBuildFingerprint, report.environment.sourceCommit);
      assert.deepEqual(scenario.cardinality, { workspaces: 80, sessions: 8, turns: 8 });
      assert.deepEqual(scenario.initialCounts, counts(8 - concurrency, concurrency, 0));
      assert.equal(
        Object.values(scenario.initialTurnStatuses).filter((status) => status === "running").length,
        concurrency,
      );
      assert.equal(
        Object.values(scenario.initialTurnStatuses).filter((status) => status === "queued").length,
        8 - concurrency,
      );
      assert.equal(scenario.maxInFlight, concurrency);
      assert.equal(new Set(scenario.startedInvocationIds).size, 8);
      assert.equal(scenario.transitions.length, 8 - concurrency);
      scenario.transitions.forEach((transition, index) => {
        assert.notEqual(transition.releasedInvocationId, transition.admittedInvocationId);
        assert.deepEqual(
          transition.counts,
          counts(8 - concurrency - index - 1, concurrency, index + 1),
        );
      });
      assert.deepEqual(scenario.terminalCounts, counts(0, 0, 8));
      assert.ok(
        Object.values(scenario.terminalTurnStatuses).every((status) => status === "succeeded"),
      );
      assert.equal(scenario.probes.persistent.failures, 0);
      assert.equal(scenario.probes.fresh.failures, 0);
      assert.equal(
        scenario.probes.persistent.daemonStatus.requestCount,
        scenario.probes.persistent.rounds,
      );
      assert.equal(
        scenario.probes.persistent.turnStatus.requestCount,
        scenario.probes.persistent.rounds,
      );
      assert.equal(scenario.probes.fresh.daemonStatus.requestCount, scenario.probes.fresh.rounds);
      assert.equal(scenario.probes.fresh.turnStatus.requestCount, scenario.probes.fresh.rounds);
      assert.equal(scenario.probes.heldAtConfiguredLimit, true);
      assert.ok(scenario.eventLoop.sampleCount > 0);
      assert.ok(scenario.eventLoop.p95GapMs <= scenario.eventLoop.maxGapMs);
      assert.ok(scenario.rssBytes.before > 0);
      assert.ok(scenario.rssBytes.peak >= scenario.rssBytes.before);
      assert.ok(scenario.rssBytes.peak >= scenario.rssBytes.after);
    }

    const five = report.scenarios.find((scenario) => scenario.configuredConcurrency === 5);
    assert.ok(five);
    assert.equal(five.probes.persistent.rounds, 20);
    assert.equal(five.probes.fresh.rounds, 10);
    assert.ok(five.eventLoop.sampleCount >= DAEMON_ORPC_CAPACITY_MIN_FIVE_WAY_SAMPLES);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 90_000);

function counts(queued: number, running: number, succeeded: number): DaemonInvocationCounts {
  return { queued, running, succeeded, failed: 0, cancelled: 0 };
}
