import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  EXECUTION_ATTEMPT_ACCEPTED_CRASH_DELAYS_MS,
  ExecutionAttemptStateError,
  ExecutionAttemptStore,
} from "./state.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("daemon-owned execution attempt state", () => {
  it("allocates restart-stable monotonic daemon generations", () => {
    const { attempts, db } = harness("inv_daemon_generation");
    attempts.create("inv_daemon_generation", 7, "corr_generation_seed", at(0));
    expect(attempts.allocateDaemonGeneration(at(1))).toBe(8);
    expect(new ExecutionAttemptStore(db).allocateDaemonGeneration(at(2))).toBe(9);
    expect(
      db
        .prepare("SELECT value FROM daemon_meta WHERE key = ?")
        .get("execution-attempts.daemon-generation"),
    ).toEqual({ value: "9" });
  });

  it("persists queued -> accepted -> running -> terminal with monotonic epochs", () => {
    const { attempts } = harness("inv_state");
    const first = attempts.create("inv_state", 4, "corr_state", at(0));
    expect(first).toMatchObject({ attemptEpoch: 1, daemonGeneration: 4, status: "queued" });
    expect(attempts.accept(first, at(10)).acceptedAt).toBe(at(10));
    expect(attempts.start(first, at(20)).startedAt).toBe(at(20));
    expect(attempts.complete(first, "succeeded", { event: 3, usage: 2 }, at(30))).toMatchObject({
      status: "succeeded",
      eventHighWaterMark: 3,
      usageHighWaterMark: 2,
      finishedAt: at(30),
    });
    expect(attempts.current("inv_state")?.attemptEpoch).toBe(1);
  });

  it("replaces a live attempt when a successor daemon generation resumes it", () => {
    const { attempts } = harness("inv_generation");
    const first = attempts.begin("inv_generation", 10, "corr_generation", at(0));
    attempts.accept(first, at(1));
    const successor = attempts.begin("inv_generation", 11, "corr_successor", at(2));
    expect(successor).toMatchObject({
      attemptEpoch: 2,
      daemonGeneration: 11,
      status: "queued",
      nextAttemptAt: at(1_002),
    });
    expect(attempts.crashes("inv_generation")).toEqual([
      expect.objectContaining({
        attemptEpoch: 1,
        daemonGeneration: 10,
        acceptedCrashOrdinal: 1,
        errorCode: "daemon_generation_replaced",
      }),
    ]);
  });

  it("replaces a pre-accepted crash without consuming the accepted-crash budget", () => {
    const { attempts } = harness("inv_pre_accept");
    const first = attempts.create("inv_pre_accept", 1, "corr_pre", at(0));
    const crashed = attempts.crash(first, "process_spawn_failed", at(100));
    expect(crashed).toMatchObject({
      acceptedCrashCount: 0,
      terminalFailed: false,
      replacement: { attemptEpoch: 2, status: "queued", nextAttemptAt: at(100) },
    });
    expect(attempts.crashes("inv_pre_accept")).toEqual([
      expect.objectContaining({ attemptEpoch: 1, accepted: false }),
    ]);
  });

  it("durably backs off three accepted crashes and fails terminally on the fourth", () => {
    const { attempts } = harness("inv_crash_budget");
    let current = attempts.create("inv_crash_budget", 3, "corr_budget", at(0));
    const backoffs: Array<{ epoch: number; nextAttemptAt: string; ordinal: number }> = [];
    for (const [index, delayMs] of EXECUTION_ATTEMPT_ACCEPTED_CRASH_DELAYS_MS.entries()) {
      attempts.accept(current, at(index * 100_000 + 10));
      const nowMs = index * 100_000 + 20;
      const result = attempts.crash(current, `accepted_crash_${index + 1}`, at(nowMs));
      expect(result.terminalFailed).toBe(false);
      expect(result.acceptedCrashCount).toBe(index + 1);
      expect(result.backoffEvent).toEqual(
        expect.objectContaining({
          attemptEpoch: current.attemptEpoch,
          nextAttemptEpoch: current.attemptEpoch + 1,
          acceptedCrashCount: index + 1,
          nextAttemptAt: at(nowMs + delayMs),
        }),
      );
      current = requiredReplacement(result.replacement);
      expect(current.nextAttemptAt).toBe(at(nowMs + delayMs));
      backoffs.push({
        epoch: current.attemptEpoch,
        nextAttemptAt: requiredString(current.nextAttemptAt),
        ordinal: index + 1,
      });
    }

    attempts.accept(current, at(400_010));
    const exhausted = attempts.crash(current, "accepted_crash_4", at(400_020));
    expect(exhausted).toMatchObject({
      acceptedCrashCount: 4,
      terminalFailed: true,
      crashed: { status: "failed" },
    });
    expect(exhausted.replacement).toBeUndefined();
    expect(backoffs).toEqual([
      { epoch: 2, nextAttemptAt: at(1_020), ordinal: 1 },
      { epoch: 3, nextAttemptAt: at(105_020), ordinal: 2 },
      { epoch: 4, nextAttemptAt: at(230_020), ordinal: 3 },
    ]);
    expect(attempts.crashes("inv_crash_budget")).toEqual([
      expect.objectContaining({ attemptEpoch: 1, acceptedCrashOrdinal: 1 }),
      expect.objectContaining({ attemptEpoch: 2, acceptedCrashOrdinal: 2 }),
      expect.objectContaining({ attemptEpoch: 3, acceptedCrashOrdinal: 3 }),
      expect.objectContaining({ attemptEpoch: 4, acceptedCrashOrdinal: 4 }),
    ]);
    expect(attempts.events("inv_crash_budget")).toEqual([
      expect.objectContaining({
        sequence: 1,
        attemptEpoch: 1,
        kind: "execution.attempt.retry_scheduled",
      }),
      expect.objectContaining({
        sequence: 2,
        attemptEpoch: 2,
        kind: "execution.attempt.retry_scheduled",
      }),
      expect.objectContaining({
        sequence: 3,
        attemptEpoch: 3,
        kind: "execution.attempt.retry_scheduled",
      }),
      expect.objectContaining({
        sequence: 4,
        attemptEpoch: 4,
        kind: "execution.attempt.retry_exhausted",
      }),
    ]);
  });

  it("preserves crash history after a replacement attempt succeeds", () => {
    const { attempts } = harness("inv_recovered");
    let current = attempts.create("inv_recovered", 2, "corr_recovered", at(0));
    for (let index = 0; index < 3; index += 1) {
      attempts.accept(current, at(index * 100_000 + 10));
      current = requiredReplacement(
        attempts.crash(current, `crash_${index + 1}`, at(index * 100_000 + 20)).replacement,
      );
    }
    attempts.accept(current, at(400_000));
    attempts.start(current, at(400_010));
    expect(
      attempts.complete(current, "succeeded", { event: 9, usage: 4 }, at(400_020)),
    ).toMatchObject({ status: "succeeded", attemptEpoch: 4 });
    expect(attempts.current("inv_recovered")).toEqual(
      expect.not.objectContaining({ nextAttemptAt: expect.any(String) }),
    );
    expect(attempts.crashes("inv_recovered")).toHaveLength(3);
  });

  it("rejects stale attempts after replacement and stale daemon generations", () => {
    const { attempts } = harness("inv_stale");
    const first = attempts.create("inv_stale", 5, "corr_stale", at(0));
    const second = requiredReplacement(attempts.crash(first, "pre_accept", at(1)).replacement);
    expect(() => attempts.accept(first, at(2))).toThrowError(
      expect.objectContaining({ code: "execution_attempt_stale" }),
    );
    expect(() => attempts.accept({ ...second, daemonGeneration: 4 }, at(2))).toThrowError(
      expect.objectContaining({ code: "execution_attempt_stale" }),
    );
  });

  it("fails closed when a durable event payload is corrupt", () => {
    const { attempts, db } = harness("inv_corrupt");
    const current = attempts.create("inv_corrupt", 1, "corr_corrupt", at(0));
    attempts.accept(current, at(1));
    attempts.crash(current, "crash_corrupt_fixture", at(2));
    db.prepare("UPDATE execution_attempt_events SET payload_json = ?").run("not-json");
    expect(() => attempts.events("inv_corrupt")).toThrowError(
      expect.objectContaining({ code: "execution_attempt_corrupt_state" }),
    );
  });

  it("migrates execution attempt tables idempotently", () => {
    const db = database();
    migrateSparkDaemonDatabase(db);
    migrateSparkDaemonDatabase(db);
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE 'execution_attempt%'
           ORDER BY name`,
        )
        .all() as unknown as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(tables).toEqual([
      "execution_attempt_crashes",
      "execution_attempt_events",
      "execution_attempts",
    ]);
  });
});

function harness(invocationId: string): { attempts: ExecutionAttemptStore; db: DatabaseSync } {
  const db = database();
  migrateSparkDaemonDatabase(db);
  new SparkInvocationStore(db).submit({
    invocationId,
    sessionId: `session-${invocationId}`,
    prompt: "fixture",
    task: { type: "fixture" },
  });
  return { attempts: new ExecutionAttemptStore(db), db };
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function at(offsetMs: number): string {
  return new Date(Date.parse("2026-08-07T00:00:00.000Z") + offsetMs).toISOString();
}

function requiredReplacement<T>(value: T | undefined): T {
  if (!value) throw new Error("expected replacement execution attempt");
  return value;
}

function requiredString(value: string | undefined): string {
  if (!value) throw new Error("expected string");
  return value;
}

expect(ExecutionAttemptStateError).toBeDefined();
