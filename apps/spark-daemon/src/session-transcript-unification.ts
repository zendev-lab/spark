import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { writeJsonFileAtomic } from "@zendev-lab/spark-core";
import {
  CURRENT_SPARK_SESSION_VERSION,
  SparkSessionStore,
  type SparkSessionEntry,
  type SparkSessionRecord,
} from "@zendev-lab/spark-host/session-store";
import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export interface UnifyDaemonSessionTranscriptsInput {
  registry: Pick<DaemonSessionRegistry, "list" | "relocateTranscriptPath">;
  transcriptSparkHome: string;
  backupRoot: string;
  apply?: boolean;
  createStore?: (cwd: string) => SparkSessionStore;
}

export interface UnifiedDaemonSessionTranscript {
  sessionId: string;
  sourcePaths: string[];
  targetPath: string;
  entryCount: number;
  changed: boolean;
}

export interface UnifyDaemonSessionTranscriptsResult {
  backupRoot: string;
  sessions: UnifiedDaemonSessionTranscript[];
}

interface TranscriptMigrationJournal {
  version: 1;
  phase: "backed_up" | "replaced" | "registry_updated";
  sessionId: string;
  targetPath: string;
  expectedSessionPath?: string;
  sources: Array<{ path: string; backupPath: string }>;
}

interface TranscriptMigrationLockRecord {
  pid: number;
  startedAt: string;
  ownerToken: string;
}

/**
 * Consolidate every ordinary daemon session into its stable workspace path.
 *
 * Applying a change always follows backup -> write/verify -> registry CAS ->
 * source removal. Re-running after success is a no-op.
 */
export async function unifyDaemonSessionTranscripts(
  input: UnifyDaemonSessionTranscriptsInput,
): Promise<UnifyDaemonSessionTranscriptsResult> {
  if (input.apply !== true) return await unifyDaemonSessionTranscriptsUnlocked(input);
  const release = await acquireTranscriptMigrationLock(input.backupRoot);
  try {
    return await unifyDaemonSessionTranscriptsUnlocked(input);
  } finally {
    await release();
  }
}

async function unifyDaemonSessionTranscriptsUnlocked(
  input: UnifyDaemonSessionTranscriptsInput,
): Promise<UnifyDaemonSessionTranscriptsResult> {
  const sessions = await input.registry.list({
    includeArchived: true,
  });
  const createStore =
    input.createStore ??
    ((cwd: string) =>
      new SparkSessionStore({
        cwd,
        sparkHome: input.transcriptSparkHome,
      }));
  if (input.apply === true) {
    await recoverInterruptedTranscriptMigration(input, sessions, createStore);
  }
  const results: UnifiedDaemonSessionTranscript[] = [];
  const sessionsByCwd = new Map<string, SparkSessionState[]>();

  for (const session of sessions) {
    // Closing Sessions are completed by SessionSupervisor. Copying a
    // discard-on-close transcript into the migration backup before that owner
    // runs would turn ephemeral content into a permanent retained artifact.
    if (
      (session.lifecycle !== "open" && session.retention === "discard_on_close") ||
      (session.lineage.kind === "child" && session.lineage.origin.kind === "side_thread") ||
      !session.cwd?.trim()
    ) {
      continue;
    }
    const cwd = resolve(session.cwd);
    const group = sessionsByCwd.get(cwd) ?? [];
    group.push(session);
    sessionsByCwd.set(cwd, group);
  }

  for (const [cwd, group] of sessionsByCwd) {
    const store = createStore(cwd);
    const index = await store.indexSessionPathsById();
    for (const session of group) {
      const result = await unifySessionTranscript(input, store, index, session);
      if (result) results.push(result);
    }
  }

  return { backupRoot: input.backupRoot, sessions: results };
}

async function unifySessionTranscript(
  input: UnifyDaemonSessionTranscriptsInput,
  store: SparkSessionStore,
  index: ReadonlyMap<string, readonly string[]>,
  session: SparkSessionState,
): Promise<UnifiedDaemonSessionTranscript | undefined> {
  const records = await store.loadAllFromIndex(index, session.sessionId);
  if (
    session.sessionPath &&
    !records.some((record) => resolve(record.path) === resolve(session.sessionPath!))
  ) {
    records.push(await store.load(session.sessionPath));
  }
  if (records.length === 0) {
    if (session.sessionPath) {
      throw new Error(`registered transcript is missing for ${session.sessionId}`);
    }
    return undefined;
  }

  const sources = records
    .map((record) => validateSourceRecord(store, session, record))
    .sort(compareTranscriptRecords);
  const targetPath = store.canonicalSessionPath(session.sessionId);
  const sourcePaths = sources.map((record) => resolve(record.path));
  const changed =
    sourcePaths.length !== 1 ||
    sourcePaths[0] !== resolve(targetPath) ||
    resolve(session.sessionPath ?? "") !== resolve(targetPath) ||
    sources.some((record) => record.header.version !== CURRENT_SPARK_SESSION_VERSION);
  const merged = mergeTranscriptRecords(sources, targetPath);
  const result: UnifiedDaemonSessionTranscript = {
    sessionId: session.sessionId,
    sourcePaths,
    targetPath,
    entryCount: merged.entries.length,
    changed,
  };
  if (!changed || input.apply !== true) return result;

  const backupDir = join(input.backupRoot, encodeURIComponent(session.sessionId));
  await mkdir(backupDir, { recursive: true });
  const backups: TranscriptMigrationJournal["sources"] = [];
  for (const sourcePath of sourcePaths) {
    const backupPath = join(backupDir, basename(sourcePath));
    await copyFile(sourcePath, backupPath);
    await syncFile(backupPath);
    backups.push({ path: sourcePath, backupPath });
  }

  const activeJournalPath = join(input.backupRoot, "active.json");
  const journal: TranscriptMigrationJournal = {
    version: 1,
    phase: "backed_up",
    sessionId: session.sessionId,
    targetPath,
    ...(session.sessionPath ? { expectedSessionPath: session.sessionPath } : {}),
    sources: backups,
  };
  await writeJsonFileAtomic(activeJournalPath, journal);

  await store.save(merged);
  const verified = await store.load(targetPath);
  if (
    verified.header.id !== session.sessionId ||
    verified.header.version !== CURRENT_SPARK_SESSION_VERSION ||
    verified.entries.length !== merged.entries.length
  ) {
    throw new Error(`failed to verify unified transcript for ${session.sessionId}`);
  }
  journal.phase = "replaced";
  await writeJsonFileAtomic(activeJournalPath, journal);
  await input.registry.relocateTranscriptPath({
    sessionId: session.sessionId,
    ...(session.sessionPath ? { expectedSessionPath: session.sessionPath } : {}),
    sessionPath: targetPath,
  });
  journal.phase = "registry_updated";
  await writeJsonFileAtomic(activeJournalPath, journal);
  for (const sourcePath of sourcePaths) {
    if (sourcePath !== resolve(targetPath)) await unlink(sourcePath);
  }
  await writeJsonFileAtomic(join(backupDir, "journal.json"), {
    ...journal,
    phase: "complete",
    completedAt: new Date().toISOString(),
  });
  await unlink(activeJournalPath);
  return result;
}

async function recoverInterruptedTranscriptMigration(
  input: UnifyDaemonSessionTranscriptsInput,
  sessions: readonly SparkSessionState[],
  createStore: (cwd: string) => SparkSessionStore,
): Promise<void> {
  const activeJournalPath = join(input.backupRoot, "active.json");
  const journal = await readMigrationJournal(activeJournalPath);
  if (!journal) return;
  const session = sessions.find((candidate) => candidate.sessionId === journal.sessionId);
  if (!session?.cwd) {
    throw new Error(`transcript migration journal references unknown session ${journal.sessionId}`);
  }
  validateJournalPaths(input.backupRoot, journal);
  const store = createStore(resolve(session.cwd));
  validateJournalTranscriptPaths(store, journal);
  let targetIsV4 = false;
  try {
    const target = await store.load(journal.targetPath);
    targetIsV4 =
      target.header.id === journal.sessionId &&
      target.header.version === CURRENT_SPARK_SESSION_VERSION;
  } catch {
    targetIsV4 = false;
  }
  const registryCommitted =
    resolve(session.sessionPath ?? "") === resolve(journal.targetPath) && targetIsV4;
  const inPlaceReplacement =
    journal.sources.some((source) => resolve(source.path) === resolve(journal.targetPath)) &&
    targetIsV4;

  if (journal.phase === "registry_updated" || registryCommitted || inPlaceReplacement) {
    for (const source of journal.sources) {
      if (resolve(source.path) !== resolve(journal.targetPath)) await unlinkIfPresent(source.path);
    }
    await completeRecoveredJournal(input.backupRoot, journal, "completed_after_restart");
    await unlink(activeJournalPath);
    return;
  }

  for (const source of journal.sources) await copyFile(source.backupPath, source.path);
  if (!journal.sources.some((source) => resolve(source.path) === resolve(journal.targetPath))) {
    await unlinkIfPresent(journal.targetPath);
  }
  await completeRecoveredJournal(input.backupRoot, journal, "rolled_back_after_restart");
  await unlink(activeJournalPath);
}

async function readMigrationJournal(path: string): Promise<TranscriptMigrationJournal | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read transcript migration journal ${path}`, { cause: error });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { sessionId?: unknown }).sessionId !== "string" ||
    typeof (value as { targetPath?: unknown }).targetPath !== "string" ||
    !["backed_up", "replaced", "registry_updated"].includes(
      String((value as { phase?: unknown }).phase),
    ) ||
    !Array.isArray((value as { sources?: unknown }).sources)
  ) {
    throw new Error(`invalid transcript migration journal: ${path}`);
  }
  const journal = value as TranscriptMigrationJournal;
  if (
    !journal.sources.every(
      (source) =>
        source && typeof source.path === "string" && typeof source.backupPath === "string",
    )
  ) {
    throw new Error(`invalid transcript migration journal sources: ${path}`);
  }
  return journal;
}

function validateJournalPaths(backupRoot: string, journal: TranscriptMigrationJournal): void {
  const root = resolve(backupRoot);
  for (const source of journal.sources) {
    const backup = resolve(source.backupPath);
    const fromRoot = relative(root, backup);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error(`transcript migration backup is outside its root: ${backup}`);
    }
  }
}

function validateJournalTranscriptPaths(
  store: SparkSessionStore,
  journal: TranscriptMigrationJournal,
): void {
  const sessionDir = resolve(store.sessionDir);
  const paths = [journal.targetPath, ...journal.sources.map((source) => source.path)];
  for (const path of paths) {
    const target = resolve(path);
    const fromStore = relative(sessionDir, target);
    if (
      !fromStore ||
      fromStore === ".." ||
      fromStore.startsWith(`..${sep}`) ||
      fromStore.includes(sep)
    ) {
      throw new Error(
        `transcript migration journal path is outside its workspace store: ${target}`,
      );
    }
  }
  if (resolve(journal.targetPath) !== resolve(store.canonicalSessionPath(journal.sessionId))) {
    throw new Error(
      `transcript migration journal has a non-canonical target for ${journal.sessionId}`,
    );
  }
}

async function completeRecoveredJournal(
  backupRoot: string,
  journal: TranscriptMigrationJournal,
  recovery: "completed_after_restart" | "rolled_back_after_restart",
): Promise<void> {
  const backupDir = join(backupRoot, encodeURIComponent(journal.sessionId));
  await writeJsonFileAtomic(join(backupDir, "journal.json"), {
    ...journal,
    phase: "recovered",
    recovery,
    completedAt: new Date().toISOString(),
  });
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireTranscriptMigrationLock(backupRoot: string): Promise<() => Promise<void>> {
  const lockPath = `${resolve(backupRoot)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const record: TranscriptMigrationLockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ownerToken: randomUUID(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readTranscriptMigrationLock(lockPath);
        if (current?.ownerToken === record.ownerToken) await unlinkIfPresent(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readTranscriptMigrationLock(lockPath);
      if (!current) {
        throw new Error(`invalid transcript migration lock: ${lockPath}`);
      }
      if (isProcessAlive(current.pid)) {
        throw new Error(
          `another transcript migration is active (pid=${current.pid}, startedAt=${current.startedAt})`,
        );
      }
      await unlink(lockPath);
    }
  }
  throw new Error(`failed to acquire transcript migration lock: ${lockPath}`);
}

async function readTranscriptMigrationLock(
  path: string,
): Promise<TranscriptMigrationLockRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { pid?: unknown }).pid !== "number" ||
    typeof (value as { startedAt?: unknown }).startedAt !== "string" ||
    typeof (value as { ownerToken?: unknown }).ownerToken !== "string"
  ) {
    return undefined;
  }
  return value as TranscriptMigrationLockRecord;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validateSourceRecord(
  store: SparkSessionStore,
  session: SparkSessionState,
  record: SparkSessionRecord,
): SparkSessionRecord {
  const path = resolve(record.path);
  const fromStore = relative(store.sessionDir, path);
  if (
    !fromStore ||
    fromStore === ".." ||
    fromStore.startsWith(`..${sep}`) ||
    fromStore.includes(sep)
  ) {
    throw new Error(`transcript for ${session.sessionId} is outside its daemon workspace store`);
  }
  if (record.header.id !== session.sessionId) {
    throw new Error(`transcript ${path} belongs to ${record.header.id}, not ${session.sessionId}`);
  }
  if (resolve(record.header.cwd) !== resolve(session.cwd!)) {
    throw new Error(`transcript ${path} belongs to another workspace`);
  }
  return record;
}

function compareTranscriptRecords(left: SparkSessionRecord, right: SparkSessionRecord): number {
  return (
    left.header.timestamp.localeCompare(right.header.timestamp) ||
    left.path.localeCompare(right.path)
  );
}

function mergeTranscriptRecords(
  records: SparkSessionRecord[],
  targetPath: string,
): SparkSessionRecord {
  const [first, ...rest] = records;
  if (!first) throw new Error("at least one transcript record is required");
  const entries = first.entries.map(cloneEntry);
  const entryIds = new Set(entries.map((entry) => entry.id));
  assertSingleRoot(first);

  for (const record of rest) {
    assertSingleRoot(record);
    const fragment = record.entries.map(cloneEntry);
    for (const entry of fragment) {
      if (entryIds.has(entry.id)) {
        throw new Error(`duplicate transcript entry id ${entry.id} in ${record.path}`);
      }
      entryIds.add(entry.id);
    }
    const root = fragment.find((entry) => entry.parentId === null);
    const previousLeaf = entries.at(-1);
    if (root && previousLeaf) root.parentId = previousLeaf.id;
    entries.push(...fragment);
  }

  return {
    path: targetPath,
    header: { ...first.header },
    entries,
  };
}

function assertSingleRoot(record: SparkSessionRecord): void {
  const roots = record.entries.filter((entry) => entry.parentId === null);
  if (record.entries.length > 0 && roots.length !== 1) {
    throw new Error(`transcript ${record.path} has ${roots.length} roots`);
  }
}

function cloneEntry(entry: SparkSessionEntry): SparkSessionEntry {
  return structuredClone(entry);
}
