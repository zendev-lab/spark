import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSqliteDatabase, resolveSparkPaths } from "@zendev-lab/spark-system";
import { describe, expect, it } from "vitest";
import { openSparkDaemonDatabase } from "./schema.ts";
import {
  DAEMON_INCREMENTAL_VACUUM_MAX_PAGES,
  runBoundedIncrementalVacuum,
  sqliteAutoVacuumMode,
} from "./sqlite-maintenance.ts";

describe("daemon SQLite maintenance", () => {
  it("opens a new daemon database in incremental mode even after WAL setup", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-sqlite-open-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const db = openSparkDaemonDatabase(paths);
    try {
      expect(sqliteAutoVacuumMode(db)).toBe("incremental");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not convert an existing none-mode daemon database during startup", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-sqlite-existing-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const legacy = openSqliteDatabase(paths.databasePath);
    legacy.exec("CREATE TABLE legacy_proof (id INTEGER PRIMARY KEY)");
    legacy.close();

    const db = openSparkDaemonDatabase(paths);
    try {
      expect(sqliteAutoVacuumMode(db)).toBe("none");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims only a bounded number of free pages from an incremental database", () => {
    withDatabase((db, path) => {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("CREATE TABLE proof (payload BLOB)");
      const insert = db.prepare("INSERT INTO proof (payload) VALUES (?)");
      db.exec("BEGIN");
      for (let index = 0; index < 256; index += 1) insert.run(Buffer.alloc(8 * 1_024));
      db.exec("COMMIT; DELETE FROM proof");
      const bytesBefore = statSync(path).size;

      const result = runBoundedIncrementalVacuum(db);

      expect(result.autoVacuumMode).toBe("incremental");
      expect(result.pagesReclaimed).toBeGreaterThan(0);
      expect(result.pagesReclaimed).toBeLessThanOrEqual(DAEMON_INCREMENTAL_VACUUM_MAX_PAGES);
      expect(result.freelistPagesAfter).toBeLessThan(result.freelistPagesBefore);
      expect(statSync(path).size).toBeLessThan(bytesBefore);
    });
  });

  it("leaves a legacy none-mode database unchanged", () => {
    withDatabase((db) => {
      db.exec("CREATE TABLE proof (payload BLOB)");
      db.prepare("INSERT INTO proof (payload) VALUES (?)").run(Buffer.alloc(16 * 1_024));
      db.exec("DELETE FROM proof");

      const result = runBoundedIncrementalVacuum(db);

      expect(result.autoVacuumMode).toBe("none");
      expect(result.pagesReclaimed).toBe(0);
      expect(result.pageCountAfter).toBe(result.pageCountBefore);
    });
  });
});

function withDatabase(run: (db: DatabaseSync, path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-sqlite-maintenance-"));
  const path = join(root, "daemon.sqlite");
  const db = new DatabaseSync(path);
  try {
    run(db, path);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
