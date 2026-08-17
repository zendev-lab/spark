import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import {
  applyDaemonSqliteResourceLimits,
  openSqliteDatabase,
  type SparkPaths,
  parseSparkSqliteMigrationManifest,
  sha256Text,
  type SparkSqliteMigrationManifest,
} from "@zendev-lab/spark-system";
import { runDaemonMigrations } from "./migrations/registry.js";

export interface DaemonCanonicalSchemaDescriptor {
  schemaVersion: 1;
  databaseId: "spark-daemon-sqlite";
  comparison: "required-subset";
  tables: Array<{
    name: string;
    columns: Array<{
      name: string;
      type: string;
      notNull: boolean;
      primaryKeyPosition: number;
    }>;
    indexes: string[];
  }>;
}

export function openSparkDaemonDatabase(paths: SparkPaths): DatabaseSync {
  return openSparkDaemonDatabasePath(paths.databasePath);
}

export function openSparkDaemonDatabasePath(
  databasePath: string,
  options: { interrupt?: (boundary: "after-schema" | "before-commit") => void } = {},
): DatabaseSync {
  const db = openSqliteDatabase(databasePath, { autoVacuum: "incremental" });
  try {
    applyDaemonSqliteResourceLimits(db);
    migrateSparkDaemonDatabase(db, options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function daemonManifestPath(): string {
  const candidates = [
    process.env.SPARK_DAEMON_MIGRATION_MANIFEST,
    process.env.SPARK_PRODUCT_DIST
      ? join(process.env.SPARK_PRODUCT_DIST, "migrations/daemon/manifest.json")
      : undefined,
    join(dirname(fileURLToPath(import.meta.url)), "migrations/daemon/manifest.json"),
    join(process.cwd(), "src/store/migrations/manifest.json"),
    join(dirname(fileURLToPath(import.meta.url)), "migrations/manifest.json"),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? candidates.at(-1)!
  );
}

export function loadDaemonMigrationManifest(
  manifestPath = daemonManifestPath(),
): SparkSqliteMigrationManifest {
  if (!existsSync(manifestPath))
    throw new Error("Daemon migration manifest not found: " + manifestPath);
  const manifest = parseSparkSqliteMigrationManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  if (manifest.owner !== "daemon" || manifest.databaseId !== "spark-daemon-sqlite")
    throw new Error("Daemon migration manifest owner/database mismatch");
  if (
    manifest.baseline.id !== "legacy-inline-v0" ||
    manifest.baseline.kind !== "validated-legacy-shape" ||
    manifest.baseline.checksumKind !== "canonical-schema-descriptor" ||
    manifest.baseline.provenance !== "legacy-unverified" ||
    manifest.baseline.introducedRelease !== null ||
    manifest.baseline.historicalMigrationHistoryAvailable
  ) {
    throw new Error("Daemon manifest must use the honest legacy-inline-v0 baseline");
  }
  if (
    manifest.preGovernanceMigrations.length !== 0 ||
    manifest.migrations.length !== 0 ||
    manifest.currentSchemaHead !== "legacy-inline-v0"
  ) {
    throw new Error("Daemon manifest cannot claim numbered historical migrations");
  }
  loadDaemonBaselineDescriptor(manifest, manifestPath);
  return manifest;
}

function loadDaemonBaselineDescriptor(
  manifest: SparkSqliteMigrationManifest,
  manifestPath: string,
): DaemonCanonicalSchemaDescriptor {
  const descriptorPath = join(dirname(manifestPath), manifest.baseline.checksumPath);
  if (!existsSync(descriptorPath))
    throw new Error("Daemon canonical schema descriptor not found: " + descriptorPath);
  const text = readFileSync(descriptorPath, "utf8");
  if (sha256Text(text) !== manifest.baseline.checksum)
    throw new Error("Daemon canonical schema descriptor checksum mismatch");
  const descriptor = JSON.parse(text) as Partial<DaemonCanonicalSchemaDescriptor>;
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.databaseId !== "spark-daemon-sqlite" ||
    descriptor.comparison !== "required-subset" ||
    !Array.isArray(descriptor.tables)
  ) {
    throw new Error("Daemon canonical schema descriptor is invalid");
  }
  return descriptor as DaemonCanonicalSchemaDescriptor;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table),
  );
}

function tableProjection(
  db: DatabaseSync,
  table: DaemonCanonicalSchemaDescriptor["tables"][number],
) {
  const columns = new Map(
    (
      db.prepare(`PRAGMA table_info(${JSON.stringify(table.name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>
    ).map((column) => [column.name, column]),
  );
  const indexes = new Set(
    (
      db.prepare(`PRAGMA index_list(${JSON.stringify(table.name)})`).all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  return { columns, indexes };
}

function validateDaemonCanonicalSchema(
  db: DatabaseSync,
  manifest: SparkSqliteMigrationManifest,
  manifestPath: string,
): void {
  const descriptor = loadDaemonBaselineDescriptor(manifest, manifestPath);
  for (const table of descriptor.tables) {
    if (!tableExists(db, table.name))
      throw new Error("Daemon schema is missing baseline table: " + table.name);
    const { columns, indexes } = tableProjection(db, table);
    for (const expected of table.columns) {
      const actual = columns.get(expected.name);
      if (
        !actual ||
        actual.type.toUpperCase() !== expected.type.toUpperCase() ||
        actual.pk !== expected.primaryKeyPosition
      ) {
        throw new Error(
          `Daemon schema column does not match baseline descriptor: ${table.name}.${expected.name}`,
        );
      }
    }
    for (const index of table.indexes) {
      if (!indexes.has(index)) throw new Error("Daemon schema is missing baseline index: " + index);
    }
  }
}

function daemonSchemaFingerprint(
  db: DatabaseSync,
  manifest: SparkSqliteMigrationManifest,
  manifestPath: string,
): string {
  const descriptor = loadDaemonBaselineDescriptor(manifest, manifestPath);
  const projection = descriptor.tables.map((table) => {
    const { columns, indexes } = tableProjection(db, table);
    return {
      name: table.name,
      columns: table.columns.map((expected) => {
        const actual = columns.get(expected.name);
        return actual
          ? {
              name: actual.name,
              type: actual.type.toUpperCase(),
              notNull: Boolean(actual.notnull),
              primaryKeyPosition: actual.pk,
            }
          : { name: expected.name, missing: true };
      }),
      indexes: table.indexes.map((name) => ({ name, present: indexes.has(name) })),
    };
  });
  return sha256Text(JSON.stringify(projection));
}

function validateDaemonSchemaMarker(
  db: DatabaseSync,
  manifest: SparkSqliteMigrationManifest,
  manifestPath: string,
): void {
  if (!tableExists(db, "daemon_meta")) return;
  const rows = db
    .prepare("SELECT key, value FROM daemon_meta WHERE key LIKE 'schema.compatibility.%'")
    .all() as Array<{ key: string; value: string }>;
  const marker = new Map(rows.map((row) => [row.key, row.value]));
  const head = marker.get("schema.compatibility.head");
  const checksum = marker.get("schema.compatibility.baseline_checksum");
  const state = marker.get("schema.compatibility.state");
  const fingerprint = marker.get("schema.compatibility.schema_fingerprint");
  if (head && head !== manifest.currentSchemaHead)
    throw new Error("Daemon database has unknown or future schema head: " + head);
  if (checksum && checksum !== manifest.baseline.checksum)
    throw new Error("Daemon legacy baseline checksum mismatch");
  if (fingerprint && fingerprint !== daemonSchemaFingerprint(db, manifest, manifestPath))
    throw new Error("Daemon validated baseline schema fingerprint mismatch");
  if (state === "dirty" || state === "failed")
    throw new Error("Daemon schema compatibility marker is not clean: " + state);
}

function recordDaemonSchemaMarker(
  db: DatabaseSync,
  manifest: SparkSqliteMigrationManifest,
  manifestPath: string,
): void {
  validateDaemonCanonicalSchema(db, manifest, manifestPath);
  const now = new Date().toISOString();
  const entries = [
    ["schema.compatibility.owner", manifest.owner],
    ["schema.compatibility.database", manifest.databaseId],
    ["schema.compatibility.head", manifest.currentSchemaHead],
    ["schema.compatibility.baseline", manifest.baseline.id],
    ["schema.compatibility.baseline_checksum", manifest.baseline.checksum],
    ["schema.compatibility.state", "legacy-unverified"],
    [
      "schema.compatibility.schema_fingerprint",
      daemonSchemaFingerprint(db, manifest, manifestPath),
    ],
  ] as const;
  const statement = db.prepare(
    "INSERT INTO daemon_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  for (const [key, value] of entries) statement.run(key, value, now);
}

export function migrateSparkDaemonDatabase(
  db: DatabaseSync,
  options: { interrupt?: (boundary: "after-schema" | "before-commit") => void } = {},
): void {
  const manifestPath = daemonManifestPath();
  const manifest = loadDaemonMigrationManifest(manifestPath);
  validateDaemonSchemaMarker(db, manifest, manifestPath);
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    runDaemonMigrations(db);
    options.interrupt?.("after-schema");
    recordDaemonSchemaMarker(db, manifest, manifestPath);
    options.interrupt?.("before-commit");
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
