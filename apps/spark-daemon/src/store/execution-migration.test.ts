import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "./schema.ts";

const now = "2026-08-12T00:00:00.000Z";

function digest(db: DatabaseSync, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

describe("execution aggregate migration", () => {
  it("backfills queued, running, and cancelled invocations idempotently", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSparkDaemonDatabase(db);
      const insert = db.prepare(
        `INSERT INTO invocations (id, status, task_json, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "inv_aggregate_queued",
        "queued",
        JSON.stringify({
          taskRef: "task:queued",
          projectRef: "proj:aggregate",
          workspaceId: "ws:queued",
        }),
        now,
        now,
        null,
        null,
      );
      insert.run(
        "inv_aggregate_running",
        "running",
        JSON.stringify({
          taskRef: "task:running",
          projectRef: "proj:aggregate",
          workspaceId: "ws:running",
        }),
        now,
        now,
        now,
        null,
      );
      insert.run(
        "inv_aggregate_cancelled",
        "cancelled",
        JSON.stringify({
          taskRef: "task:cancelled",
          projectRef: "proj:aggregate",
          workspaceId: "ws:cancelled",
        }),
        now,
        now,
        now,
        now,
      );

      migrateSparkDaemonDatabase(db);
      const first = {
        runCount: db.prepare("SELECT count(*) AS count FROM execution_runs").get(),
        attemptCount: db.prepare("SELECT count(*) AS count FROM execution_run_attempts").get(),
        runDigest: digest(db, "execution_runs"),
        attemptDigest: digest(db, "execution_run_attempts"),
      };
      expect(first.runCount).toEqual({ count: 3 });
      expect(first.attemptCount).toEqual({ count: 3 });
      expect(
        db
          .prepare(
            "SELECT status FROM execution_runs WHERE invocation_id='inv_aggregate_cancelled'",
          )
          .get(),
      ).toEqual({ status: "cancelled" });

      migrateSparkDaemonDatabase(db);
      expect({
        runCount: db.prepare("SELECT count(*) AS count FROM execution_runs").get(),
        attemptCount: db.prepare("SELECT count(*) AS count FROM execution_run_attempts").get(),
        runDigest: digest(db, "execution_runs"),
        attemptDigest: digest(db, "execution_run_attempts"),
      }).toEqual(first);
    } finally {
      db.close();
    }
  });
});
