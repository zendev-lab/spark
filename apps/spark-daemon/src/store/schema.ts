import type { DatabaseSync } from "node:sqlite";

import {
  applyDaemonSqliteResourceLimits,
  openSqliteDatabase,
  type SparkPaths,
} from "@zendev-lab/spark-system";
import { runDaemonMigrations } from "./migrations/registry.js";

export function openSparkDaemonDatabase(paths: SparkPaths): DatabaseSync {
  const db = openSqliteDatabase(paths.databasePath, { autoVacuum: "incremental" });
  applyDaemonSqliteResourceLimits(db);
  migrateSparkDaemonDatabase(db);
  return db;
}

export function migrateSparkDaemonDatabase(db: DatabaseSync): void {
  runDaemonMigrations(db);
}
