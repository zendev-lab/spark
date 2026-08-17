import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { daemonMigrations, runDaemonMigrations } from "./registry.js";

describe("daemon migration registry", () => {
  it("keeps a unique static order with explicit owner attribution", () => {
    expect(daemonMigrations.length).toBeGreaterThan(1);
    expect(new Set(daemonMigrations.map((migration) => migration.id)).size).toBe(
      daemonMigrations.length,
    );
    expect(daemonMigrations.every((migration) => migration.owner.length > 0)).toBe(true);
    expect(daemonMigrations.map((migration) => migration.id)).toEqual(
      expect.arrayContaining([
        "execution-attempts.schema",
        "human-waits.answer-event-mailbox",
        "invocations.workspace-projection-index",
        "migration.driver-to-loop-v1",
        "migration.retire-daemon-error-outbox-v1",
        "repro.formal-evidence-receipts",
      ]),
    );
  });

  it("upgrades the human mailbox idempotently under its owner", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE daemon_human_waits (
          human_request_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          request_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const mailbox = daemonMigrations.filter((migration) => migration.owner === "human-waits");
      runDaemonMigrations(db, mailbox);
      runDaemonMigrations(db, mailbox);

      const columns = db
        .prepare("PRAGMA table_info(daemon_human_waits)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "accepted_response_id",
          "interaction_request_id",
          "evidence_request_json",
        ]),
      );
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daemon_human_answer_events'",
          )
          .get(),
      ).toEqual({ name: "daemon_human_answer_events" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'daemon_human_waits_evidence_interaction_idx'",
          )
          .get(),
      ).toEqual({ name: "daemon_human_waits_evidence_interaction_idx" });
    } finally {
      db.close();
    }
  });

  it("upgrades legacy invocations for supervised session lifecycle retention", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE invocations (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO invocations (id, status, created_at, updated_at)
        VALUES ('inv_legacy', 'queued', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
      `);

      runDaemonMigrations(db);
      runDaemonMigrations(db);

      const columns = db
        .prepare("PRAGMA table_info(invocations)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "claim_class",
          "execution_profile_json",
          "retention_summary_json",
          "payload_redacted_at",
          "workspace_binding_id",
        ]),
      );
      expect(
        db
          .prepare("SELECT claim_class AS claimClass FROM invocations WHERE id = ?")
          .get("inv_legacy"),
      ).toEqual({ claimClass: "root" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'invocations_claim_class_status_idx'",
          )
          .get(),
      ).toEqual({ name: "invocations_claim_class_status_idx" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'invocations_workspace_updated_idx'",
          )
          .get(),
      ).toEqual({ name: "invocations_workspace_updated_idx" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'invocations_legacy_workspace_delivery_idx'",
          )
          .get(),
      ).toEqual({ name: "invocations_legacy_workspace_delivery_idx" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'invocation_events_delivery_head_idx'",
          )
          .get(),
      ).toEqual({ name: "invocation_events_delivery_head_idx" });
    } finally {
      db.close();
    }
  });

  it("runs migrations sequentially and rejects duplicate ids before any write", () => {
    const db = new DatabaseSync(":memory:");
    const calls: string[] = [];
    try {
      expect(() =>
        runDaemonMigrations(db, [
          { id: "one", owner: "test", up: () => calls.push("one") },
          { id: "two", owner: "test", up: () => calls.push("two") },
          { id: "one", owner: "test", up: vi.fn() },
        ]),
      ).toThrow("Duplicate daemon migration id: one");
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("loads every migration through static imports", () => {
    expect(daemonMigrations[0]?.id).toBe("schema.current-foundation");
    expect(daemonMigrations.at(-1)?.id).toBe("workspaces.daemon-registration-backfill");
    expect(daemonMigrations.every((migration) => typeof migration.up === "function")).toBe(true);
  });

  it("bundles the complete registry into the packaged daemon graph", async () => {
    const daemonRoot = resolve(import.meta.dirname, "../../..");
    const outputDirectory = await mkdtemp(join(daemonRoot, ".migration-bundle-"));
    const outputPath = join(outputDirectory, "schema.mjs");
    try {
      await build({
        absWorkingDir: daemonRoot,
        bundle: true,
        entryPoints: ["src/store/schema.ts"],
        format: "esm",
        outfile: outputPath,
        packages: "external",
        platform: "node",
        target: "node26",
      });
      await mkdir(join(outputDirectory, "migrations"), { recursive: true });
      await cp(
        join(daemonRoot, "src/store/migrations/manifest.json"),
        join(outputDirectory, "migrations/manifest.json"),
      );
      await cp(
        join(daemonRoot, "src/store/migrations/legacy-inline-v0.schema.json"),
        join(outputDirectory, "migrations/legacy-inline-v0.schema.json"),
      );
      const previousManifest = process.env.SPARK_DAEMON_MIGRATION_MANIFEST;
      process.env.SPARK_DAEMON_MIGRATION_MANIFEST = join(
        outputDirectory,
        "migrations/manifest.json",
      );
      const packaged = (await import(`${pathToFileURL(outputPath).href}?test=${Date.now()}`)) as {
        migrateSparkDaemonDatabase(db: DatabaseSync): void;
      };
      const db = new DatabaseSync(":memory:");
      try {
        packaged.migrateSparkDaemonDatabase(db);
        expect(
          db
            .prepare(
              "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'invocations'",
            )
            .get(),
        ).toEqual({ present: 1 });
        expect(
          db
            .prepare(
              "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'daemon_repro_formal_evidence_receipts'",
            )
            .get(),
        ).toEqual({ present: 1 });
        expect(
          db
            .prepare(
              "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'execution_attempts'",
            )
            .get(),
        ).toEqual({ present: 1 });
      } finally {
        db.close();
        if (previousManifest === undefined) delete process.env.SPARK_DAEMON_MIGRATION_MANIFEST;
        else process.env.SPARK_DAEMON_MIGRATION_MANIFEST = previousManifest;
      }
    } finally {
      await rm(outputDirectory, { recursive: true });
    }
  });
});
