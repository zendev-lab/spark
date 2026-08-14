import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";

import { contentHash, nowIso, writeJsonFileAtomic } from "@zendev-lab/spark-core";

import { rewriteStructuredRoleRefs } from "./role-session-data-migration.ts";

interface SqliteMigrationMutation {
  table: string;
  column: string;
  locator: Record<string, string | number | bigint | null>;
  original: string;
  next: string;
}

export interface RoleSessionSqliteMigrationResult {
  changed: boolean;
  rows: number;
  backupPath?: string;
  journalPath?: string;
  migratedAt?: string;
}

interface RoleSessionSqliteMigrationJournal {
  version: 1;
  migration: "role-session-v6-sqlite";
  status: "backed_up" | "switching" | "complete" | "rolled_back" | "recovery_required";
  startedAt: string;
  migratedAt: string | null;
  databasePath: string;
  backupPath: string;
  restoreCommand: string;
  rows: number;
  sourceHash: string;
  targetHash: string;
}

/** Hard-cut RoleRefs embedded in daemon-owned SQLite JSON columns. */
export async function migrateRoleSessionSqliteData(input: {
  db: DatabaseSync;
  databasePath: string;
  backupRoot: string;
  now?: () => string;
  writeJournal?: (path: string, value: RoleSessionSqliteMigrationJournal) => Promise<void>;
}): Promise<RoleSessionSqliteMigrationResult> {
  const dbMeta = new Map<string, string>();
  try {
    const rows = input.db.prepare("SELECT key, value FROM daemon_meta").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const row of rows) dbMeta.set(row.key, row.value);
  } catch {
    // Older databases may not have daemon_meta yet; migration proceeds normally.
  }
  if (dbMeta.get("role-session-v6-sqlite") === "complete") {
    return { changed: false, rows: 0 };
  }

  const mutations = collectMutations(input.db);
  if (mutations.length === 0) {
    markMigrationComplete(input.db, (input.now ?? nowIso)());
    return { changed: false, rows: 0 };
  }

  const migratedAt = (input.now ?? nowIso)();
  const runId = `${migratedAt.replace(/[^0-9A-Za-z]/gu, "-")}-${randomUUID()}`;
  const backupDir = join(input.backupRoot, "role-session-v6-sqlite", runId);
  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${basename(input.databasePath)}.backup.sqlite`);
  input.db.exec(`VACUUM INTO ${sqlString(backupPath)}`);

  const journalPath = join(backupDir, "journal.json");
  const restoreCommand = `cp -p ${shellQuote(backupPath)} ${shellQuote(input.databasePath)}`;
  const journal: RoleSessionSqliteMigrationJournal = {
    version: 1,
    migration: "role-session-v6-sqlite",
    status: "backed_up",
    startedAt: migratedAt,
    migratedAt: null as string | null,
    databasePath: input.databasePath,
    backupPath,
    restoreCommand,
    rows: mutations.length,
    sourceHash: contentHash(mutations.map((entry) => entry.original).join("\0")),
    targetHash: contentHash(mutations.map((entry) => entry.next).join("\0")),
  };
  const writeJournal = input.writeJournal ?? writeJsonFileAtomic;
  await writeJournal(journalPath, journal);

  let transactionOpen = false;
  let committed = false;
  try {
    journal.status = "switching";
    await writeJournal(journalPath, journal);
    input.db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    for (const mutation of mutations) applyMutation(input.db, mutation);
    const remaining = collectMutations(input.db);
    if (remaining.length > 0)
      throw new Error(
        `SQLite RoleRef validation found ${remaining.length} unmigrated structured value(s)`,
      );
    input.db.exec("COMMIT");
    transactionOpen = false;
    committed = true;
    journal.status = "complete";
    journal.migratedAt = migratedAt;
    await writeJournal(journalPath, journal);
    input.db
      .prepare(
        `INSERT INTO daemon_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run("role-session-v6-sqlite", "complete", migratedAt);
  } catch (cause) {
    if (transactionOpen) input.db.exec("ROLLBACK");
    if (committed) {
      journal.status = "recovery_required";
      try {
        await writeJournal(journalPath, journal);
      } catch {
        // The existing switching journal and complete backup remain the
        // recovery authority when journal finalization itself is unavailable.
      }
      throw new Error(
        `Role/Session SQLite migration committed but journal finalization failed; daemon service is disabled. Restore with: ${restoreCommand}. ${errorMessage(cause)}`,
        { cause },
      );
    }
    journal.status = "rolled_back";
    await writeJournal(journalPath, journal);
    throw new Error(
      `Role/Session SQLite migration failed and was rolled back. Backup: ${backupPath}. Retry daemon start after resolving: ${errorMessage(cause)}`,
      { cause },
    );
  }

  return {
    changed: true,
    rows: mutations.length,
    backupPath,
    journalPath,
    migratedAt,
  };
}

function markMigrationComplete(db: DatabaseSync, migratedAt: string): void {
  db.prepare(
    `INSERT INTO daemon_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run("role-session-v6-sqlite", "complete", migratedAt);
}
function collectMutations(db: DatabaseSync): SqliteMigrationMutation[] {
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string | null }>;
  const mutations: SqliteMigrationMutation[] = [];
  for (const table of tables) {
    assertIdentifier(table.name);
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const jsonColumns = columns.filter((column) => column.name.endsWith("_json"));
    if (jsonColumns.length === 0) continue;
    const primaryKeys = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    const locatorColumns = primaryKeys.length > 0 ? primaryKeys : ["rowid"];
    for (const column of jsonColumns)
      mutations.push(...collectColumnMutations(db, table.name, column.name, locatorColumns));
  }
  return mutations;
}

function collectColumnMutations(
  db: DatabaseSync,
  table: string,
  column: string,
  locatorColumns: readonly string[],
): SqliteMigrationMutation[] {
  assertIdentifier(column);
  for (const locator of locatorColumns) assertIdentifier(locator);
  const locatorSelect = locatorColumns
    .map((locator) => (locator === "rowid" ? "rowid AS __locator_rowid" : quoteIdentifier(locator)))
    .join(", ");
  const rows = db
    .prepare(
      `SELECT ${locatorSelect}, ${quoteIdentifier(column)} AS __json
       FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`,
    )
    .all() as Array<Record<string, unknown> & { __json: string }>;
  const output: SqliteMigrationMutation[] = [];
  for (const row of rows) {
    if (typeof row.__json !== "string") throw new Error(`Expected JSON text in ${table}.${column}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.__json) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON in ${table}.${column}: ${errorMessage(error)}`);
    }
    const rewritten = rewriteStructuredRoleRefs(parsed);
    if (JSON.stringify(parsed) === JSON.stringify(rewritten)) continue;
    const locator: Record<string, string | number | bigint | null> = {};
    for (const key of locatorColumns) {
      const value = row[key === "rowid" ? "__locator_rowid" : key];
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "bigint"
      )
        throw new Error(`Unsupported SQLite locator for ${table}.${column}`);
      locator[key] = value;
    }
    output.push({
      table,
      column,
      locator,
      original: row.__json,
      next: JSON.stringify(rewritten),
    });
  }
  return output;
}

function applyMutation(db: DatabaseSync, mutation: SqliteMigrationMutation): void {
  const locators = Object.entries(mutation.locator);
  const where = locators
    .map(([column]) => `${column === "rowid" ? "rowid" : quoteIdentifier(column)} IS ?`)
    .join(" AND ");
  const result = db
    .prepare(
      `UPDATE ${quoteIdentifier(mutation.table)}
       SET ${quoteIdentifier(mutation.column)} = ?
       WHERE ${where} AND ${quoteIdentifier(mutation.column)} IS ?`,
    )
    .run(
      mutation.next,
      ...locators.map(([, value]) => value),
      mutation.original,
    ) as StatementResultingChanges;
  if (result.changes !== 1)
    throw new Error(`SQLite migration source changed at ${mutation.table}.${mutation.column}`);
}

function quoteIdentifier(value: string): string {
  assertIdentifier(value);
  return `"${value}"`;
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new Error(`Unsafe SQLite identifier: ${value}`);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
