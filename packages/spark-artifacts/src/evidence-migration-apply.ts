import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EVIDENCE_BACKUP_ROOT,
  EVIDENCE_MIGRATION_VERSION,
  EvidenceMigrationApplyError,
  isRecord,
  type ApplyEvidenceMigrationOptions,
  type EvidenceMigrationBackupManifest,
  type EvidenceMigrationFaultContext,
  type EvidenceWorkspaceMigrationReport,
  type WorkspaceMigrationPlan,
} from "./evidence-migration-types.ts";
import {
  assertEvidenceBackupPath,
  assertMigrationPathComponentsSafe,
  backupEntryPath,
  cleanupInterruptedMigrationFiles,
  durableAtomicDelete,
  durableAtomicWrite,
  optionalFileHash,
} from "./evidence-migration-atomic.ts";
import {
  hashBytes,
  jsonBytes,
  selectedWorkspaceFilesHash,
  workspacePath,
  workspaceTreeHash,
} from "./evidence-migration-paths.ts";
import { productPathsForWorkspace } from "./evidence-migration-product.ts";

export async function applyWorkspaceMigration(
  plan: WorkspaceMigrationPlan,
  options: ApplyEvidenceMigrationOptions,
): Promise<EvidenceWorkspaceMigrationReport> {
  if (plan.operations.length === 0) {
    return {
      ...plan.report,
      backupPath: null,
      afterHash: await workspaceTreeHash(plan.rootDir),
      productHashAfter: plan.report.productHashBefore,
    };
  }

  let backupPath: string | null = null;
  try {
    const prepared = await prepareBackup(plan, options.now?.() ?? new Date());
    backupPath = prepared.path;
    await options.faultInjector?.("after-backup", faultContext(plan, "backup"));
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index]!;
      const context = faultContext(plan, "apply", operation.relativePath, index);
      const target = workspacePath(plan.rootDir, operation.relativePath);
      const current = await optionalFileHash(target);
      if (current !== operation.beforeHash) {
        throw new Error(
          `stale file ${operation.relativePath}: expected ${String(operation.beforeHash)}, got ${String(current)}`,
        );
      }
      if (operation.kind === "write") {
        await durableAtomicWrite(target, operation.content, options.faultInjector, context);
      } else {
        await options.faultInjector?.("before-delete", context);
        await durableAtomicDelete(target, options.faultInjector, context);
      }
      await options.faultInjector?.("after-operation", context);
    }
    const afterHash = await workspaceTreeHash(plan.rootDir);
    if (afterHash !== plan.report.afterHash) {
      throw new Error(`after hash mismatch: expected ${plan.report.afterHash}, got ${afterHash}`);
    }
    const productHashAfter = await selectedWorkspaceFilesHash(
      plan.rootDir,
      await productPathsForWorkspace(plan.rootDir),
    );
    if (productHashAfter !== plan.report.productHashBefore) {
      throw new Error("Product Artifact metadata or content hash changed during migration");
    }
    await updateBackupStatus(backupPath, "applied", options.now?.() ?? new Date());
    return { ...plan.report, backupPath, afterHash, productHashAfter };
  } catch (error) {
    let rolledBack = false;
    if (backupPath) {
      try {
        await restoreEvidenceNamespaceMigrationBackup(backupPath);
        await updateBackupStatus(backupPath, "rolled_back", options.now?.() ?? new Date());
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }
    throw new EvidenceMigrationApplyError({
      workspaceId: plan.workspace.workspaceId,
      backupPath,
      rolledBack,
      cause: error,
    });
  }
}

export async function restoreEvidenceNamespaceMigrationBackup(
  backupPath: string,
): Promise<{ restored: number; treeHash: string; manifest: EvidenceMigrationBackupManifest }> {
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = parseBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  assertEvidenceBackupPath(manifest.workspaceRoot, backupPath);

  let restored = 0;
  for (const entry of [...manifest.entries].reverse()) {
    const target = workspacePath(manifest.workspaceRoot, entry.relativePath);
    const context = manifestFaultContext(manifest, entry.relativePath);
    await cleanupInterruptedMigrationFiles(target, manifest.workspaceRoot);
    if (entry.existed) {
      const content = await readFile(backupEntryPath(backupPath, entry.relativePath));
      if (hashBytes(content) !== entry.beforeHash) {
        throw new Error(`backup hash mismatch for ${entry.relativePath}`);
      }
      await durableAtomicWrite(target, content, undefined, context);
    } else {
      await durableAtomicDelete(target, undefined, context);
    }
    restored += 1;
  }

  const treeHash = await workspaceTreeHash(manifest.workspaceRoot);
  if (treeHash !== manifest.beforeHash) {
    throw new Error(
      `restored workspace hash mismatch: expected ${manifest.beforeHash}, got ${treeHash}`,
    );
  }
  const restoredManifest: EvidenceMigrationBackupManifest = {
    ...manifest,
    status: "restored",
    completedAt: new Date().toISOString(),
  };
  await durableAtomicWrite(
    manifestPath,
    jsonBytes(restoredManifest),
    undefined,
    manifestFaultContext(manifest, "manifest.json"),
  );
  return { restored, treeHash, manifest: restoredManifest };
}

async function prepareBackup(
  plan: WorkspaceMigrationPlan,
  now: Date,
): Promise<{ path: string; manifest: EvidenceMigrationBackupManifest }> {
  const timestamp = now.toISOString().replaceAll(":", "-");
  const backupPath = join(
    plan.rootDir,
    EVIDENCE_BACKUP_ROOT,
    `${timestamp}-${plan.report.planHash.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
  );
  await assertMigrationPathComponentsSafe(plan.rootDir, backupPath);
  await mkdir(backupPath, { recursive: true });
  const entries: EvidenceMigrationBackupManifest["entries"] = [];
  for (const operation of plan.operations) {
    const source = workspacePath(plan.rootDir, operation.relativePath);
    const existed = operation.beforeHash !== null;
    if (existed) {
      const content = await readFile(source);
      if (hashBytes(content) !== operation.beforeHash) {
        throw new Error(`cannot back up stale file ${operation.relativePath}`);
      }
      await durableAtomicWrite(
        backupEntryPath(backupPath, operation.relativePath),
        content,
        undefined,
        faultContext(plan, "backup", operation.relativePath),
      );
    }
    entries.push({
      relativePath: operation.relativePath,
      operation: operation.kind,
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      existed,
    });
  }
  const manifest: EvidenceMigrationBackupManifest = {
    version: EVIDENCE_MIGRATION_VERSION,
    status: "prepared",
    workspaceId: plan.workspace.workspaceId,
    workspaceRoot: plan.rootDir,
    createdAt: now.toISOString(),
    planHash: plan.report.planHash,
    beforeHash: plan.report.beforeHash,
    afterHash: plan.report.afterHash,
    entries,
  };
  await durableAtomicWrite(
    join(backupPath, "manifest.json"),
    jsonBytes(manifest),
    undefined,
    faultContext(plan, "backup", "manifest.json"),
  );
  return { path: backupPath, manifest };
}

async function updateBackupStatus(
  backupPath: string,
  status: EvidenceMigrationBackupManifest["status"],
  now: Date,
): Promise<void> {
  const path = join(backupPath, "manifest.json");
  const manifest = parseBackupManifest(JSON.parse(await readFile(path, "utf8")));
  await durableAtomicWrite(
    path,
    jsonBytes({
      ...manifest,
      status,
      completedAt: now.toISOString(),
    } satisfies EvidenceMigrationBackupManifest),
    undefined,
    manifestFaultContext(manifest, "manifest.json"),
  );
}

function parseBackupManifest(value: unknown): EvidenceMigrationBackupManifest {
  if (!isRecord(value) || value.version !== EVIDENCE_MIGRATION_VERSION) {
    throw new Error("invalid Evidence migration backup manifest");
  }
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.planHash !== "string" ||
    typeof value.beforeHash !== "string" ||
    typeof value.afterHash !== "string" ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("incomplete Evidence migration backup manifest");
  }
  return value as unknown as EvidenceMigrationBackupManifest;
}

function manifestFaultContext(
  manifest: EvidenceMigrationBackupManifest,
  relativePath: string,
): EvidenceMigrationFaultContext {
  return {
    workspaceId: manifest.workspaceId,
    workspaceRoot: manifest.workspaceRoot,
    relativePath,
    phase: "backup",
  };
}

function faultContext(
  plan: WorkspaceMigrationPlan,
  phase: EvidenceMigrationFaultContext["phase"],
  relativePath?: string,
  operationIndex?: number,
): EvidenceMigrationFaultContext {
  return {
    workspaceId: plan.workspace.workspaceId,
    workspaceRoot: plan.rootDir,
    relativePath,
    operationIndex,
    phase,
  };
}
