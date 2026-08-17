import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import {
  parseSparkDatabaseCompatibilityProbeArguments,
  type SparkDatabaseCompatibilityProbeResult,
} from "@zendev-lab/spark-system";

import { handleHubAccessCliCommand } from "./lib/server/hub-access-cli.ts";

interface CompatDatabaseIo {
  stdout: { write(value: string): unknown };
  stderr?: { write(value: string): unknown };
}

const defaultSentinel = "spark-database-compatibility-sentinel";
const sentinelPrefix = "__spark_database_compatibility__:";

export async function runHubCompatDatabaseCli(
  argv: string[],
  io: CompatDatabaseIo,
): Promise<number> {
  try {
    const parsed = parseSparkDatabaseCompatibilityProbeArguments(argv);
    const { loadMigrationBundle, migrate, openDatabase } = await import("@zendev-lab/spark-hub-db");
    const bundle = loadMigrationBundle();

    if (parsed.action === "interrupt") {
      if (parsed.migrationId && !bundle.migrations.some(({ id }) => id === parsed.migrationId)) {
        throw new Error(`unknown Hub migration: ${parsed.migrationId}`);
      }
      const db = openDatabase({ path: parsed.databasePath });
      try {
        migrate(db, bundle.migrations, {
          ...(parsed.migrationId
            ? {
                interrupt(boundary, migration) {
                  if (migration.id === parsed.migrationId && boundary === "after-sql") {
                    throw new Error("Injected Hub migration interruption before commit.");
                  }
                },
              }
            : {
                beforeCommit() {
                  throw new Error("Injected Hub migration interruption before commit.");
                },
              }),
        });
        throw new Error("Hub migration did not reach the requested interruption boundary.");
      } finally {
        db.close();
      }
    }

    if (parsed.action === "inject-unsafe") {
      const db = openDatabase({ path: parsed.databasePath });
      try {
        migrate(db);
        if (parsed.unsafeKind === "future") {
          db.prepare(
            `INSERT INTO schema_migration_records
              (migration_id, name, checksum, phase, state, applied_at)
             VALUES ('future-9999', 'future', ?, 'expand', 'clean', ?)`,
          ).run("f".repeat(64), new Date().toISOString());
        } else if (parsed.unsafeKind === "dirty") {
          updateLatestLedger(db, "state = 'dirty'");
        } else {
          updateLatestLedger(db, `state = 'clean', checksum = '${"f".repeat(64)}'`);
        }
        return output(io, { owner: "hub", injected: parsed.unsafeKind });
      } finally {
        db.close();
      }
    }

    const db = openDatabase({ path: parsed.databasePath });
    try {
      migrate(db);
    } finally {
      db.close();
    }
    const before = await handleHubAccessCliCommand({
      operation: "list",
      databasePath: parsed.databasePath,
    });
    const previousValues =
      before.operation === "list"
        ? before.tokens
            .map(({ label }) => label ?? "")
            .filter(Boolean)
            .map((label) =>
              label.startsWith(sentinelPrefix) ? label.slice(sentinelPrefix.length) : label,
            )
        : [];
    const sentinel =
      parsed.action === "write-read" ? (parsed.value ?? defaultSentinel) : previousValues.at(-1);
    if (parsed.action === "write-read") {
      await handleHubAccessCliCommand({
        operation: "create",
        databasePath: parsed.databasePath,
        label: sentinelPrefix + sentinel,
      });
    }
    return output(
      io,
      hubInspection(
        parsed.databasePath,
        parsed.action,
        previousValues,
        sentinel,
        bundle,
        openDatabase,
      ),
    );
  } catch (error) {
    return outputError(io, "hub", error);
  }
}

function hubInspection(
  database: string,
  action: "write-read" | "inspect",
  previousValues: string[],
  sentinel: string | undefined,
  bundle: ReturnType<typeof import("@zendev-lab/spark-hub-db").loadMigrationBundle>,
  openDatabase: (options?: { path?: string }) => DatabaseSync,
): SparkDatabaseCompatibilityProbeResult {
  const db = openDatabase({ path: database });
  try {
    const records = db
      .prepare(
        `SELECT migration_id AS id, state, checksum, phase
         FROM schema_migration_records
         ORDER BY migration_id`,
      )
      .all() as unknown as SparkDatabaseCompatibilityProbeResult["ledger"];
    const governedHead = (
      db
        .prepare("SELECT value FROM schema_migration_governance WHERE key = 'managed_head'")
        .get() as { value?: string } | undefined
    )?.value;
    return {
      schemaVersion: 1,
      owner: "hub",
      action,
      database,
      head: governedHead ?? bundle.manifest.currentSchemaHead,
      manifestSha256: createHash("sha256")
        .update(readFileSync(resolveManifestPath()))
        .digest("hex"),
      baselineChecksum: bundle.manifest.baseline.checksum,
      ledger: records,
      previousValues,
      ...(sentinel ? { sentinel } : {}),
    };
  } finally {
    db.close();
  }
}

function updateLatestLedger(db: { exec(sql: string): void }, assignment: string): void {
  db.exec(
    `UPDATE schema_migration_records SET ${assignment} WHERE migration_id = (SELECT migration_id FROM schema_migration_records ORDER BY migration_id DESC LIMIT 1)`,
  );
}

function resolveManifestPath(): string {
  return process.env.SPARK_PRODUCT_DIST
    ? join(process.env.SPARK_PRODUCT_DIST, "migrations/manifest.json")
    : join(
        dirname(fileURLToPath(import.meta.url)),
        "../../../packages/spark-hub-db/src/migrations/manifest.json",
      );
}

function output(io: CompatDatabaseIo, value: unknown): number {
  io.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

function outputError(io: CompatDatabaseIo, owner: "hub", error: unknown): number {
  const payload = {
    schemaVersion: 1,
    owner,
    ok: false,
    error: {
      code: "DATABASE_COMPATIBILITY_PROBE_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
  (io.stderr ?? io.stdout).write(`${JSON.stringify(payload)}\n`);
  return 1;
}
