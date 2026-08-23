import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "vitest";

import {
  acquireHubDatabaseLock,
  ensureHubInstanceId,
  migrate,
  openDatabase,
  type HubSnapshotManifest,
} from "@zendev-lab/spark-hub-storage-sqlite";

import {
  handleSparkHubCliCommand,
  parseSparkHubCliArgs,
  runSparkHubCliCommand,
} from "../../cli/coordination.ts";

const now = "2026-07-15T06:15:00.000Z";
const sourceInstanceId = "hub_11111111111111111111111111111111";
const targetInstanceId = "hub_22222222222222222222222222222222";
const secretMarker = "instance-cli-secret-marker";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("Hub parser routes the four instance operations through its owned CLI", () => {
  assert.deepEqual(parseSparkHubCliArgs(["instance", "status", "--json"]), {
    resource: "instance",
    verb: "status",
    json: true,
    snapshotPath: undefined,
    databasePath: undefined,
    rollbackRoot: undefined,
    yes: false,
  });
  assert.deepEqual(
    parseSparkHubCliArgs([
      "instance",
      "restore",
      "/tmp/source.snapshot",
      "--database",
      "/tmp/target.sqlite",
      "--rollback-root",
      "/tmp/rollback",
      "--yes",
      "--json",
    ]),
    {
      resource: "instance",
      verb: "restore",
      json: true,
      snapshotPath: "/tmp/source.snapshot",
      databasePath: "/tmp/target.sqlite",
      rollbackRoot: "/tmp/rollback",
      yes: true,
    },
  );
});

it("status, backup, inspect, and restore emit stable secret-free results without HTTP", async () => {
  const root = createRoot();
  const sourcePath = join(root, "source.sqlite");
  const targetPath = join(root, "target.sqlite");
  const snapshotPath = join(root, "source.snapshot");
  seedDatabase(sourcePath, sourceInstanceId, "ws_source");
  seedDatabase(targetPath, targetInstanceId, "ws_target");
  const activeServers = () =>
    (process as NodeJS.Process & { _getActiveHandles(): unknown[] })
      ._getActiveHandles()
      .filter((handle: unknown): handle is Server => handle instanceof Server).length;
  const listenersBefore = activeServers();

  const status = await handleSparkHubCliCommand({
    resource: "instance",
    verb: "status",
    json: true,
    databasePath: sourcePath,
  });
  assert.equal(status.action, "instance");
  assert.equal(status.result.operation, "status");
  assert.equal(status.result.status, "ready");
  assert.equal(status.result.instanceId, sourceInstanceId);
  assert.equal(status.result.lock.present, false);

  const backup = await runJsonCommand(
    {
      resource: "instance",
      verb: "backup",
      json: true,
      snapshotPath,
      databasePath: sourcePath,
    },
    { instance: { now } },
  );
  assert.equal(backup.code, 0);
  assert.equal(backup.stderr, "");
  assert.equal(backup.json.action, "instance");
  assert.equal(backup.json.result.operation, "backup");
  assert.equal(backup.json.result.status, "created");
  assert.equal(backup.json.result.instanceId, sourceInstanceId);
  assert.equal(existsSync(join(snapshotPath, "manifest.json")), true);

  const inspect = await runJsonCommand({
    resource: "instance",
    verb: "inspect",
    json: true,
    snapshotPath,
  });
  assert.equal(inspect.code, 0);
  assert.equal(inspect.json.result.operation, "inspect");
  assert.equal(inspect.json.result.status, "valid");
  assert.equal(inspect.json.result.integrityCheck, "ok");
  assert.equal(inspect.json.result.foreignKeyViolations, 0);

  const restore = await runJsonCommand(
    {
      resource: "instance",
      verb: "restore",
      json: true,
      snapshotPath,
      databasePath: targetPath,
      rollbackRoot: join(root, "rollback"),
      yes: true,
    },
    { instance: { now } },
  );
  assert.equal(restore.code, 0);
  assert.equal(restore.stderr, "");
  assert.equal(restore.json.result.operation, "restore");
  assert.equal(restore.json.result.status, "restored");
  assert.equal(restore.json.result.instanceId, sourceInstanceId);
  assert.equal(typeof restore.json.result.rollbackSnapshotPath, "string");
  assert.equal(readInstanceId(targetPath), sourceInstanceId);
  assert.deepEqual(readWorkspaceIds(targetPath), ["ws_source"]);

  const combined = `${backup.stdout}${inspect.stdout}${restore.stdout}`;
  assert.doesNotMatch(combined, new RegExp(secretMarker, "u"));
  assert.doesNotMatch(combined, /sha256:browser|sha256:runtime|ownerToken|SPARK_HUB_REMOTE_TOKEN/u);
  assert.equal(activeServers(), listenersBefore);
});

it("restore without --yes fails before inspection and leaves the target unchanged", async () => {
  const root = createRoot();
  const targetPath = join(root, "target.sqlite");
  seedDatabase(targetPath, targetInstanceId, "ws_target");
  const before = sha256(targetPath);
  const result = await runJsonCommand(
    {
      resource: "instance",
      verb: "restore",
      json: true,
      snapshotPath: join(root, "missing.snapshot"),
      databasePath: targetPath,
    },
    { instance: { isInteractive: false } },
  );

  assert.equal(result.code, 4);
  assert.equal(result.stdout, "");
  assert.equal(result.json.action, "error");
  assert.equal(result.json.error.code, "HUB_RESTORE_CONFIRMATION_REQUIRED");
  assert.equal(sha256(targetPath), before);
  assert.equal(existsSync(join(root, "missing.snapshot")), false);
});

it("restore distinguishes lock, manifest, digest, and schema failures without mutation", async () => {
  const root = createRoot();
  const sourcePath = join(root, "source.sqlite");
  const targetPath = join(root, "target.sqlite");
  const snapshotPath = join(root, "source.snapshot");
  seedDatabase(sourcePath, sourceInstanceId, "ws_source");
  seedDatabase(targetPath, targetInstanceId, "ws_target");
  const backup = await runJsonCommand(
    {
      resource: "instance",
      verb: "backup",
      json: true,
      snapshotPath,
      databasePath: sourcePath,
    },
    { instance: { now } },
  );
  assert.equal(backup.code, 0);
  const before = sha256(targetPath);

  const lock = acquireHubDatabaseLock(targetPath);
  try {
    const locked = await runJsonCommand({
      resource: "instance",
      verb: "restore",
      json: true,
      snapshotPath,
      databasePath: targetPath,
      yes: true,
    });
    assert.equal(locked.code, 5);
    assert.equal(locked.json.error.code, "HUB_INSTANCE_LOCKED");
    assert.doesNotMatch(locked.stderr, /ownerToken/u);
    assert.equal(sha256(targetPath), before);
  } finally {
    lock.release();
  }

  const invalidManifestPath = join(root, "invalid-manifest.snapshot");
  copySnapshot(snapshotPath, invalidManifestPath);
  writeFileSync(join(invalidManifestPath, "manifest.json"), "not-json\n", "utf8");
  const manifest = await restoreFailure(invalidManifestPath, targetPath);
  assert.equal(manifest.code, 6);
  assert.equal(manifest.json.error.code, "HUB_SNAPSHOT_MANIFEST_INVALID");
  assert.equal(sha256(targetPath), before);

  const digestPath = join(root, "digest.snapshot");
  copySnapshot(snapshotPath, digestPath);
  const digestManifest = readManifest(digestPath);
  digestManifest.database.sha256 = "0".repeat(64);
  writeManifest(digestPath, digestManifest);
  const digest = await restoreFailure(digestPath, targetPath);
  assert.equal(digest.code, 6);
  assert.equal(digest.json.error.code, "HUB_SNAPSHOT_DIGEST_MISMATCH");
  assert.equal(sha256(targetPath), before);

  const futurePath = join(root, "future.snapshot");
  copySnapshot(snapshotPath, futurePath);
  const futureDbPath = join(futurePath, "hub.sqlite");
  const futureDb = new DatabaseSync(futureDbPath);
  futureDb
    .prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES ('9999', 'future', ?)",
    )
    .run(now);
  futureDb.close();
  refreshManifestDigest(futurePath);
  const schema = await restoreFailure(futurePath, targetPath);
  assert.equal(schema.code, 6);
  assert.equal(schema.json.error.code, "HUB_SNAPSHOT_SCHEMA_INCOMPATIBLE");
  assert.equal(sha256(targetPath), before);
});

async function restoreFailure(snapshotPath: string, databasePath: string) {
  return await runJsonCommand({
    resource: "instance",
    verb: "restore",
    json: true,
    snapshotPath,
    databasePath,
    yes: true,
  });
}

interface CliJsonEnvelope {
  action: string;
  result: {
    operation?: string;
    status?: string;
    instanceId?: string;
    integrityCheck?: string;
    foreignKeyViolations?: number;
    rollbackSnapshotPath?: unknown;
  };
  error: { code: string };
}

async function runJsonCommand(
  command: Parameters<typeof runSparkHubCliCommand>[0],
  options: Parameters<typeof runSparkHubCliCommand>[2] = {},
): Promise<{ code: number; stdout: string; stderr: string; json: CliJsonEnvelope }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runSparkHubCliCommand(
    command,
    { write: (text) => stdout.push(text) },
    options,
    { write: (text) => stderr.push(text) },
  );
  const stdoutText = stdout.join("");
  const stderrText = stderr.join("");
  return {
    code,
    stdout: stdoutText,
    stderr: stderrText,
    json: JSON.parse((code === 0 ? stdoutText : stderrText) || "null") as CliJsonEnvelope,
  };
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "spark-hub-instance-cli-"));
  roots.push(root);
  return root;
}

function seedDatabase(path: string, instanceId: string, workspaceId: string): void {
  const db = openDatabase({ path });
  migrate(db);
  ensureHubInstanceId(db, { instanceId, now });
  db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)").run(
    "fixture.secret",
    JSON.stringify({ apiKey: secretMarker }),
    now,
  );
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', '{}', ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, now, now);
  db.close();
}

function readInstanceId(path: string): string | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = ?")
      .get("spark_hub:instance_id") as { valueJson: string } | undefined;
    return row ? (JSON.parse(row.valueJson) as string) : null;
  } finally {
    db.close();
  }
}

function readWorkspaceIds(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM workspaces ORDER BY id").all() as Array<{ id: string }>).map(
      ({ id }) => id,
    );
  } finally {
    db.close();
  }
}

function copySnapshot(source: string, target: string): void {
  const manifest = readFileSync(join(source, "manifest.json"));
  const database = readFileSync(join(source, "hub.sqlite"));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "hub.sqlite"), database);
  writeFileSync(join(target, "manifest.json"), manifest);
}

function readManifest(snapshotPath: string): HubSnapshotManifest {
  return JSON.parse(
    readFileSync(join(snapshotPath, "manifest.json"), "utf8"),
  ) as HubSnapshotManifest;
}

function writeManifest(snapshotPath: string, manifest: HubSnapshotManifest): void {
  writeFileSync(
    join(snapshotPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function refreshManifestDigest(snapshotPath: string): void {
  const manifest = readManifest(snapshotPath);
  const databasePath = join(snapshotPath, "hub.sqlite");
  manifest.database.sha256 = sha256(databasePath);
  manifest.database.sizeBytes = statSync(databasePath).size;
  writeManifest(snapshotPath, manifest);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
