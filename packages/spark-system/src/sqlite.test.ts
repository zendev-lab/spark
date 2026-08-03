import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDaemonSqliteResourceLimits,
  openMemorySqliteDatabase,
  openSqliteDatabase,
  SPARK_SQLITE_CACHE_LIMIT_KIB,
  SPARK_SQLITE_HARD_HEAP_LIMIT_BYTES,
  SPARK_SQLITE_MMAP_LIMIT_BYTES,
  SPARK_SQLITE_SOFT_HEAP_LIMIT_BYTES,
  SPARK_SQLITE_WAL_LIMIT_BYTES,
} from "./sqlite.ts";

describe("Spark SQLite mechanism", () => {
  it("opens a configured database with shared safety pragmas", () => {
    const db = openMemorySqliteDatabase();
    try {
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      db.close();
    }
  });

  it("applies daemon resource limits only when explicitly requested", () => {
    const db = openMemorySqliteDatabase();
    try {
      applyDaemonSqliteResourceLimits(db);
      expect(db.prepare("PRAGMA cache_size").get()).toEqual({
        cache_size: -SPARK_SQLITE_CACHE_LIMIT_KIB,
      });
      expect(db.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 1 });
      expect(db.prepare("PRAGMA soft_heap_limit").get()).toEqual({
        soft_heap_limit: SPARK_SQLITE_SOFT_HEAP_LIMIT_BYTES,
      });
      expect(db.prepare("PRAGMA hard_heap_limit").get()).toEqual({
        hard_heap_limit: SPARK_SQLITE_HARD_HEAP_LIMIT_BYTES,
      });
      expect(db.prepare("PRAGMA journal_size_limit").get()).toEqual({
        journal_size_limit: SPARK_SQLITE_WAL_LIMIT_BYTES,
      });
    } finally {
      db.close();
    }
  });

  it("creates the parent directory for a file-backed database", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-system-sqlite-"));
    const db = openSqliteDatabase(join(root, "nested", "spark.sqlite"), {
      autoVacuum: "incremental",
    });
    try {
      expect(db.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      applyDaemonSqliteResourceLimits(db);
      expect(db.prepare("PRAGMA mmap_size").get()).toEqual({
        mmap_size: SPARK_SQLITE_MMAP_LIMIT_BYTES,
      });
      db.exec("CREATE TABLE proof (id TEXT PRIMARY KEY)");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'proof'").get()).toEqual({
        name: "proof",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
