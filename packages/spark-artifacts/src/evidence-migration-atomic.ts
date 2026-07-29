import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  EVIDENCE_BACKUP_ROOT,
  EVIDENCE_MIGRATION_TEMPORARY_MARKER,
  errorCode,
  type EvidenceMigrationFaultContext,
  type EvidenceMigrationFaultInjector,
} from "./evidence-migration-types.ts";
import { hashBytes, workspacePath } from "./evidence-migration-paths.ts";

export async function durableAtomicWrite(
  filePath: string,
  content: Buffer,
  faultInjector?: EvidenceMigrationFaultInjector,
  context?: EvidenceMigrationFaultContext,
): Promise<void> {
  if (context) {
    await assertMigrationPathComponentsSafe(context.workspaceRoot, dirname(filePath));
  }
  await mkdir(dirname(filePath), { recursive: true });
  if (context) await assertMutationParentInsideWorkspace(context.workspaceRoot, filePath);
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}${EVIDENCE_MIGRATION_TEMPORARY_MARKER}${process.pid}.${randomUUID()}.tmp`,
  );
  await faultInjector?.("before-write", context ?? fallbackFaultContext(filePath));
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await faultInjector?.("before-rename", context ?? fallbackFaultContext(filePath));
    await rename(tempPath, filePath);
    await syncDirectory(dirname(filePath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function durableAtomicDelete(
  filePath: string,
  faultInjector?: EvidenceMigrationFaultInjector,
  context?: EvidenceMigrationFaultContext,
): Promise<void> {
  if ((await optionalFileHash(filePath)) === null) return;
  if (context) {
    await assertMigrationPathComponentsSafe(context.workspaceRoot, dirname(filePath));
    await assertMutationParentInsideWorkspace(context.workspaceRoot, filePath);
  }
  const tombstone = join(
    dirname(filePath),
    `.${basename(filePath)}${EVIDENCE_MIGRATION_TEMPORARY_MARKER}${process.pid}.${randomUUID()}.delete`,
  );
  await faultInjector?.("before-rename", context ?? fallbackFaultContext(filePath));
  await rename(filePath, tombstone);
  await syncDirectory(dirname(filePath));
  await rm(tombstone, { force: true });
  await syncDirectory(dirname(filePath));
}

export async function cleanupInterruptedMigrationFiles(
  target: string,
  workspaceRoot: string,
): Promise<void> {
  await assertMutationParentInsideWorkspace(workspaceRoot, target);
  let entries;
  try {
    entries = await readdir(dirname(target));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const prefix = `.${basename(target)}${EVIDENCE_MIGRATION_TEMPORARY_MARKER}`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(join(dirname(target), entry), { force: true })),
  );
}

export async function optionalFileHash(path: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export function backupEntryPath(backupPath: string, relativePath: string): string {
  return workspacePath(join(backupPath, "files"), relativePath);
}

export async function assertMigrationPathComponentsSafe(
  workspaceRoot: string,
  targetDirectory: string,
): Promise<void> {
  const root = await realpath(workspaceRoot);
  const scoped = relative(root, resolve(targetDirectory));
  if (scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error(`migration directory escapes workspace: ${targetDirectory}`);
  }
  let current = root;
  for (const component of scoped.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`symlinked migration directory is not supported: ${current}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`migration path component is not a directory: ${current}`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") break;
      throw error;
    }
  }
}

export function assertEvidenceBackupPath(workspaceRoot: string, backupPath: string): void {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const inferredWorkspaceRoot = resolve(backupPath, "..", "..", "..", "..");
  if (resolvedWorkspaceRoot !== inferredWorkspaceRoot) {
    throw new Error("backup manifest workspace root does not match backup location");
  }
  const allowedRoot = resolve(resolvedWorkspaceRoot, EVIDENCE_BACKUP_ROOT);
  const scoped = relative(allowedRoot, resolve(backupPath));
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error("backup path is outside the Evidence migration backup root");
  }
}

async function assertMutationParentInsideWorkspace(
  workspaceRoot: string,
  filePath: string,
): Promise<void> {
  const root = await realpath(workspaceRoot);
  const parent = await realpath(dirname(filePath));
  const scoped = relative(root, parent);
  if (scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error(`migration target parent escapes workspace: ${filePath}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EBADF", "ENOTSUP"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fallbackFaultContext(filePath: string): EvidenceMigrationFaultContext {
  return {
    workspaceId: "unknown",
    workspaceRoot: dirname(filePath),
    relativePath: basename(filePath),
    phase: "apply",
  };
}
