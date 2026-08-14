import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { writeJsonFileAtomic } from "@zendev-lab/spark-core";
import { afterEach, describe, expect, it } from "vitest";

import { migrateRoleSessionSqliteData } from "./role-session-sqlite-migration.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Role/Session v6 SQLite migration", () => {
  it("backs up and rewrites only structured RoleRef fields across JSON columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-sqlite-migration-"));
    roots.push(root);
    const databasePath = join(root, "daemon.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateSparkDaemonDatabase(db);
    const now = "2026-08-04T10:00:00.000Z";
    db.prepare(
      `INSERT INTO invocations
        (id, status, task_json, result_json, created_at, updated_at)
       VALUES (?, 'succeeded', ?, ?, ?, ?)`,
    ).run(
      "inv_legacy",
      JSON.stringify({ roleRef: "role:builtin-worker", note: "keep role:builtin-worker" }),
      JSON.stringify({ effectiveRoleRef: "role:builtin-researcher" }),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
       VALUES (?, 'test', ?, 'pending', ?, ?)`,
    ).run("out_legacy", JSON.stringify({ reviewerRoleRefs: ["role:builtin-scout"] }), now, now);

    const first = await migrateRoleSessionSqliteData({
      db,
      databasePath,
      backupRoot: join(root, "backups"),
      now: () => now,
    });
    expect(first).toMatchObject({ changed: true, rows: 3, migratedAt: now });
    await expect(stat(first.backupPath!)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect(JSON.parse(await readFile(first.journalPath!, "utf8"))).toMatchObject({
      migration: "role-session-v6-sqlite",
      status: "complete",
      migratedAt: now,
    });

    const invocation = db
      .prepare(
        "SELECT task_json AS taskJson, result_json AS resultJson FROM invocations WHERE id = ?",
      )
      .get("inv_legacy") as { taskJson: string; resultJson: string };
    expect(JSON.parse(invocation.taskJson)).toEqual({
      roleRef: "role:builtin-executor",
      note: "keep role:builtin-worker",
    });
    expect(JSON.parse(invocation.resultJson)).toEqual({
      effectiveRoleRef: "role:builtin-explorer",
    });
    const outbox = db
      .prepare("SELECT payload_json AS payloadJson FROM outbox WHERE id = ?")
      .get("out_legacy") as { payloadJson: string };
    expect(JSON.parse(outbox.payloadJson)).toEqual({
      reviewerRoleRefs: ["role:builtin-explorer"],
    });
    expect(
      db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get("role-session-v6-sqlite"),
    ).toEqual({ value: "complete" });

    await expect(
      migrateRoleSessionSqliteData({
        db,
        databasePath,
        backupRoot: join(root, "backups"),
      }),
    ).resolves.toEqual({ changed: false, rows: 0 });
    db.close();
  });

  it("fails admission with a recovery command when journal finalization fails after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-role-session-sqlite-journal-failure-"));
    roots.push(root);
    const databasePath = join(root, "daemon.sqlite");
    const db = new DatabaseSync(databasePath);
    migrateSparkDaemonDatabase(db);
    const now = "2026-08-04T11:00:00.000Z";
    db.prepare(
      `INSERT INTO invocations
        (id, status, task_json, created_at, updated_at)
       VALUES (?, 'queued', ?, ?, ?)`,
    ).run("inv_legacy", JSON.stringify({ roleRef: "role:builtin-worker" }), now, now);

    await expect(
      migrateRoleSessionSqliteData({
        db,
        databasePath,
        backupRoot: join(root, "backups"),
        now: () => now,
        writeJournal: async (path, journal) => {
          if (journal.status === "complete") throw new Error("journal disk unavailable");
          await writeJsonFileAtomic(path, journal);
        },
      }),
    ).rejects.toThrow(/committed but journal finalization failed[\s\S]*Restore with:/u);

    const task = db
      .prepare("SELECT task_json AS taskJson FROM invocations WHERE id = ?")
      .get("inv_legacy") as { taskJson: string };
    expect(JSON.parse(task.taskJson)).toEqual({ roleRef: "role:builtin-executor" });
    const journalPath = join(
      root,
      "backups",
      "role-session-v6-sqlite",
      (await readdir(join(root, "backups", "role-session-v6-sqlite")))[0]!,
      "journal.json",
    );
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({
      status: "recovery_required",
    });
    db.close();
  });
});
