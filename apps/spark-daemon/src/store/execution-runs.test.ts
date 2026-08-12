import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXECUTION_FENCE_MISMATCH, EXECUTION_TERMINAL_IMMUTABLE } from "@zendev-lab/spark-protocol";
import { ExecutionLifecycleError, ExecutionRunStore } from "./execution-runs.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

const now = "2026-08-12T00:00:00.000Z";

function createRun(
  store: ExecutionRunStore,
  db: DatabaseSync,
  input: {
    runRef: string;
    invocationId: string;
    taskRef?: string;
    projectRef?: string;
    workspaceId?: string;
    daemonGeneration: number;
  },
) {
  db.prepare(
    `INSERT INTO invocations (id, status, created_at, updated_at)
     VALUES (?, 'queued', ?, ?)`,
  ).run(input.invocationId, now, now);
  return store.createRun({ ...input, now });
}

function createStore(): { db: DatabaseSync; store: ExecutionRunStore } {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, store: new ExecutionRunStore(db) };
}

function stateDigest(db: DatabaseSync): string {
  const state = {
    runs: db.prepare("SELECT * FROM execution_runs ORDER BY run_ref").all(),
    attempts: db.prepare("SELECT * FROM execution_run_attempts ORDER BY attempt_id").all(),
    checkpoints: db.prepare("SELECT * FROM execution_checkpoints ORDER BY checkpoint_id").all(),
    leases: db.prepare("SELECT * FROM execution_leases ORDER BY lease_token").all(),
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

describe("ExecutionRunStore", () => {
  it("commits one fenced attempt claim", () => {
    const { db, store } = createStore();
    try {
      const run = createRun(store, db, {
        runRef: "run:claim",
        invocationId: "inv_claim",
        taskRef: "task:claim",
        projectRef: "proj:claim",
        workspaceId: "ws_claim",
        daemonGeneration: 7,
      });
      const claimed = store.claimAttempt({ runRef: run.runRef, daemonGeneration: 7, now });
      expect(claimed.run).toMatchObject({ status: "running", stateRevision: 1 });
      expect(claimed.attempt).toMatchObject({
        status: "running",
        attempt: 1,
        daemonGeneration: 7,
        stateRevision: 1,
        checkpointRevision: 0,
      });
      expect(claimed.attempt.leaseToken).toMatch(/^lease:/u);
      expect(db.prepare("SELECT count(*) AS count FROM execution_run_attempts").get()).toEqual({
        count: 1,
      });
      expect(
        db
          .prepare("SELECT count(*) AS count FROM execution_leases WHERE released_at IS NULL")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects stale execution writers", () => {
    const { db, store } = createStore();
    try {
      createRun(store, db, { runRef: "run:fence", invocationId: "inv_fence", daemonGeneration: 4 });
      const claimed = store.claimAttempt({ runRef: "run:fence", daemonGeneration: 4, now });
      const currentFence = {
        daemonGeneration: claimed.attempt.daemonGeneration,
        stateRevision: claimed.run.stateRevision,
        leaseToken: claimed.attempt.leaseToken,
      };
      for (const staleFence of [
        { ...currentFence, daemonGeneration: 3 },
        { ...currentFence, stateRevision: currentFence.stateRevision - 1 },
        { ...currentFence, leaseToken: "lease:stale" },
      ]) {
        const before = stateDigest(db);
        expect(() => store.finishRun("run:fence", staleFence, "succeeded", now)).toThrow(
          EXECUTION_FENCE_MISMATCH,
        );
        expect(stateDigest(db)).toBe(before);
      }
    } finally {
      db.close();
    }
  });

  it("preserves one logical run across replacement attempts", () => {
    const { db, store } = createStore();
    try {
      createRun(store, db, {
        runRef: "run:resume",
        invocationId: "inv_resume",
        taskRef: "task:resume",
        daemonGeneration: 1,
      });
      const claimed = store.claimAttempt({ runRef: "run:resume", daemonGeneration: 1, now });
      const paused = store.pauseRun(
        "run:resume",
        {
          daemonGeneration: 1,
          stateRevision: claimed.run.stateRevision,
          leaseToken: claimed.attempt.leaseToken,
        },
        "daemon_restart",
        now,
      );
      expect(paused).toMatchObject({
        runRef: "run:resume",
        status: "paused",
        pauseReason: "daemon_restart",
      });
      const resumed = store.resumePausedRun("run:resume", 2, now);
      expect(resumed.run.runRef).toBe("run:resume");
      expect(resumed.attempt).toMatchObject({
        attempt: 2,
        parentAttemptId: claimed.attempt.attemptId,
        daemonGeneration: 2,
      });
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM execution_run_attempts WHERE run_ref='run:resume'",
          )
          .get(),
      ).toEqual({ count: 2 });
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM execution_run_attempts WHERE run_ref='run:resume' AND status IN ('queued','running')",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("keeps terminal runs immutable", () => {
    const { db, store } = createStore();
    try {
      createRun(store, db, {
        runRef: "run:terminal",
        invocationId: "inv_terminal",
        daemonGeneration: 1,
      });
      const claimed = store.claimAttempt({ runRef: "run:terminal", daemonGeneration: 1, now });
      store.finishRun(
        "run:terminal",
        {
          daemonGeneration: 1,
          stateRevision: claimed.run.stateRevision,
          leaseToken: claimed.attempt.leaseToken,
        },
        "cancelled",
        now,
      );
      expect(() => store.resumePausedRun("run:terminal", 2, now)).toThrow(
        EXECUTION_TERMINAL_IMMUTABLE,
      );
      expect(() =>
        store.claimAttempt({ runRef: "run:terminal", daemonGeneration: 2, now }),
      ).toThrow(ExecutionLifecycleError);
    } finally {
      db.close();
    }
  });
});
