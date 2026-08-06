import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applySqlitePragmas,
  openMemorySqliteDatabase,
  openSqliteDatabase,
  resolveSparkPaths,
} from "@zendev-lab/spark-system";

import { migrateLegacyCockpitLayout } from "./layout-migration.js";

export interface OpenDatabaseOptions {
  path?: string;
}

export function defaultDatabasePath(): string {
  migrateLegacyCockpitLayout();
  return resolveSparkPaths({ app: "hub" }).databasePath;
}

export function openDatabase(options: OpenDatabaseOptions = {}): DatabaseSync {
  const databasePath = resolve(options.path ?? defaultDatabasePath());
  return openSqliteDatabase(databasePath);
}

export function openMemoryDatabase(): DatabaseSync {
  return openMemorySqliteDatabase();
}

export function applyPragmas(db: DatabaseSync): void {
  applySqlitePragmas(db);
}
