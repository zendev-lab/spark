import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  parseSparkDatabaseCompatibilityProbeArguments,
  type SparkDatabaseCompatibilityProbeResult,
} from "@zendev-lab/spark-system";

import { loadDaemonMigrationManifest, openSparkDaemonDatabasePath } from "./store/schema.ts";

interface CompatDatabaseIo {
  stdout: { write(value: string): unknown };
  stderr?: { write(value: string): unknown };
}

const defaultSentinel = "spark-database-compatibility-sentinel";

export function runDaemonCompatDatabaseCli(argv: string[], io: CompatDatabaseIo): number {
  try {
    const parsed = parseSparkDatabaseCompatibilityProbeArguments(argv);
    if (parsed.action === "interrupt") {
      if (parsed.migrationId && parsed.migrationId !== "legacy-inline-v0") {
        throw new Error(`unknown daemon migration: ${parsed.migrationId}`);
      }
      openSparkDaemonDatabasePath(parsed.databasePath, {
        interrupt(boundary) {
          if (boundary === "before-commit") {
            throw new Error("Injected daemon migration interruption before commit.");
          }
        },
      });
      throw new Error("Daemon migration did not reach the requested interruption boundary.");
    }

    const db = openSparkDaemonDatabasePath(parsed.databasePath);
    try {
      if (parsed.action === "inject-unsafe") {
        const [key, value] =
          parsed.unsafeKind === "future"
            ? ["schema.compatibility.head", "future-9999"]
            : parsed.unsafeKind === "dirty"
              ? ["schema.compatibility.state", "dirty"]
              : ["schema.compatibility.baseline_checksum", "f".repeat(64)];
        db.prepare("UPDATE daemon_meta SET value = ?, updated_at = ? WHERE key = ?").run(
          value,
          new Date().toISOString(),
          key,
        );
        return output(io, { owner: "daemon", injected: parsed.unsafeKind });
      }

      const previousValues = daemonSentinels(db);
      const sentinel =
        parsed.action === "write-read" ? (parsed.value ?? defaultSentinel) : undefined;
      if (sentinel !== undefined) {
        db.prepare(
          "INSERT INTO daemon_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        ).run(
          `release.compatibility.sentinel.${createHash("sha256").update(sentinel).digest("hex")}`,
          sentinel,
          new Date().toISOString(),
        );
      }
      return output(
        io,
        daemonInspection(db, parsed.action, parsed.databasePath, previousValues, sentinel),
      );
    } finally {
      db.close();
    }
  } catch (error) {
    return outputError(io, "daemon", error);
  }
}

function daemonInspection(
  db: ReturnType<typeof openSparkDaemonDatabasePath>,
  action: "write-read" | "inspect",
  database: string,
  previousValues: string[],
  sentinel?: string,
): SparkDatabaseCompatibilityProbeResult {
  const manifest = loadDaemonMigrationManifest();
  const rows = db
    .prepare(
      "SELECT key, value FROM daemon_meta WHERE key LIKE 'schema.compatibility.%' ORDER BY key",
    )
    .all() as Array<{ key: string; value: string }>;
  const marker = new Map(rows.map(({ key, value }) => [key, value]));
  const state = marker.get("schema.compatibility.state");
  if (
    state !== "legacy-unverified" &&
    state !== "dirty" &&
    state !== "clean" &&
    state !== "failed"
  ) {
    throw new Error("Daemon compatibility ledger state is missing or invalid");
  }
  const priorSentinel = previousValues.filter((value) => value !== "legacy-daemon-schema").at(-1);
  return {
    schemaVersion: 1,
    owner: "daemon",
    action,
    database,
    head: marker.get("schema.compatibility.head") ?? manifest.currentSchemaHead,
    manifestSha256: createHash("sha256").update(readFileSync(resolveManifestPath())).digest("hex"),
    baselineChecksum: manifest.baseline.checksum,
    ledger: [
      {
        id: marker.get("schema.compatibility.baseline") ?? manifest.baseline.id,
        state,
        checksum: marker.get("schema.compatibility.baseline_checksum") ?? null,
      },
    ],
    previousValues,
    ...((sentinel ?? priorSentinel) ? { sentinel: sentinel ?? priorSentinel } : {}),
  };
}

function daemonSentinels(db: ReturnType<typeof openSparkDaemonDatabasePath>): string[] {
  const sentinels = (
    db
      .prepare(
        "SELECT value FROM daemon_meta WHERE key LIKE 'release.compatibility.sentinel.%' ORDER BY key",
      )
      .all() as Array<{ value: string }>
  ).map(({ value }) => value);
  const durableRows = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM daemon_meta").get() as { count: number }).count,
  );
  if (durableRows > 0) sentinels.unshift("legacy-daemon-schema");
  return [...new Set(sentinels)];
}

function resolveManifestPath(): string {
  return process.env.SPARK_DAEMON_MIGRATION_MANIFEST
    ? process.env.SPARK_DAEMON_MIGRATION_MANIFEST
    : process.env.SPARK_PRODUCT_DIST
      ? `${process.env.SPARK_PRODUCT_DIST}/migrations/daemon/manifest.json`
      : new URL("./store/migrations/manifest.json", import.meta.url).pathname;
}

function output(io: CompatDatabaseIo, value: unknown): number {
  io.stdout.write(`${JSON.stringify(value)}\n`);
  return 0;
}

function outputError(io: CompatDatabaseIo, owner: "daemon", error: unknown): number {
  const payload = {
    schemaVersion: 1,
    owner,
    ok: false,
    error: { code: "DATABASE_COMPATIBILITY_PROBE_FAILED", message: errorMessage(error) },
  };
  (io.stderr ?? io.stdout).write(`${JSON.stringify(payload)}\n`);
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
