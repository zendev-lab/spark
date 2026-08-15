import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { ExecutionAttemptStore } from "../execution/state.ts";
import { reconcileExecutionState } from "./execution-reconciler.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("reconcileExecutionState", () => {
  it("crashes accepted attempts and requeues running invocations on startup", () => {
    const { db, store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));
    const invocation = store.submit({
      invocationId: "inv_startup_running",
      sessionId: "session-startup",
      prompt: "recover me",
      task: {
        type: "session.run",
        sessionId: "session-startup",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "recover me",
      },
      now: at(0),
    });
    store.claimNext("worker-old", at(1));
    const attempt = attempts.begin(invocation.invocationId, generation, "corr_startup", at(2));
    attempts.accept(attempt, at(3));
    attempts.start(attempt, at(4));

    const successorGeneration = attempts.allocateDaemonGeneration(at(5));
    const first = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: successorGeneration,
      trigger: "startup",
      now: at(6),
    });

    expect(first.transitionCount).toBeGreaterThan(0);
    expect(first.invocationRequeues).toBe(1);
    expect(store.require(invocation.invocationId)).toMatchObject({
      status: "queued",
      sourceKind: "invocation.resume",
    });
    expect(attempts.current(invocation.invocationId)).toMatchObject({
      status: "queued",
      daemonGeneration: successorGeneration,
    });
    expect(attempts.crashes(invocation.invocationId)).toEqual([
      expect.objectContaining({
        attemptEpoch: attempt.attemptEpoch,
        errorCode: "daemon_generation_replaced",
      }),
    ]);

    // Idempotent for the same successor generation once clean.
    const second = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: successorGeneration,
      trigger: "startup",
      now: at(7),
    });
    expect(second.invocationRequeues).toBe(0);
    expect(
      second.attempts.every(
        (entry) => entry.transition === "noop" || entry.transition === "skip_terminal",
      ),
    ).toBe(true);
    void db;
  });

  it("uses pause semantics for planned shutdown without failing the invocation", () => {
    const { store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));
    const invocation = store.submit({
      invocationId: "inv_planned_pause",
      sessionId: "session-planned",
      prompt: "pause me",
      task: {
        type: "session.run",
        sessionId: "session-planned",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "pause me",
      },
      now: at(0),
    });
    store.claimNext("worker-old", at(1));
    const attempt = attempts.begin(invocation.invocationId, generation, "corr_planned", at(2));
    attempts.accept(attempt, at(3));
    attempts.start(attempt, at(4));

    const result = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: generation,
      trigger: "planned_shutdown",
      now: at(5),
    });

    expect(result.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invocationId: invocation.invocationId,
          transition: "pause_and_requeue",
          reason: "planned_shutdown",
        }),
        expect.objectContaining({
          invocationId: invocation.invocationId,
          transition: "requeue_invocation",
        }),
      ]),
    );
    expect(attempts.crashes(invocation.invocationId)).toEqual([
      expect.objectContaining({ errorCode: "planned_shutdown_pause" }),
    ]);
    expect(store.require(invocation.invocationId).status).toBe("queued");
  });

  it("fails closed on invalid task payloads and durable-commit-unknown invocations", () => {
    const { store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));

    const invalid = store.submit({
      invocationId: "inv_invalid_task",
      sessionId: "session-invalid",
      prompt: "bad task",
      task: { type: "not-a-real-task" },
      now: at(0),
    });
    store.claimNext("worker-old", at(1));

    const durable = store.submit({
      invocationId: "inv_durable_commit",
      sessionId: "session-durable",
      prompt: "commit started",
      task: {
        type: "session.run",
        sessionId: "session-durable",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "commit started",
      },
      now: at(2),
    });
    store.claimNext("worker-old", at(3));
    store.markDurableCommitStarted(durable.invocationId, at(4));
    expect(store.hasDurableCommitStarted(durable.invocationId)).toBe(true);

    const result = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: generation,
      trigger: "daemon_crash",
      now: at(5),
    });

    expect(store.require(invalid.invocationId).status).toBe("failed");
    expect(store.require(durable.invocationId)).toMatchObject({
      status: "failed",
      errorCode: "DURABLE_COMMIT_OUTCOME_UNKNOWN",
    });
    expect(result.invocationFailures).toBeGreaterThanOrEqual(2);
  });

  it("skips attempts owned by a newer daemon generation", () => {
    const { store, attempts } = harness();
    const older = attempts.allocateDaemonGeneration(at(0));
    const newer = attempts.allocateDaemonGeneration(at(1));
    const invocation = store.submit({
      invocationId: "inv_stale_writer",
      sessionId: "session-stale",
      prompt: "owned by newer",
      task: {
        type: "session.run",
        sessionId: "session-stale",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "owned by newer",
      },
      now: at(0),
    });
    const attempt = attempts.begin(invocation.invocationId, newer, "corr_newer", at(2));
    attempts.accept(attempt, at(3));

    const result = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: older,
      trigger: "periodic_tick",
      now: at(4),
    });

    expect(result.attempts).toEqual([
      expect.objectContaining({
        invocationId: invocation.invocationId,
        transition: "skip_stale_generation",
      }),
    ]);
    expect(attempts.current(invocation.invocationId)).toMatchObject({
      status: "accepted",
      daemonGeneration: newer,
    });
  });

  it("periodic ticks leave same-generation live work untouched", () => {
    const { store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));
    const invocation = store.submit({
      invocationId: "inv_periodic_live",
      sessionId: "session-periodic",
      prompt: "keep running",
      task: {
        type: "session.run",
        sessionId: "session-periodic",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "keep running",
      },
      now: at(0),
    });
    store.claimNext("worker-live", at(1));
    const attempt = attempts.begin(invocation.invocationId, generation, "corr_periodic", at(2));
    attempts.accept(attempt, at(3));
    attempts.start(attempt, at(4));

    const result = reconcileExecutionState({
      invocationStore: store,
      attemptStore: attempts,
      daemonGeneration: generation,
      trigger: "periodic_tick",
      now: at(5),
    });

    expect(result.invocationRequeues).toBe(0);
    expect(result.transitionCount).toBe(0);
    expect(store.require(invocation.invocationId).status).toBe("running");
    expect(attempts.current(invocation.invocationId)).toMatchObject({
      status: "running",
      daemonGeneration: generation,
    });
  });

  it("propagates recovery writes that fail while the invocation is still running", () => {
    const { store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));
    const invocation = store.submit({
      invocationId: "inv_recovery_write_failure",
      sessionId: "session-write-failure",
      prompt: "remain running",
      task: {
        type: "session.run",
        sessionId: "session-write-failure",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "remain running",
      },
      now: at(0),
    });
    store.claimNext("worker-old", at(1));
    vi.spyOn(store, "requeueForResume").mockImplementation(() => {
      throw new Error("forced recovery write failure");
    });

    expect(() =>
      reconcileExecutionState({
        invocationStore: store,
        attemptStore: attempts,
        daemonGeneration: generation,
        trigger: "startup",
        now: at(2),
      }),
    ).toThrow("forced recovery write failure");
    expect(store.require(invocation.invocationId).status).toBe("running");
  });

  it("lists only latest non-terminal attempts per invocation", () => {
    const { store, attempts } = harness();
    const generation = attempts.allocateDaemonGeneration(at(0));
    store.submit({
      invocationId: "inv_list_live",
      sessionId: "session-list",
      prompt: "list live",
      task: {
        type: "session.run",
        sessionId: "session-list",
        generation: 1,
        continuity: "session",
        cwd: process.cwd(),
        prompt: "list live",
      },
      now: at(0),
    });
    const first = attempts.create("inv_list_live", generation, "corr_list", at(0));
    attempts.accept(first, at(1));
    const crashed = attempts.crash(first, "process_exit", at(2), generation);
    expect(crashed.replacement).toBeDefined();
    const live = attempts.listNonTerminalAttempts();
    expect(live).toEqual([
      expect.objectContaining({
        invocationId: "inv_list_live",
        attemptEpoch: crashed.replacement!.attemptEpoch,
        status: "queued",
      }),
    ]);
  });
});

function harness(): {
  db: DatabaseSync;
  store: SparkInvocationStore;
  attempts: ExecutionAttemptStore;
} {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  migrateSparkDaemonDatabase(db);
  return {
    db,
    store: new SparkInvocationStore(db),
    attempts: new ExecutionAttemptStore(db),
  };
}

function at(offsetMs: number): string {
  return new Date(Date.parse("2026-08-14T00:00:00.000Z") + offsetMs).toISOString();
}
