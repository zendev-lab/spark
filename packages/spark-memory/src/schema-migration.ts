import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { writeTextFileAtomic } from "@zendev-lab/spark-core";

import type { RecallScope } from "./recall-store.ts";
import { normalizeRecallStoreSnapshot } from "./recall-store.ts";
import { normalizeLearningRecordForMigration, type LearningLocation } from "./learning-store.ts";

export const MEMORY_SCHEMA_MIGRATION_VERSION = 1 as const;
const INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;
const BODY_PREVIEW_CHARS = 4_000;

export interface MemorySchemaMigrationFile {
  kind: "entry" | "recall" | "learning-metadata" | "learning-blob";
  path: string;
  sourceHash: string | null;
  targetHash: string;
  targetContent: string;
  targetExistsHash: string | null;
}

export interface MemorySchemaMigrationStoreSummary {
  records: number;
  statuses: Record<string, number>;
  evidenceRefs: string[];
  contentDigests: string[];
}

export interface MemorySchemaMigrationSummary {
  entry: MemorySchemaMigrationStoreSummary;
  recall: MemorySchemaMigrationStoreSummary;
  learning: MemorySchemaMigrationStoreSummary;
}

export interface MemorySchemaMigrationPlan {
  schemaVersion: number;
  generatedAt: string;
  rootDir: string;
  files: MemorySchemaMigrationFile[];
  summary: MemorySchemaMigrationSummary;
  digest: string;
}

export interface MemorySchemaMigrationOptions {
  rootDir: string;
  entryPath?: string;
  entryScope?: "user" | "workspace" | "repo";
  recallPath?: string;
  recallScope?: RecallScope;
  learningRoot?: string;
  learningLocation?: LearningLocation;
  now?: () => string;
}

export interface MemorySchemaMigrationApplyResult {
  digest: string;
  backupDir: string;
  appliedFiles: number;
}

interface BackupRecord {
  path: string;
  existed: boolean;
  content?: string;
  sourceHash: string | null;
}

interface BackupManifest {
  schema: "spark.memory.schema-migration-backup/v1";
  planDigest: string;
  createdAt: string;
  records: BackupRecord[];
}

export async function createMemorySchemaMigrationPlan(
  options: MemorySchemaMigrationOptions,
): Promise<MemorySchemaMigrationPlan> {
  const { normalizeSparkMemorySnapshot } = await import("./index.ts");
  const rootDir = resolve(options.rootDir);
  const now = options.now ?? (() => new Date().toISOString());
  const files: MemorySchemaMigrationFile[] = [];
  const summary = emptyMigrationSummary();

  if (options.entryPath !== undefined) {
    const path = resolveMigrationPath(rootDir, options.entryPath, "entryPath");
    const raw = await readJsonRequired(path, "entryPath");
    if (raw !== undefined) {
      const normalized = normalizeSparkMemorySnapshot(raw, path);
      for (const entry of normalized.entries) {
        addSummaryRecord(
          summary.entry,
          entry.status,
          entry.evidenceRefs,
          entry.lifecycle.revision.contentDigest,
        );
      }
      files.push(await targetFile("entry", path, `${JSON.stringify(normalized, null, 2)}\n`));
    }
  }
  if (options.recallPath !== undefined) {
    const path = resolveMigrationPath(rootDir, options.recallPath, "recallPath");
    const raw = await readJsonRequired(path, "recallPath");
    if (raw !== undefined) {
      const normalized = normalizeRecallStoreSnapshot(raw, path);
      for (const candidate of normalized.candidates) {
        addSummaryRecord(
          summary.recall,
          candidate.status,
          candidate.evidenceRefs,
          candidate.lifecycle.revision.contentDigest,
        );
      }
      files.push(await targetFile("recall", path, `${JSON.stringify(normalized, null, 2)}\n`));
    }
  }
  if (options.learningRoot !== undefined) {
    const location = options.learningLocation ?? "workspace";
    const learningRoot = resolveMigrationPath(rootDir, options.learningRoot, "learningRoot");
    if (!(await pathExists(learningRoot))) {
      throw new Error(
        `selected memory migration source does not exist: learningRoot ${learningRoot}`,
      );
    }
    const learningFiles = await listJsonFiles(learningRoot);
    for (const metadataPath of learningFiles) {
      const raw = await readJsonRequired(metadataPath, "learning metadata");
      if (!isRecord(raw) || raw.kind !== "knowledge") continue;
      const record = normalizeLearningRecordForMigration(
        await readLearningBody(raw, learningRoot, metadataPath),
        location,
      );
      const serializedBody = JSON.stringify(record, null, 2);
      addSummaryRecord(
        summary.learning,
        record.status,
        record.evidenceRefs,
        record.lifecycle.revision.contentDigest,
      );
      const metadata = createLearningMetadata(raw, record, serializedBody);
      files.push(await targetFile("learning-metadata", metadataPath, metadata.metadataContent));
      files.push(
        await targetFile("learning-blob", join(learningRoot, metadata.blobPath), serializedBody),
      );
    }
  }

  const plannedFiles = dedupeMigrationFiles(files);
  plannedFiles.sort((left, right) => compareCodePoints(left.path, right.path));
  const normalizedSummary = normalizeMigrationSummary(summary);
  const digest = sha256(
    stableJson({
      schemaVersion: MEMORY_SCHEMA_MIGRATION_VERSION,
      rootDir,
      files: plannedFiles.map(({ targetContent: _targetContent, ...file }) => file),
      summary: normalizedSummary,
    }),
  );
  return {
    schemaVersion: MEMORY_SCHEMA_MIGRATION_VERSION,
    generatedAt: now(),
    rootDir,
    files: plannedFiles,
    summary: normalizedSummary,
    digest,
  };
}

export async function applyMemorySchemaMigration(
  plan: MemorySchemaMigrationPlan,
  backupDir: string,
): Promise<MemorySchemaMigrationApplyResult> {
  assertPlan(plan);
  const targetBackupDir = resolve(backupDir);
  await mkdir(targetBackupDir, { recursive: true });
  const records: BackupRecord[] = [];
  for (const file of plan.files) {
    assertMigrationPath(plan.rootDir, file.path, "plan file");
    const current = await readFileIfPresent(file.path);
    if (sha256(file.targetContent) !== file.targetHash) {
      throw new Error(`memory migration plan target digest mismatch: ${file.path}`);
    }
    if (
      file.sourceHash === null
        ? current !== undefined
        : !current || sha256(current) !== file.sourceHash
    ) {
      throw new Error(`memory migration source changed before apply: ${file.path}`);
    }
    const targetExistsHash = current ? sha256(current) : null;
    if (targetExistsHash !== file.targetExistsHash) {
      throw new Error(`memory migration target changed before apply: ${file.path}`);
    }
    records.push({
      path: file.path,
      existed: current !== undefined,
      ...(current === undefined ? {} : { content: current }),
      sourceHash: current === undefined ? null : file.sourceHash,
    });
  }
  const manifest: BackupManifest = {
    schema: "spark.memory.schema-migration-backup/v1",
    planDigest: plan.digest,
    createdAt: new Date().toISOString(),
    records,
  };
  await writeTextFileAtomic(
    join(targetBackupDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  try {
    for (const file of plan.files) {
      await writeTextFileAtomic(file.path, file.targetContent);
      const actual = await readFile(file.path, "utf8");
      if (sha256(actual) !== file.targetHash) {
        throw new Error(`memory migration target verification failed: ${file.path}`);
      }
    }
  } catch (error) {
    await restoreBackupRecords(records);
    throw error;
  }
  return { digest: plan.digest, backupDir: targetBackupDir, appliedFiles: plan.files.length };
}

export async function rollbackMemorySchemaMigration(backupDir: string): Promise<number> {
  const manifestPath = join(resolve(backupDir), "manifest.json");
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BackupManifest;
  } catch (error) {
    throw new Error(
      `invalid memory migration backup JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.schema !== "spark.memory.schema-migration-backup/v1") {
    throw new Error(`invalid memory migration backup: ${manifestPath}`);
  }
  await restoreBackupRecords(manifest.records);
  return manifest.records.length;
}

async function restoreBackupRecords(records: readonly BackupRecord[]): Promise<void> {
  for (const record of records) {
    if (!record.existed) {
      await rm(record.path, { force: true });
      continue;
    }
    if (record.content === undefined || record.sourceHash === null) {
      throw new Error(`memory migration backup is missing content: ${record.path}`);
    }
    await writeTextFileAtomic(record.path, record.content);
    const actual = await readFile(record.path, "utf8");
    if (sha256(actual) !== record.sourceHash) {
      throw new Error(`memory migration rollback verification failed: ${record.path}`);
    }
  }
}

function createLearningMetadata(
  raw: Record<string, unknown>,
  record: unknown,
  serializedBody: string,
): { metadataContent: string; blobPath: string } {
  const hash = sha256(serializedBody);
  const blobPath = `blobs/${hash}.json`;
  const metadataBody =
    Buffer.byteLength(serializedBody, "utf8") <= INLINE_BODY_THRESHOLD_BYTES
      ? record
      : previewBody(serializedBody);
  const metadata: Record<string, unknown> = {
    ...raw,
    body: metadataBody,
    hash,
    blobPath,
  };
  if (metadataBody !== record) {
    metadata.bodyPreview = previewBody(serializedBody);
    metadata.bodySize = Buffer.byteLength(serializedBody, "utf8");
    metadata.bodyTruncated = true;
  } else {
    delete metadata.bodyPreview;
    delete metadata.bodySize;
    delete metadata.bodyTruncated;
  }
  return { metadataContent: `${JSON.stringify(metadata, null, 2)}\n`, blobPath };
}

function previewBody(serializedBody: string): string {
  return serializedBody.length > BODY_PREVIEW_CHARS
    ? `${serializedBody.slice(0, BODY_PREVIEW_CHARS)}\n… truncated ${serializedBody.length - BODY_PREVIEW_CHARS} char(s)`
    : serializedBody;
}
async function readLearningBody(
  metadata: Record<string, unknown>,
  learningRoot: string,
  metadataPath: string,
): Promise<unknown> {
  if (!metadata.bodyTruncated) return metadata.body;
  if (typeof metadata.blobPath !== "string") {
    throw new Error(`learning metadata has no blob path: ${metadataPath}`);
  }
  const blobPath = resolveContainedPath(learningRoot, metadata.blobPath);
  if (!blobPath) throw new Error(`learning metadata blob path escapes store: ${metadataPath}`);
  const serialized = await readFile(blobPath, "utf8");
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `invalid learning blob JSON ${blobPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function targetFile(
  kind: MemorySchemaMigrationFile["kind"],
  path: string,
  targetContent: string,
): Promise<MemorySchemaMigrationFile> {
  const source = await readFileIfPresent(path);
  return {
    kind,
    path,
    sourceHash: source === undefined ? null : sha256(source),
    targetHash: sha256(targetContent),
    targetContent,
    targetExistsHash: source === undefined ? null : sha256(source),
  };
}

function assertPlan(plan: MemorySchemaMigrationPlan): void {
  if (plan.schemaVersion !== MEMORY_SCHEMA_MIGRATION_VERSION) {
    throw new Error(`memory migration plan schema must be ${MEMORY_SCHEMA_MIGRATION_VERSION}`);
  }
  if (!isAbsolute(plan.rootDir)) {
    throw new Error("memory migration plan rootDir must be absolute");
  }
  for (const file of plan.files) {
    assertMigrationPath(plan.rootDir, file.path, "plan file");
    if (sha256(file.targetContent) !== file.targetHash) {
      throw new Error(`memory migration plan target digest mismatch: ${file.path}`);
    }
  }
  const expected = sha256(
    stableJson({
      schemaVersion: plan.schemaVersion,
      rootDir: plan.rootDir,
      files: plan.files.map(({ targetContent: _targetContent, ...file }) => file),
      summary: plan.summary,
    }),
  );
  if (expected !== plan.digest) {
    throw new Error(
      `memory migration plan digest mismatch: expected ${expected}, received ${plan.digest}`,
    );
  }
}

async function readJsonRequired(path: string, label: string): Promise<unknown> {
  const content = await readFileIfPresent(path);
  if (content === undefined) {
    throw new Error(`selected memory migration source does not exist: ${label} ${path}`);
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `invalid memory migration source JSON ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function listJsonFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(rootDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    if (entry.isDirectory() && entry.name !== "blobs") files.push(...(await listJsonFiles(path)));
  }
  return files;
}

function resolveContainedPath(rootDir: string, relativePath: string): string | undefined {
  const root = resolve(rootDir);
  const path = resolve(root, relativePath);
  return path === root || path.startsWith(`${root}/`) ? path : undefined;
}

function dedupeMigrationFiles(
  files: readonly MemorySchemaMigrationFile[],
): MemorySchemaMigrationFile[] {
  const byPath = new Map<string, MemorySchemaMigrationFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing) {
      if (
        existing.sourceHash !== file.sourceHash ||
        existing.targetHash !== file.targetHash ||
        existing.targetContent !== file.targetContent
      ) {
        throw new Error(`memory migration has conflicting operations for ${file.path}`);
      }
      continue;
    }
    byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

function assertMigrationPath(rootDir: string, path: string, label: string): void {
  const root = resolve(rootDir);
  const resolvedPath = resolve(path);
  if (resolvedPath === root || !resolvedPath.startsWith(`${root}/`)) {
    throw new Error(`memory migration ${label} must remain under rootDir: ${path}`);
  }
}

function emptyMigrationSummary(): MemorySchemaMigrationSummary {
  return {
    entry: emptyStoreSummary(),
    recall: emptyStoreSummary(),
    learning: emptyStoreSummary(),
  };
}

function emptyStoreSummary(): MemorySchemaMigrationStoreSummary {
  return { records: 0, statuses: {}, evidenceRefs: [], contentDigests: [] };
}

function addSummaryRecord(
  summary: MemorySchemaMigrationStoreSummary,
  status: string,
  evidenceRefs: readonly string[],
  contentDigest: string,
): void {
  summary.records += 1;
  summary.statuses[status] = (summary.statuses[status] ?? 0) + 1;
  summary.evidenceRefs.push(...evidenceRefs);
  summary.contentDigests.push(contentDigest);
}

function normalizeMigrationSummary(
  summary: MemorySchemaMigrationSummary,
): MemorySchemaMigrationSummary {
  return {
    entry: normalizeStoreSummary(summary.entry),
    recall: normalizeStoreSummary(summary.recall),
    learning: normalizeStoreSummary(summary.learning),
  };
}

function normalizeStoreSummary(
  summary: MemorySchemaMigrationStoreSummary,
): MemorySchemaMigrationStoreSummary {
  return {
    records: summary.records,
    statuses: Object.fromEntries(
      Object.entries(summary.statuses).sort(([left], [right]) => compareCodePoints(left, right)),
    ),
    evidenceRefs: [...new Set(summary.evidenceRefs)].sort(),
    contentDigests: [...new Set(summary.contentDigests)].sort(),
  };
}

function resolveMigrationPath(
  rootDir: string,
  candidate: string | undefined,
  label: string,
): string {
  if (!candidate)
    throw new Error(`memory migration ${label} is required when its store is selected`);
  if (isAbsolute(candidate)) {
    const path = resolve(candidate);
    if (path !== rootDir && !path.startsWith(`${rootDir}/`)) {
      throw new Error(`memory migration ${label} must remain under rootDir: ${path}`);
    }
    return path;
  }
  const path = resolve(rootDir, candidate);
  if (path !== rootDir && !path.startsWith(`${rootDir}/`)) {
    throw new Error(`memory migration ${label} must remain under rootDir: ${path}`);
  }
  return path;
}
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}
