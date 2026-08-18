import type { DatabaseSync } from "node:sqlite";
import { channelMigrations } from "./channels.js";
import { executionAttemptMigrations } from "./execution-attempts.js";
import { humanWaitMigrations } from "./human-waits.js";
import { invocationPostLoopMigrations, invocationSchemaMigrations } from "./invocations.js";
import { loopMigrations } from "./loops.js";
import { reproMigrations } from "./repro.js";
import { runtimeControlMigrations } from "./runtime-control.js";
import { schemaFoundationMigrations } from "./schema-foundation.js";
import { sessionMigrations } from "./sessions.js";
import type { Migration } from "./types.js";
import { workspaceMigrations } from "./workspaces.js";

export const daemonMigrations: readonly Migration[] = [
  ...schemaFoundationMigrations,
  ...reproMigrations,
  ...sessionMigrations,
  ...channelMigrations,
  ...runtimeControlMigrations,
  ...invocationSchemaMigrations,
  ...executionAttemptMigrations,
  ...loopMigrations,
  ...humanWaitMigrations,
  ...invocationPostLoopMigrations,
  ...workspaceMigrations,
];

export function runDaemonMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = daemonMigrations,
): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new Error(`Duplicate daemon migration id: ${migration.id}`);
    seen.add(migration.id);
  }
  const applied = readAppliedMigrationIds(db);
  const now = new Date().toISOString();
  for (const migration of migrations) {
    if (!migration.everyOpen && applied.has(migration.id)) continue;
    migration.up(db);
    if (!migration.everyOpen) markMigrationApplied(db, migration.id, now);
  }
}

function readAppliedMigrationIds(db: DatabaseSync): Set<string> {
  if (!daemonMetaTableExists(db)) return new Set();
  const rows = db.prepare("SELECT key, value FROM daemon_meta").all() as Array<{
    key: string;
    value: string;
  }>;
  return new Set(rows.filter((row) => row.value === "complete").map((row) => row.key));
}

function markMigrationApplied(db: DatabaseSync, id: string, now: string): void {
  if (!daemonMetaTableExists(db)) return;
  db.prepare(
    `INSERT INTO daemon_meta (key, value, updated_at)
     VALUES (?, 'complete', ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(id, now);
}

function daemonMetaTableExists(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_meta' LIMIT 1")
      .get(),
  );
}
