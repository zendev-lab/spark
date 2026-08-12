import type { DatabaseSync } from "node:sqlite";
import { channelMigrations } from "./channels.js";
import { executionAttemptMigrations } from "./execution-attempts.js";
import { executionMigrations } from "./execution.js";
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
  ...executionMigrations,
  ...workspaceMigrations,
];

export function runDaemonMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = daemonMigrations,
): void {
  // These steps remain idempotent and intentionally run on every open. Some
  // compatibility owners scrub late writes or backfill newly registered rows;
  // only migrations that historically used daemon_meta keep durable markers.
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) throw new Error(`Duplicate daemon migration id: ${migration.id}`);
    seen.add(migration.id);
  }
  for (const migration of migrations) {
    migration.up(db);
  }
}
