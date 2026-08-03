import type { DatabaseSync } from "node:sqlite";

export const DAEMON_STORAGE_MAINTENANCE_ACTIVE_INTERVAL_MS = 60 * 1_000;
export const DAEMON_STORAGE_MAINTENANCE_IDLE_INTERVAL_MS = 60 * 60 * 1_000;
export const DAEMON_RETENTION_DELETE_BATCH_SIZE = 64;
export const DAEMON_INCREMENTAL_VACUUM_MAX_PAGES = 64;

export type SparkSqliteAutoVacuumMode = "none" | "full" | "incremental";

export interface SparkSqliteVacuumResult {
  autoVacuumMode: SparkSqliteAutoVacuumMode;
  freelistPagesBefore: number;
  freelistPagesAfter: number;
  pageCountBefore: number;
  pageCountAfter: number;
  pagesReclaimed: number;
}

/** Reclaim a bounded number of pages only when the database already supports it. */
export function runBoundedIncrementalVacuum(db: DatabaseSync): SparkSqliteVacuumResult {
  const autoVacuumMode = sqliteAutoVacuumMode(db);
  const freelistPagesBefore = sqliteFreelistCount(db);
  const pageCountBefore = sqlitePageCount(db);
  if (autoVacuumMode === "incremental" && freelistPagesBefore > 0) {
    db.exec("PRAGMA incremental_vacuum(64)");
  }
  const freelistPagesAfter = sqliteFreelistCount(db);
  const pageCountAfter = sqlitePageCount(db);
  return {
    autoVacuumMode,
    freelistPagesBefore,
    freelistPagesAfter,
    pageCountBefore,
    pageCountAfter,
    pagesReclaimed: Math.max(0, pageCountBefore - pageCountAfter),
  };
}

export function sqliteAutoVacuumMode(db: DatabaseSync): SparkSqliteAutoVacuumMode {
  const row = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
  const value = Number(row.auto_vacuum);
  if (value === 1) return "full";
  if (value === 2) return "incremental";
  return "none";
}

function sqliteFreelistCount(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA freelist_count").get() as { freelist_count: number };
  return Number(row.freelist_count);
}

function sqlitePageCount(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA page_count").get() as { page_count: number };
  return Number(row.page_count);
}
