import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import {
  parseSparkSqliteMigrationManifest,
  sha256Text,
  type SparkSqliteMigrationManifest,
  type SparkSqliteMigrationManifestEntry,
} from "@zendev-lab/spark-system";

export interface Migration extends SparkSqliteMigrationManifestEntry {
  sql: string;
  version: string;
}
export interface LegacyMigrationInput {
  version: string;
  name: string;
  sql: string;
}
export interface HubMigrationBundle {
  manifest: SparkSqliteMigrationManifest;
  migrations: Migration[];
}
export type HubMigrationExecutionMode =
  | "auto"
  | "full-bootstrap"
  | "legacy-adoption"
  | "adjacent-update";
export interface HubMigrationOptions {
  mode?: HubMigrationExecutionMode;
  interrupt?: (boundary: "after-dirty" | "after-sql", migration: Migration) => void;
  beforeCommit?: () => void;
}

function defaultMigrationsDirectory(): string {
  return process.env.SPARK_PRODUCT_DIST
    ? join(process.env.SPARK_PRODUCT_DIST, "migrations")
    : join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

export function loadMigrationBundle(directory = defaultMigrationsDirectory()): HubMigrationBundle {
  if (!existsSync(directory)) throw new Error("Spark migrations directory not found: " + directory);
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error("Spark migration manifest not found: " + manifestPath);
  const manifest = parseSparkSqliteMigrationManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  if (manifest.owner !== "hub" || manifest.databaseId !== "spark-hub-sqlite")
    throw new Error("Hub migration manifest owner/database mismatch");
  const manifestEntries = [...manifest.preGovernanceMigrations, ...manifest.migrations];
  const sqlNames = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const listedNames = manifestEntries.map((entry) => entry.sqlPath);
  if (listedNames.some((name) => name === null))
    throw new Error("Hub migrations must reference packaged SQL");
  if (
    JSON.stringify(sqlNames) !==
    JSON.stringify(
      [...listedNames].sort((left, right) => String(left).localeCompare(String(right))),
    )
  )
    throw new Error("Hub migration manifest and packaged SQL inventory differ");
  const migrations = manifestEntries.map((entry) => {
    const sql = readFileSync(join(directory, entry.sqlPath!), "utf8");
    const checksum = sha256Text(sql);
    if (checksum !== entry.checksum)
      throw new Error("Hub migration checksum mismatch for " + entry.id);
    const expectedPrefix = entry.id + "_" + entry.name + ".sql";
    if (entry.sqlPath !== expectedPrefix)
      throw new Error("Hub migration filename does not match manifest identity: " + entry.id);
    return { ...entry, sql, version: entry.id };
  });
  if (migrations.at(-1)?.id !== manifest.currentSchemaHead)
    throw new Error("Hub currentSchemaHead does not match final migration");
  return { manifest, migrations };
}

export function loadMigrations(directory?: string): Migration[] {
  return loadMigrationBundle(directory).migrations;
}

function repairLegacyWorkspaceSchema(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces' LIMIT 1")
    .get() as { sql?: string } | undefined;
  if (!table?.sql) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  if (!columns.has("local_workspace_key") || !columns.has("display_name")) return;
  for (const definition of [
    "slug TEXT",
    "name TEXT",
    "description TEXT",
    "settings_json TEXT NOT NULL DEFAULT '{}'",
  ] as const) {
    const name = definition.split(" ", 1)[0]!;
    if (!columns.has(name)) db.exec("ALTER TABLE workspaces ADD COLUMN " + definition);
  }
  db.exec(
    "UPDATE workspaces SET slug = COALESCE(NULLIF(local_workspace_key, ''), 'workspace-' || id), name = COALESCE(NULLIF(display_name, ''), NULLIF(local_workspace_key, ''), id), description = NULL, status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END, updated_at = COALESCE(updated_at, created_at)",
  );
}

export function migrate(
  db: DatabaseSync,
  migrations: Array<Migration | LegacyMigrationInput> = loadMigrations(),
  options: HubMigrationOptions = {},
): void {
  const bootstrapMigration = migrations.find((migration) => migration.version === "0001") as
    | Migration
    | undefined;
  if (!bootstrapMigration) throw new Error("Missing bootstrap migration 0001");
  const managedMigrations = migrations as Migration[];
  const fullBundle = loadMigrationBundle();
  const known = new Map(fullBundle.migrations.map((migration) => [migration.id, migration]));
  db.exec("BEGIN IMMEDIATE");
  try {
    const migrationGovernanceExists = tableExists(db, "schema_migration_governance");
    const governedHead = migrationGovernanceExists
      ? (
          db
            .prepare("SELECT value FROM schema_migration_governance WHERE key = 'managed_head'")
            .get() as { value?: string } | undefined
        )?.value
      : undefined;
    if (governedHead && !known.has(governedHead))
      throw new Error("Hub database has unknown or future managed schema head: " + governedHead);
    const schemaMigrationsExists = tableExists(db, "schema_migrations");
    const hasExistingSchema = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migration_records', 'schema_migration_governance') LIMIT 1",
        )
        .get(),
    );
    const freshDatabase = !schemaMigrationsExists && !hasExistingSchema;
    const inferredMode: Exclude<HubMigrationExecutionMode, "auto"> = freshDatabase
      ? "full-bootstrap"
      : governedHead
        ? "adjacent-update"
        : "legacy-adoption";
    const mode =
      options.mode === undefined || options.mode === "auto" ? inferredMode : options.mode;
    if (mode !== inferredMode) {
      throw new Error(`Hub migration mode ${mode} does not match database state ${inferredMode}`);
    }
    if (!schemaMigrationsExists && freshDatabase) db.exec(bootstrapMigration.sql);
    if (!schemaMigrationsExists && !freshDatabase)
      db.exec(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      );
    repairLegacyWorkspaceSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migration_records (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT,
      phase TEXT NOT NULL CHECK (phase IN ('expand', 'backfill', 'contract')),
      state TEXT NOT NULL CHECK (state IN ('legacy-unverified', 'dirty', 'clean', 'failed')),
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migration_governance (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    const freshBootstrap = freshDatabase;
    if (!freshDatabase && !schemaMigrationsExists) {
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        bootstrapMigration.version,
        bootstrapMigration.name,
        new Date().toISOString(),
      );
    }
    if (freshBootstrap) {
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        bootstrapMigration.version,
        bootstrapMigration.name,
        new Date().toISOString(),
      );
      db.prepare(
        "INSERT INTO schema_migration_records (migration_id, name, checksum, phase, state, applied_at) VALUES (?, ?, ?, ?, 'clean', ?)",
      ).run(
        bootstrapMigration.id,
        bootstrapMigration.name,
        bootstrapMigration.checksum,
        bootstrapMigration.phase,
        new Date().toISOString(),
      );
    }
    const applied = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: string; name: string }>;
    for (const row of applied) {
      const expected = known.get(row.version);
      if (!expected)
        throw new Error(
          "Hub database contains unknown or future applied migration: " + row.version,
        );
      if (expected.name !== row.name)
        throw new Error("Hub applied migration identity mismatch: " + row.version);
    }
    if (!freshDatabase) {
      const adopt = db.prepare(
        "INSERT OR IGNORE INTO schema_migration_records (migration_id, name, checksum, phase, state, applied_at) VALUES (?, ?, NULL, ?, 'legacy-unverified', ?)",
      );
      for (const row of applied) {
        const expected = known.get(row.version)!;
        adopt.run(row.version, row.name, expected.phase, new Date().toISOString());
      }
    }
    validateMigrationRecords(db, known);
    const insertLegacy = db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    const insertRecord = db.prepare(
      "INSERT INTO schema_migration_records (migration_id, name, checksum, phase, state, applied_at) VALUES (?, ?, ?, ?, 'clean', ?)",
    );
    const hasMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1");
    for (const migration of managedMigrations) {
      if (hasMigration.get(migration.id)) continue;
      if (
        mode === "adjacent-update" &&
        (!migration.automatic || migration.provenance !== "governed")
      ) {
        throw new Error(
          `Hub adjacent update is not eligible to apply ${migration.id}: governed automatic expand required`,
        );
      }
      db.prepare(
        "INSERT INTO schema_migration_records (migration_id, name, checksum, phase, state, applied_at) VALUES (?, ?, ?, ?, 'dirty', ?)",
      ).run(
        migration.version,
        migration.name,
        migration.checksum,
        migration.phase,
        new Date().toISOString(),
      );
      options.interrupt?.("after-dirty", migration);
      if (migration.version === "0022") assertHubIdentityMigrationIsUnambiguous(db);
      db.exec(migration.sql);
      options.interrupt?.("after-sql", migration);
      insertLegacy.run(migration.version, migration.name, new Date().toISOString());
      db.prepare("DELETE FROM schema_migration_records WHERE migration_id = ?").run(migration.id);
      insertRecord.run(
        migration.version,
        migration.name,
        migration.checksum,
        migration.phase,
        new Date().toISOString(),
      );
    }
    validateMigrationRecords(db, known);
    const appliedCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number })
        .count,
    );
    if (appliedCount === known.size) {
      db.prepare(
        "INSERT INTO schema_migration_governance (key, value, updated_at) VALUES ('managed_head', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(fullBundle.manifest.currentSchemaHead, new Date().toISOString());
    }
    options.beforeCommit?.();
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function validateMigrationRecords(db: DatabaseSync, known: Map<string, Migration>): void {
  const records = db
    .prepare(
      "SELECT migration_id AS id, name, checksum, phase, state FROM schema_migration_records ORDER BY migration_id",
    )
    .all() as Array<{
    id: string;
    name: string;
    checksum: string | null;
    phase: string;
    state: string;
  }>;
  for (const record of records) {
    const expected = known.get(record.id);
    if (!expected)
      throw new Error("Hub database contains unknown or future migration record: " + record.id);
    if (record.state === "dirty" || record.state === "failed")
      throw new Error(
        "Hub migration record is not clean: " + record.id + " (" + record.state + ")",
      );
    if (record.name !== expected.name || record.phase !== expected.phase)
      throw new Error("Hub migration record identity mismatch: " + record.id);
    if (record.state === "clean" && record.checksum !== expected.checksum)
      throw new Error("Hub applied migration checksum mismatch: " + record.id);
    if (record.state === "legacy-unverified" && record.checksum !== null)
      throw new Error("Hub legacy-unverified migration must not claim a checksum: " + record.id);
  }
}
function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}
function assertHubIdentityMigrationIsUnambiguous(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cockpit_access_tokens', 'hub_access_tokens') ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  if (tables.length > 1)
    throw new Error(
      "Hub identity migration conflict: both cockpit_access_tokens and hub_access_tokens exist.",
    );
  for (const [legacyKey, hubKey] of [
    ["spark_cockpit:instance_id", "spark_hub:instance_id"],
    ["spark_cockpit:web_push_subscription", "spark_hub:web_push_subscription"],
  ] as const) {
    const rows = db
      .prepare("SELECT key, value_json AS valueJson FROM app_settings WHERE key IN (?, ?)")
      .all(legacyKey, hubKey) as Array<{ key: string; valueJson: string }>;
    if (rows.length === 2 && new Set(rows.map(({ valueJson }) => valueJson)).size > 1)
      throw new Error(
        "Hub identity migration conflict: " +
          legacyKey +
          " and " +
          hubKey +
          " contain different values.",
      );
  }
}
