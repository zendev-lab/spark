import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

const migrationsDirectory = process.env.SPARK_PRODUCT_DIST
  ? join(process.env.SPARK_PRODUCT_DIST, "migrations")
  : join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function loadMigrations(): Migration[] {
  if (!existsSync(migrationsDirectory)) {
    throw new Error(`Spark migrations directory not found: ${migrationsDirectory}`);
  }

  return readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const [versionPart, ...nameParts] = file.replace(/\.sql$/, "").split("_");
      if (!versionPart || nameParts.length === 0) {
        throw new Error(`Invalid migration filename: ${file}`);
      }

      return {
        version: versionPart,
        name: nameParts.join("_"),
        sql: readFileSync(join(migrationsDirectory, file), "utf8"),
      };
    });
}

function repairLegacyWorkspaceSchema(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces' LIMIT 1")
    .get() as { sql?: string } | undefined;
  if (!table?.sql || /\bslug\b/u.test(table.sql)) return;

  // A historical daemon schema could be opened at the Hub path. Keep its
  // rows and leases usable while adding the Hub workspace identity fields.
  db.exec(`
    ALTER TABLE workspaces ADD COLUMN slug TEXT;
    ALTER TABLE workspaces ADD COLUMN name TEXT;
    ALTER TABLE workspaces ADD COLUMN description TEXT;
    ALTER TABLE workspaces ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
  `);
  db.exec(`
    UPDATE workspaces
    SET slug = COALESCE(NULLIF(local_workspace_key, ''), 'workspace-' || id),
        name = COALESCE(NULLIF(display_name, ''), NULLIF(local_workspace_key, ''), id),
        description = NULL,
        status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'active' END,
        updated_at = COALESCE(updated_at, created_at);
  `);
}

export function migrate(db: DatabaseSync, migrations = loadMigrations()): void {
  db.exec("BEGIN");
  try {
    const bootstrapMigration = migrations.find((migration) => migration.version === "0001");
    if (!bootstrapMigration) {
      throw new Error("Missing bootstrap migration 0001");
    }

    const schemaMigrationsExists = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1",
        )
        .get(),
    );
    if (!schemaMigrationsExists) {
      db.exec(bootstrapMigration.sql);
    }

    repairLegacyWorkspaceSchema(db);

    const bootstrapAppliedAt = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(bootstrapMigration.version, bootstrapMigration.name, bootstrapAppliedAt);

    const hasMigration = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1");
    const insertMigration = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (migration.version === bootstrapMigration.version || hasMigration.get(migration.version)) {
        continue;
      }

      if (migration.version === "0022") {
        assertHubIdentityMigrationIsUnambiguous(db);
      }
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function assertHubIdentityMigrationIsUnambiguous(db: DatabaseSync): void {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cockpit_access_tokens', 'hub_access_tokens') ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  if (tables.length > 1) {
    throw new Error(
      "Hub identity migration conflict: both cockpit_access_tokens and hub_access_tokens exist.",
    );
  }

  for (const [legacyKey, hubKey] of [
    ["spark_cockpit:instance_id", "spark_hub:instance_id"],
    ["spark_cockpit:web_push_subscription", "spark_hub:web_push_subscription"],
  ] as const) {
    const rows = db
      .prepare("SELECT key, value_json AS valueJson FROM app_settings WHERE key IN (?, ?)")
      .all(legacyKey, hubKey) as Array<{ key: string; valueJson: string }>;
    if (rows.length !== 2) continue;
    if (new Set(rows.map(({ valueJson }) => valueJson)).size > 1) {
      throw new Error(
        `Hub identity migration conflict: ${legacyKey} and ${hubKey} contain different values.`,
      );
    }
  }
}
