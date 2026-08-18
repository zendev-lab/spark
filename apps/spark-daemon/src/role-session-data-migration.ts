import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  contentHash,
  nowIso,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "@zendev-lab/spark-core";

import { errorMessage } from "./cli-shared.ts";
import { isRecord } from "./local-rpc/is-record.ts";

const LEGACY_ROLE_REFS = new Map([
  ["role:builtin-scout", "role:builtin-explorer"],
  ["role:builtin-researcher", "role:builtin-explorer"],
  ["role:builtin-worker", "role:builtin-executor"],
]);

const LEGACY_ROLE_SELECTORS = new Map([
  ["scout", "explorer"],
  ["researcher", "explorer"],
  ["worker", "executor"],
  ["builtin-scout", "builtin-explorer"],
  ["builtin-researcher", "builtin-explorer"],
  ["builtin-worker", "builtin-executor"],
  ...LEGACY_ROLE_REFS,
]);

const WORKSPACE_JSON_FILES = [
  ".spark/role-model-settings.json",
  ".spark/workflow-runs.json",
  ".spark/dynamic-workflow-runs.json",
  ".spark/tasks.json",
  ".spark/workflows.json",
  ".spark/repro.json",
] as const;

const WORKSPACE_JSON_TREES = [".spark/projects", ".spark/dynamic-workflows"] as const;

export interface RoleSessionDataMigrationWorkspace {
  workspaceId: string;
  rootDir: string;
}

export interface RoleSessionDataMigrationResult {
  changed: boolean;
  migratedAt?: string;
  backupDir?: string;
  files: number;
  evidenceRefs: string[];
}

interface FileMutation {
  targetPath: string;
  original?: string;
  next: string;
  kind: "json" | "jsonl" | "evidence_metadata" | "evidence_blob";
  evidenceRef?: string;
}

interface MigrationJournalEntry {
  targetPath: string;
  backupPath?: string;
  stagedPath: string;
  originalHash?: string;
  nextHash: string;
  kind: FileMutation["kind"];
  evidenceRef?: string;
}

interface MigrationJournal {
  version: 1;
  migration: "role-session-v6";
  status: "staged" | "switching" | "complete" | "rolled_back" | "recovery_required";
  startedAt: string;
  migratedAt?: string;
  backupDir: string;
  restoreCommand: string;
  entries: MigrationJournalEntry[];
}

/**
 * Hard-cut persisted structured RoleRefs before the daemon starts serving.
 * Only schema-known JSON fields are rewritten. Markdown, scripts, transcripts,
 * prompts, and arbitrary string values are deliberately left untouched.
 */
export async function migrateRoleSessionStructuredData(input: {
  sparkHome: string;
  userRoleModelSettingsFile: string;
  workspaces: readonly RoleSessionDataMigrationWorkspace[];
  now?: () => string;
  onWarning?: (message: string) => void;
}): Promise<RoleSessionDataMigrationResult> {
  const migratedAt = (input.now ?? nowIso)();
  const migrationRoot = join(input.sparkHome, "migrations", "role-session-v6");
  const latestPath = join(migrationRoot, "latest.json");
  if ((await readLatestJournal(latestPath))?.status === "complete") {
    return { changed: false, files: 0, evidenceRefs: [] };
  }

  const mutations = new Map<string, FileMutation>();
  await collectJsonFileMutation(input.userRoleModelSettingsFile, "json", mutations);

  for (const workspace of input.workspaces) {
    const rootDir = resolve(workspace.rootDir);
    for (const path of WORKSPACE_JSON_FILES)
      await collectJsonFileMutation(join(rootDir, path), "json", mutations);
    for (const path of WORKSPACE_JSON_TREES)
      await collectJsonTreeMutations(join(rootDir, path), mutations);
    await collectSessionReproMutations(join(rootDir, ".spark", "sessions"), mutations);
    await collectEvidenceMutations(
      join(rootDir, ".spark", "evidence"),
      migratedAt,
      mutations,
      input.onWarning,
    );
  }

  const ordered = [...mutations.values()].sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath),
  );
  if (ordered.length === 0) {
    await writeCompleteSentinel(migrationRoot, migratedAt);
    return { changed: false, files: 0, evidenceRefs: [] };
  }
  const runId = `${migratedAt.replace(/[^0-9A-Za-z]/gu, "-")}-${randomUUID()}`;
  const backupDir = join(migrationRoot, runId);
  const stagedDir = join(backupDir, "staged");
  const originalDir = join(backupDir, "original");
  await mkdir(stagedDir, { recursive: true });
  await mkdir(originalDir, { recursive: true });

  const entries: MigrationJournalEntry[] = [];
  for (const [index, mutation] of ordered.entries()) {
    const name = `${String(index).padStart(5, "0")}-${safeFileName(basename(mutation.targetPath))}`;
    const stagedPath = join(stagedDir, name);
    await writeTextFileAtomic(stagedPath, mutation.next);
    let backupPath: string | undefined;
    if (mutation.original !== undefined) {
      backupPath = join(originalDir, name);
      await writeTextFileAtomic(backupPath, mutation.original);
    }
    entries.push({
      targetPath: mutation.targetPath,
      ...(backupPath ? { backupPath } : {}),
      stagedPath,
      ...(mutation.original === undefined ? {} : { originalHash: contentHash(mutation.original) }),
      nextHash: contentHash(mutation.next),
      kind: mutation.kind,
      ...(mutation.evidenceRef ? { evidenceRef: mutation.evidenceRef } : {}),
    });
  }

  const restorePath = join(backupDir, "restore.sh");
  const restoreCommand = `sh ${shellQuote(restorePath)}`;
  await writeTextFileAtomic(restorePath, renderRestoreScript(entries));
  await chmod(restorePath, 0o700);
  const journalPath = join(backupDir, "journal.json");
  const journal: MigrationJournal = {
    version: 1,
    migration: "role-session-v6",
    status: "staged",
    startedAt: migratedAt,
    backupDir,
    restoreCommand,
    entries,
  };
  await writeJsonFileAtomic(journalPath, journal);

  try {
    await validateOriginals(entries);
    journal.status = "switching";
    await writeJsonFileAtomic(journalPath, journal);
    for (const entry of entries)
      await writeTextFileAtomic(entry.targetPath, await readFile(entry.stagedPath, "utf8"));
    await validateTargets(entries);
    journal.status = "complete";
    journal.migratedAt = migratedAt;
    await writeJsonFileAtomic(journalPath, journal);
    await writeJsonFileAtomic(join(migrationRoot, "latest.json"), journal);
  } catch (cause) {
    try {
      await restoreOriginals(entries);
      journal.status = "rolled_back";
    } catch (rollbackError) {
      journal.status = "recovery_required";
      await writeJsonFileAtomic(journalPath, journal);
      throw new Error(
        `Role/Session v6 migration failed and rollback failed. Run ${restoreCommand}. Migration error: ${errorMessage(cause)}. Rollback error: ${errorMessage(rollbackError)}`,
        { cause },
      );
    }
    await writeJsonFileAtomic(journalPath, journal);
    throw new Error(
      `Role/Session v6 migration failed and was rolled back. Backup: ${backupDir}. Retry daemon start after resolving: ${errorMessage(cause)}`,
      { cause },
    );
  }

  return {
    changed: true,
    migratedAt,
    backupDir,
    files: entries.length,
    evidenceRefs: [...new Set(entries.flatMap((entry) => entry.evidenceRef ?? []))].sort(),
  };
}

async function readLatestJournal(path: string): Promise<MigrationJournal | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const status = (value as { status?: unknown }).status;
    if (
      status !== "staged" &&
      status !== "switching" &&
      status !== "complete" &&
      status !== "rolled_back" &&
      status !== "recovery_required"
    ) {
      return undefined;
    }
    return value as MigrationJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeCompleteSentinel(migrationRoot: string, migratedAt: string): Promise<void> {
  await mkdir(migrationRoot, { recursive: true });
  const journal: MigrationJournal = {
    version: 1,
    migration: "role-session-v6",
    status: "complete",
    startedAt: migratedAt,
    migratedAt,
    backupDir: migrationRoot,
    restoreCommand: "",
    entries: [],
  };
  await writeJsonFileAtomic(join(migrationRoot, "latest.json"), journal);
}

async function collectJsonTreeMutations(
  rootDir: string,
  mutations: Map<string, FileMutation>,
): Promise<void> {
  for (const path of await listStructuredFiles(rootDir))
    await collectJsonFileMutation(path, path.endsWith(".jsonl") ? "jsonl" : "json", mutations);
}

async function collectSessionReproMutations(
  rootDir: string,
  mutations: Map<string, FileMutation>,
): Promise<void> {
  for (const path of await listStructuredFiles(rootDir)) {
    if (basename(path) === "repro.json") await collectJsonFileMutation(path, "json", mutations);
  }
}

async function collectJsonFileMutation(
  path: string,
  kind: "json" | "jsonl",
  mutations: Map<string, FileMutation>,
): Promise<void> {
  const original = await readOptionalFile(path);
  if (original === undefined) return;
  const next =
    kind === "json" ? rewriteJsonDocument(original, path) : rewriteJsonLines(original, path);
  if (next !== original) addMutation(mutations, { targetPath: path, original, next, kind });
}

async function collectEvidenceMutations(
  evidenceRoot: string,
  migratedAt: string,
  mutations: Map<string, FileMutation>,
  onWarning?: (message: string) => void,
): Promise<void> {
  const entries = await listDirectFiles(evidenceRoot);
  for (const metadataPath of entries.filter((path) => path.endsWith(".json"))) {
    const original = await readFile(metadataPath, "utf8");
    const raw = parseJsonObject(original, metadataPath);
    const evidenceRef = typeof raw.ref === "string" ? raw.ref : undefined;
    const rewrittenMetadata = rewriteStructuredRoleRefs(raw, undefined);
    if (!isRecord(rewrittenMetadata))
      throw new Error(`Evidence migration produced invalid metadata at ${metadataPath}`);
    let bodyChanged = false;

    if (raw.format === "json" && typeof raw.blobPath === "string") {
      const blobPath = resolveContainedPath(evidenceRoot, raw.blobPath, "blobs");
      const blobOriginal = await readOptionalFile(blobPath);
      if (blobOriginal === undefined)
        throw new Error(`Evidence ${evidenceRef ?? metadataPath} is missing blob ${blobPath}`);
      if (typeof raw.hash === "string" && contentHash(blobOriginal) !== raw.hash)
        throw new Error(`Evidence ${evidenceRef ?? metadataPath} has a mismatched body hash`);
      let body: unknown;
      let bodyParsed = true;
      try {
        body = JSON.parse(blobOriginal) as unknown;
      } catch (error) {
        bodyParsed = false;
        onWarning?.(
          `Skipping RoleRef rewrite for malformed JSON Evidence body ${blobPath}: ${errorMessage(error)}`,
        );
      }
      if (bodyParsed) {
        const rewrittenBody = rewriteStructuredRoleRefs(body, undefined);
        bodyChanged = !deepEqual(body, rewrittenBody);
        if (bodyChanged) {
          const nextBlob = JSON.stringify(rewrittenBody, null, 2);
          const nextHash = contentHash(nextBlob);
          const nextBlobPath = join(evidenceRoot, "blobs", `${nextHash}.json`);
          const existingNextBlob = await readOptionalFile(nextBlobPath);
          if (existingNextBlob !== undefined && existingNextBlob !== nextBlob)
            throw new Error(`Evidence blob hash collision at ${nextBlobPath}`);
          if (existingNextBlob === undefined)
            addMutation(mutations, {
              targetPath: nextBlobPath,
              next: nextBlob,
              kind: "evidence_blob",
              ...(evidenceRef ? { evidenceRef } : {}),
            });
          rewrittenMetadata.hash = nextHash;
          rewrittenMetadata.blobPath = relative(evidenceRoot, nextBlobPath);
          rewriteEvidenceMetadataBody(rewrittenMetadata, rewrittenBody, nextBlob);
        }
      }
    }

    const metadataChanged = !deepEqual(raw, rewrittenMetadata);
    if (!metadataChanged && !bodyChanged) continue;
    rewrittenMetadata.updatedAt = migratedAt;
    const next = `${JSON.stringify(rewrittenMetadata, null, 2)}\n`;
    addMutation(mutations, {
      targetPath: metadataPath,
      original,
      next,
      kind: "evidence_metadata",
      ...(evidenceRef ? { evidenceRef } : {}),
    });
  }
}

function rewriteEvidenceMetadataBody(
  metadata: Record<string, unknown>,
  body: unknown,
  serializedBody: string,
): void {
  if (metadata.bodyTruncated === true) {
    const preview = previewBody(serializedBody, 4_000);
    metadata.body = preview;
    metadata.bodyPreview = preview;
    metadata.bodySize = Buffer.byteLength(serializedBody, "utf8");
    return;
  }
  metadata.body = body;
  delete metadata.bodyPreview;
  delete metadata.bodySize;
  delete metadata.bodyTruncated;
}

function rewriteJsonDocument(text: string, path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON at ${path}: ${errorMessage(error)}`);
  }
  const rewritten = rewriteStructuredRoleRefs(parsed, undefined);
  return deepEqual(parsed, rewritten) ? text : `${JSON.stringify(rewritten, null, 2)}\n`;
}

function rewriteJsonLines(text: string, path: string): string {
  const lines = text.split("\n");
  let changed = false;
  const next = lines.map((line, index) => {
    if (!line.trim()) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${errorMessage(error)}`);
    }
    const rewritten = rewriteStructuredRoleRefs(parsed, undefined);
    if (deepEqual(parsed, rewritten)) return line;
    changed = true;
    return JSON.stringify(rewritten);
  });
  return changed ? next.join("\n") : text;
}

export function rewriteStructuredRoleRefs(value: unknown, field?: string): unknown {
  if (typeof value === "string") {
    if (field && isRoleRefField(field)) return LEGACY_ROLE_REFS.get(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteStructuredRoleRefs(entry, field));
  if (!isRecord(value)) return value;

  if (value.version === 1 && isRecord(value.roleModels)) {
    const unexpected = Object.keys(value).filter(
      (key) => key !== "version" && key !== "roleModels",
    );
    if (unexpected.length > 0) {
      throw new Error(`Unknown role model settings v1 fields: ${unexpected.sort().join(", ")}`);
    }
    return { version: 2, modelTypes: migrateRoleModelsToModelTypes(value.roleModels) };
  }
  if (value.version === 2 && isRecord(value.modelTypes)) {
    const unexpected = Object.keys(value).filter(
      (key) => key !== "version" && key !== "modelTypes",
    );
    if (unexpected.length > 0) {
      throw new Error(`Unknown role model settings v2 fields: ${unexpected.sort().join(", ")}`);
    }
    return { version: 2, modelTypes: rewriteModelTypeSelectors(value.modelTypes) };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "roleModels" && isRecord(entry)) {
      output[key] = migrateRoleModelsToModelTypes(entry);
      continue;
    }
    if (key === "modelTypes" && isRecord(entry)) {
      output[key] = rewriteModelTypeSelectors(entry);
      continue;
    }
    output[key] = rewriteStructuredRoleRefs(entry, key);
  }
  return output;
}

function migrateRoleModelsToModelTypes(
  roleModels: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [selector, model] of Object.entries(roleModels)) {
    const mapped = roleModelSelectorToModelType(selector);
    if (mapped in output && output[mapped] !== model)
      throw new Error(`Conflicting role model settings collapse onto Model Type ${mapped}`);
    output[mapped] = model;
  }
  return output;
}

function roleModelSelectorToModelType(selector: string): string {
  const normalized = (LEGACY_ROLE_SELECTORS.get(selector) ?? selector)
    .trim()
    .toLowerCase()
    .replace(/^role:/u, "")
    .replace(/^(?:builtin-|extension-|project-|user-)/u, "");
  if (normalized === "administrator") return "coordination";
  if (normalized === "scout" || normalized === "explorer" || normalized === "researcher") {
    return "exploration";
  }
  if (normalized === "worker" || normalized === "executor") return "implementation";
  if (normalized === "reviewer") return "verification";
  if (/^[a-z][a-z0-9._-]*$/u.test(normalized)) return normalized;
  throw new Error(`Cannot migrate role model selector to Model Type: ${selector}`);
}

function rewriteModelTypeSelectors(modelTypes: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [selector, model] of Object.entries(modelTypes)) {
    const mapped = selector === "research" ? "exploration" : selector;
    if (mapped in output && output[mapped] !== model)
      throw new Error(`Conflicting role model settings collapse onto ${mapped}`);
    output[mapped] = model;
  }
  return output;
}

function isRoleRefField(field: string): boolean {
  return (
    field === "roleRef" ||
    field === "roleRefs" ||
    field.endsWith("RoleRef") ||
    field.endsWith("RoleRefs")
  );
}

async function listStructuredFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  await walk(rootDir, output);
  return output.sort();
}

async function walk(rootDir: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(rootDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Role/Session migration refuses symlink ${path}`);
    if (entry.isDirectory()) await walk(path, output);
    else if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")))
      output.push(path);
  }
}

async function listDirectFiles(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries)
      if (entry.isSymbolicLink())
        throw new Error(`Role/Session migration refuses symlink ${join(rootDir, entry.name)}`);
    return entries.filter((entry) => entry.isFile()).map((entry) => join(rootDir, entry.name));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function validateOriginals(entries: MigrationJournalEntry[]): Promise<void> {
  for (const entry of entries) {
    const current = await readOptionalFile(entry.targetPath);
    if (entry.originalHash === undefined) {
      if (current !== undefined && contentHash(current) !== entry.nextHash)
        throw new Error(`Migration target appeared after staging: ${entry.targetPath}`);
      continue;
    }
    if (current === undefined || contentHash(current) !== entry.originalHash)
      throw new Error(`Migration target changed after staging: ${entry.targetPath}`);
  }
}

async function validateTargets(entries: MigrationJournalEntry[]): Promise<void> {
  for (const entry of entries) {
    const current = await readFile(entry.targetPath, "utf8");
    if (contentHash(current) !== entry.nextHash)
      throw new Error(`Migration target validation failed: ${entry.targetPath}`);
    if (entry.kind === "json" || entry.kind === "evidence_metadata") {
      if (rewriteJsonDocument(current, entry.targetPath) !== current)
        throw new Error(`Legacy structured RoleRef remains at ${entry.targetPath}`);
    }
    if (entry.kind === "jsonl" && rewriteJsonLines(current, entry.targetPath) !== current)
      throw new Error(`Legacy structured RoleRef remains at ${entry.targetPath}`);
    if (
      entry.kind === "evidence_blob" &&
      rewriteJsonDocument(current, entry.targetPath) !== current
    )
      throw new Error(`Legacy structured RoleRef remains at ${entry.targetPath}`);
    if (entry.kind === "evidence_metadata") await validateEvidenceMetadataTarget(entry.targetPath);
  }
}

async function validateEvidenceMetadataTarget(metadataPath: string): Promise<void> {
  const metadata = parseJsonObject(await readFile(metadataPath, "utf8"), metadataPath);
  if (typeof metadata.blobPath !== "string" || typeof metadata.hash !== "string") return;
  const evidenceRoot = dirname(metadataPath);
  const blobPath = resolveContainedPath(evidenceRoot, metadata.blobPath, "blobs");
  const body = await readFile(blobPath, "utf8");
  if (contentHash(body) !== metadata.hash)
    throw new Error(`Migrated Evidence body hash mismatch at ${metadataPath}`);
}

async function restoreOriginals(entries: MigrationJournalEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.backupPath) {
      await writeTextFileAtomic(entry.targetPath, await readFile(entry.backupPath, "utf8"));
      continue;
    }
    const current = await readOptionalFile(entry.targetPath);
    if (current === undefined) continue;
    if (contentHash(current) !== entry.nextHash)
      throw new Error(`Refusing to remove changed migration target: ${entry.targetPath}`);
    await unlink(entry.targetPath);
  }
}

function renderRestoreScript(entries: readonly MigrationJournalEntry[]): string {
  const operations = entries.map((entry) =>
    entry.backupPath
      ? `cp -p ${shellQuote(entry.backupPath)} ${shellQuote(entry.targetPath)}`
      : `rm -f -- ${shellQuote(entry.targetPath)}`,
  );
  return ["#!/bin/sh", "set -eu", ...operations, ""].join("\n");
}

function addMutation(mutations: Map<string, FileMutation>, mutation: FileMutation): void {
  const existing = mutations.get(mutation.targetPath);
  if (existing && existing.next !== mutation.next)
    throw new Error(`Conflicting Role/Session migrations target ${mutation.targetPath}`);
  mutations.set(mutation.targetPath, mutation);
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error(`Expected JSON object at ${path}`);
  return parsed;
}

function resolveContainedPath(rootDir: string, storedPath: string, requiredDir: string): string {
  const root = resolve(rootDir);
  const requiredRoot = resolve(root, requiredDir);
  const target = resolve(root, storedPath);
  const scoped = relative(requiredRoot, target);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped))
    throw new Error(`Evidence blob path escapes ${requiredDir}: ${storedPath}`);
  return target;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Role/Session migration refuses symlink ${path}`);
    if (!info.isFile()) throw new Error(`Role/Session migration expected a file at ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function previewBody(text: string, chars: number): string {
  return text.length > chars
    ? `${text.slice(0, chars)}\n… truncated ${text.length - chars} char(s)`
    : text;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeFileName(value: string): string {
  return value.replace(/[^0-9A-Za-z._-]/gu, "_");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
