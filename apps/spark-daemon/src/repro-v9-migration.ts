import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sessionReproStorePathV2 } from "@zendev-lab/spark-driver";
import type { DaemonSparkReproRuntimeDeps } from "./repro-owner-runtime.ts";
import { createDaemonSparkReproOwner } from "./repro-owner-runtime.ts";
import { getWorkspaceById } from "./store/workspaces.ts";

interface MigrationJournal {
  schema: "spark.repro.v9-v10-migration/v1";
  ownerSessionId: string;
  sourceDigest: string;
  backupPath: string;
  status: "prepared" | "complete";
  migrated: boolean;
}

export async function migrateLegacyReproV9Snapshots(
  input: DaemonSparkReproRuntimeDeps,
): Promise<number> {
  const sessions = await input.sessionRegistry.list({ includeArchived: false });
  let migrated = 0;
  for (const session of sessions) {
    if (session.scope.kind !== "workspace") continue;
    const workspace = getWorkspaceById(input.db, session.scope.workspaceId);
    if (!workspace || workspace.lifecycle) continue;
    const sourcePath = sessionReproStorePathV2(workspace.localPath, {
      sessionId: session.sessionId,
    });
    const journalPath = `${sourcePath}.v10-migration.json`;
    if (await exists(journalPath)) continue;
    if (!(await exists(sourcePath))) continue;
    const raw = await readFile(sourcePath, "utf8");
    const sourceDigest = digest(raw);
    const backupPath = `${sourcePath}.v9-${sourceDigest.slice(0, 16)}.backup.json`;
    const snapshot = parseSnapshot(raw, sourcePath);
    const prepared: MigrationJournal = {
      schema: "spark.repro.v9-v10-migration/v1",
      ownerSessionId: session.sessionId,
      sourceDigest,
      backupPath,
      status: "prepared",
      migrated: false,
    };
    await writeAtomic(journalPath + ".staged", prepared);
    assertJournal(await readFile(journalPath + ".staged", "utf8"), prepared);
    if (!(await exists(backupPath))) {
      await copyFile(sourcePath, backupPath, constants.COPYFILE_EXCL);
    }
    if (digest(await readFile(backupPath, "utf8")) !== sourceDigest) {
      throw new Error(`Repro v9 backup readback failed for ${sourcePath}`);
    }
    let didMigrate = false;
    if (snapshot.repro !== undefined) {
      const result = await createDaemonSparkReproOwner({ ...input, workspace }).migrateV9(
        session.sessionId,
        snapshot.repro,
      );
      didMigrate = result.changed;
    }
    const complete: MigrationJournal = {
      ...prepared,
      status: "complete",
      migrated: snapshot.repro !== undefined,
    };
    await writeAtomic(journalPath, complete);
    assertJournal(await readFile(journalPath, "utf8"), complete);
    await rm(journalPath + ".staged", { force: true });
    migrated += didMigrate ? 1 : 0;
  }
  return migrated;
}

function parseSnapshot(raw: string, path: string): { version: 8; repro?: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Stored Repro snapshot is invalid and was preserved at ${path}`, {
      cause: error,
    });
  }
  if (!isRecord(value) || value.version !== 8) {
    throw new Error(
      `Stored Repro snapshot at ${path} predates outer v8; upgrade through Spark 0.4.0 before starting this daemon`,
    );
  }
  if (value.repro !== undefined && (!isRecord(value.repro) || value.repro.version !== 9)) {
    throw new Error(
      `Stored Repro snapshot at ${path} is not inner v9; upgrade through Spark 0.4.0 before starting this daemon`,
    );
  }
  return { version: 8, ...(value.repro === undefined ? {} : { repro: value.repro }) };
}

async function writeAtomic(path: string, value: MigrationJournal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

function assertJournal(raw: string, expected: MigrationJournal): void {
  const actual = JSON.parse(raw) as unknown;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Repro migration journal readback failed for ${expected.ownerSessionId}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function digest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
