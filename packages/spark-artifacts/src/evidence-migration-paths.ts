import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  EVIDENCE_MIGRATION_TEMPORARY_MARKER,
  errorCode,
  errorMessage,
  isRecord,
  migrationIssue,
  type EvidenceMigrationIssue,
  type EvidenceMigrationSkipped,
  type EvidenceMigrationWorkspace,
  type FileFact,
} from "./evidence-migration-types.ts";

export async function normalizeMigrationWorkspaces(
  workspaces: readonly EvidenceMigrationWorkspace[],
): Promise<EvidenceMigrationWorkspace[]> {
  const byRoot = new Map<string, EvidenceMigrationWorkspace>();
  for (const workspace of [...workspaces].sort((left, right) =>
    left.workspaceId.localeCompare(right.workspaceId),
  )) {
    const rootDir = await canonicalDirectory(workspace.rootDir);
    if (!byRoot.has(rootDir)) byRoot.set(rootDir, { ...workspace, rootDir });
  }
  return [...byRoot.values()];
}

export async function workspaceFileMap(rootDir: string): Promise<Map<string, FileFact>> {
  const result = new Map<string, FileFact>();
  for (const path of await regularFilesRecursively(join(rootDir, ".spark"))) {
    const relativePath = relativeWorkspacePath(rootDir, path);
    if (treeHashPathExcluded(relativePath)) continue;
    const content = await readFile(path);
    result.set(relativePath, { hash: hashBytes(content), bytes: content.length });
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)));
}

export async function workspaceTreeHash(rootDir: string): Promise<string> {
  return hashFileMap(await workspaceFileMap(rootDir));
}

export function hashFileMap(files: ReadonlyMap<string, FileFact>): string {
  const hash = createHash("sha256");
  for (const [path, fact] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path);
    hash.update("\0");
    hash.update(fact.hash);
    hash.update("\0");
    hash.update(String(fact.bytes));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function hashSelectedFiles(
  files: ReadonlyMap<string, FileFact>,
  selected: ReadonlySet<string>,
): string {
  const subset = new Map<string, FileFact>();
  for (const path of selected) {
    const fact = files.get(path);
    if (fact) subset.set(path, fact);
  }
  return hashFileMap(subset);
}

export async function selectedWorkspaceFilesHash(
  rootDir: string,
  selected: ReadonlySet<string>,
): Promise<string> {
  return hashSelectedFiles(await workspaceFileMap(rootDir), selected);
}

export async function jsonMetadataEntries(
  rootDir: string,
): Promise<Array<{ name: string; path: string }>> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({ name: entry.name, path: join(rootDir, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

export async function readJsonObject(
  path: string,
  invalid: EvidenceMigrationIssue[],
  relativePath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("metadata must be a JSON object");
    return value;
  } catch (error) {
    invalid.push(migrationIssue(relativePath, "invalid_json", errorMessage(error)));
    return undefined;
  }
}

export function scopedBlobPath(rootDir: string, blobPath: string): string | undefined {
  if (!blobPath.trim() || blobPath.includes("\0") || isAbsolute(blobPath)) return undefined;
  const root = resolve(rootDir);
  const blobRoot = resolve(root, "blobs");
  const resolved = resolve(root, blobPath);
  const scoped = relative(blobRoot, resolved);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) return undefined;
  return resolved;
}

export function workspacePath(rootDir: string, relativePath: string): string {
  if (isAbsolute(relativePath))
    throw new Error(`absolute migration path is forbidden: ${relativePath}`);
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  const scoped = relative(root, target);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error(`migration path escapes workspace: ${relativePath}`);
  }
  return target;
}

export function relativeWorkspacePath(rootDir: string, path: string): string {
  const scoped = relative(resolve(rootDir), resolve(path));
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error(`path is outside workspace: ${path}`);
  }
  return scoped;
}

export function stateScanPathExcluded(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join("/");
  return (
    treeHashPathExcluded(relativePath) ||
    normalized === ".spark/projects.json" ||
    normalized.startsWith(".spark/imported/") ||
    normalized.split("/").includes("quarantine") ||
    normalized.split("/").includes("blobs")
  );
}

export function appendInactiveStateSkips(
  files: ReadonlyMap<string, FileFact>,
  skipped: EvidenceMigrationSkipped[],
): void {
  if ([...files.keys()].some((path) => path.startsWith(join(".spark", "imported")))) {
    skipped.push({
      path: join(".spark", "imported"),
      reason: "archived import snapshot is not active workspace state",
    });
  }
  if (files.has(join(".spark", "projects.json"))) {
    skipped.push({
      path: join(".spark", "projects.json"),
      reason: "Store V2 import-only project graph is not active workspace state",
    });
  }
  if ([...files.keys()].some((path) => path.includes(`${sep}quarantine${sep}`))) {
    skipped.push({
      path: join(".spark", "memory", "quarantine"),
      reason: "quarantined memory snapshots are not active workspace state",
    });
  }
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function hashJson(value: unknown): string {
  return hashBytes(jsonBytes(value));
}

export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceRefForLegacy(ref: string): string {
  return `evidence:${refId(ref)}`;
}

export function refId(ref: string): string {
  const index = ref.indexOf(":");
  const id = index >= 0 ? ref.slice(index + 1) : "";
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0")) {
    throw new Error(`invalid ref id: ${ref}`);
  }
  return id;
}

export function metadataFilenameMatchesRef(filename: string, ref: string): boolean {
  try {
    return filename === `${refId(ref)}.json`;
  } catch {
    return false;
  }
}

export function isArtifactRef(value: string): boolean {
  return value.startsWith("artifact:") && value.length > "artifact:".length;
}

export function isEvidenceRef(value: string): boolean {
  return value.startsWith("evidence:") && value.length > "evidence:".length;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function canonicalDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${resolved}`);
  return realpath(resolved);
}

async function regularFilesRecursively(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (path === rootDir && ["backups", "tmp"].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `symlinked workspace state is not supported by Evidence migration: ${child}`,
        );
      }
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) output.push(child);
    }
  }
  await visit(rootDir);
  return output;
}

function treeHashPathExcluded(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized.includes(EVIDENCE_MIGRATION_TEMPORARY_MARKER)) return true;
  if (normalized.startsWith(".spark/backups/") || normalized.startsWith(".spark/tmp/")) return true;
  return normalized
    .split("/")
    .some((segment) => segment === "backups" || segment.startsWith("backup-"));
}
