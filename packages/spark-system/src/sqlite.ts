import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SPARK_SQLITE_CACHE_LIMIT_KIB = 256 * 1024;
export const SPARK_SQLITE_MMAP_LIMIT_BYTES = 256 * 1024 * 1024;
export const SPARK_SQLITE_SOFT_HEAP_LIMIT_BYTES = 256 * 1024 * 1024;
export const SPARK_SQLITE_HARD_HEAP_LIMIT_BYTES = 384 * 1024 * 1024;
export const SPARK_SQLITE_WAL_LIMIT_BYTES = 64 * 1024 * 1024;

export interface OpenSqliteDatabaseOptions {
  autoVacuum?: "incremental";
}

export function openSqliteDatabase(
  path: string,
  options: OpenSqliteDatabaseOptions = {},
): DatabaseSync {
  const databasePath = resolve(path);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    if (options.autoVacuum === "incremental") {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    }
    applySqlitePragmas(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openMemorySqliteDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applySqlitePragmas(db);
  return db;
}

export function applySqlitePragmas(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
}

/** Apply daemon-specific bounds without imposing process-global limits on Cockpit SQLite. */
export function applyDaemonSqliteResourceLimits(db: DatabaseSync): void {
  // Negative cache_size is a KiB ceiling. Keep SQLite's page cache and mmap
  // well below the 1 GiB process budget, and force temporary query state to
  // disk so a large database cannot turn an accidental sort into an OOM.
  db.exec("PRAGMA cache_size = -262144");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA soft_heap_limit = 268435456");
  db.exec("PRAGMA hard_heap_limit = 402653184");
  db.exec("PRAGMA journal_size_limit = 67108864");
  db.exec("PRAGMA temp_store = FILE");
  db.exec("PRAGMA cache_spill = ON");
}
