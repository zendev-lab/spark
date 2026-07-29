import { join } from "node:path";
import {
  errorMessage,
  migrationIssue,
  type EvidenceMigrationIssue,
  type EvidenceMigrationMapping,
  type EvidenceMigrationSkipped,
  type EvidenceMigrationWorkspace,
  type FileFact,
  type PlannedOperation,
  type WorkspaceMigrationPlan,
} from "./evidence-migration-types.ts";
import {
  appendInactiveStateSkips,
  hashBytes,
  hashFileMap,
  hashJson,
  hashSelectedFiles,
  jsonBytes,
  relativeWorkspacePath,
  workspaceFileMap,
} from "./evidence-migration-paths.ts";
import {
  auditEvidenceRecordRefs,
  sortedUniqueIssues,
  sortedUniqueSkipped,
} from "./evidence-migration-references.ts";
import { canonicalStoredEvidenceRecord } from "./evidence-migration-records.ts";
import {
  addDeleteOperation,
  addWriteOperation,
  operationDescriptor,
  operationOrder,
} from "./evidence-migration-operations.ts";
import { scanWorkspaceEvidenceStores } from "./evidence-migration-scan.ts";
import { discoverSchemaEvidenceRefs, planStateFileRewrites } from "./evidence-migration-state.ts";
import type {
  CanonicalEvidenceSource,
  LegacyEvidenceSource,
  WorkspaceEvidenceInventory,
} from "./evidence-migration-scan.ts";

export async function planWorkspaceMigration(
  workspace: EvidenceMigrationWorkspace,
): Promise<WorkspaceMigrationPlan> {
  const rootDir = workspace.rootDir;
  const filesBefore = await workspaceFileMap(rootDir);
  const inventory = await scanWorkspaceEvidenceStores(rootDir);
  await discoverSchemaEvidenceRefs(rootDir, inventory, filesBefore);
  const operations = new Map<string, PlannedOperation>();
  const dangling: EvidenceMigrationIssue[] = [];
  const productMisclassified: EvidenceMigrationIssue[] = [];
  const skipped: EvidenceMigrationSkipped[] = [];
  const mappingRows: EvidenceMigrationMapping[] = [...inventory.schemaMappings];
  const issues = { dangling, productMisclassified };

  for (const record of inventory.legacyRecords) {
    await planLegacyRecord(
      rootDir,
      record,
      inventory,
      filesBefore,
      operations,
      mappingRows,
      issues,
    );
  }
  for (const record of inventory.canonicalRecords) {
    await planCanonicalRecord(rootDir, record, inventory, filesBefore, operations, issues);
  }
  appendInactiveStateSkips(filesBefore, skipped);
  await planStateFileRewrites(rootDir, inventory, filesBefore, operations, issues);

  const sortedOperations = [...operations.values()].sort(operationOrder);
  const afterFiles = new Map(filesBefore);
  for (const operation of sortedOperations) {
    if (operation.kind === "delete") afterFiles.delete(operation.relativePath);
    else
      afterFiles.set(operation.relativePath, {
        hash: operation.afterHash,
        bytes: operation.content.length,
      });
  }
  const beforeHash = hashFileMap(filesBefore);
  const afterHash = hashFileMap(afterFiles);
  const productHashBefore = hashSelectedFiles(filesBefore, inventory.productPaths);
  const productHashAfter = hashSelectedFiles(afterFiles, inventory.productPaths);
  if (productHashBefore !== productHashAfter) {
    productMisclassified.push(
      migrationIssue(
        join(".spark", "artifacts"),
        "product_hash_changed",
        "planned operations would change Product Artifact metadata or content",
      ),
    );
  }

  const invalid = sortedUniqueIssues(inventory.invalid);
  const ambiguous = sortedUniqueIssues(inventory.ambiguous);
  const normalizedDangling = sortedUniqueIssues(dangling);
  const normalizedMisclassified = sortedUniqueIssues(productMisclassified);
  const normalizedSkipped = sortedUniqueSkipped(skipped);
  const mapping = mappingRows.sort((left, right) => left.fromRef.localeCompare(right.fromRef));
  const planHash = hashJson({
    workspaceId: workspace.workspaceId,
    beforeHash,
    afterHash,
    mapping,
    operations: sortedOperations.map(operationDescriptor),
    invalid,
    ambiguous,
    dangling: normalizedDangling,
    productMisclassified: normalizedMisclassified,
  });
  const blocked =
    invalid.length > 0 ||
    ambiguous.length > 0 ||
    normalizedDangling.length > 0 ||
    normalizedMisclassified.length > 0;
  const report = {
    workspaceId: workspace.workspaceId,
    workspaceRoot: rootDir,
    discovered: inventory.discovered,
    migrated: mapping.length,
    productPreserved: inventory.productPreserved,
    productMisclassified: normalizedMisclassified,
    dangling: normalizedDangling,
    invalid,
    ambiguous,
    skipped: normalizedSkipped,
    mapping,
    changedFiles: sortedOperations.length,
    backupPath: null,
    beforeHash,
    afterHash,
    productHashBefore,
    productHashAfter,
    planHash,
    blocked,
  };
  return { workspace, rootDir, report, operations: sortedOperations };
}

async function planLegacyRecord(
  rootDir: string,
  record: LegacyEvidenceSource,
  inventory: WorkspaceEvidenceInventory,
  filesBefore: ReadonlyMap<string, FileFact>,
  operations: Map<string, PlannedOperation>,
  mappingRows: EvidenceMigrationMapping[],
  issues: { dangling: EvidenceMigrationIssue[]; productMisclassified: EvidenceMigrationIssue[] },
): Promise<void> {
  const sourceRef = record.raw.ref as string;
  const targetRef = inventory.mapping.get(sourceRef)!;
  try {
    auditEvidenceRecordRefs(
      record.raw,
      record.path,
      inventory.mapping,
      inventory.productRefs,
      inventory.evidenceRefs,
      issues,
    );
    const migrated = await canonicalStoredEvidenceRecord({
      raw: record.raw,
      storeRoot: record.storeRoot,
      targetRef,
      canonicalKind: record.canonicalKind,
      mapping: inventory.mapping,
    });
    const metadataContent = jsonBytes(migrated.metadata);
    const existing = filesBefore.get(record.destinationPath);
    if (
      record.destinationPath !== record.path &&
      existing &&
      existing.hash !== hashBytes(metadataContent)
    ) {
      inventory.ambiguous.push(
        migrationIssue(
          record.destinationPath,
          "destination_collision",
          "evidence destination contains different metadata",
          targetRef,
        ),
      );
    } else {
      addWriteOperation(
        operations,
        filesBefore,
        record.destinationPath,
        metadataContent,
        inventory.ambiguous,
        record.destinationPath === record.path,
      );
    }
    addWriteOperation(
      operations,
      filesBefore,
      relativeWorkspacePath(rootDir, join(record.destinationStoreRoot, migrated.blobPath)),
      Buffer.from(migrated.serializedBody, "utf8"),
      inventory.ambiguous,
      false,
    );
    if (record.deleteSource) {
      addDeleteOperation(operations, filesBefore, record.path, inventory.invalid);
    }
    mappingRows.push({
      fromRef: sourceRef,
      toRef: targetRef,
      kind: record.canonicalKind,
      path: record.path,
      hash: migrated.metadata.hash,
    });
  } catch (error) {
    inventory.invalid.push(
      migrationIssue(record.path, "invalid_legacy_evidence", errorMessage(error), sourceRef),
    );
  }
}

async function planCanonicalRecord(
  rootDir: string,
  record: CanonicalEvidenceSource,
  inventory: WorkspaceEvidenceInventory,
  filesBefore: ReadonlyMap<string, FileFact>,
  operations: Map<string, PlannedOperation>,
  issues: { dangling: EvidenceMigrationIssue[]; productMisclassified: EvidenceMigrationIssue[] },
): Promise<void> {
  try {
    auditEvidenceRecordRefs(
      record.raw,
      record.path,
      inventory.mapping,
      inventory.productRefs,
      inventory.evidenceRefs,
      issues,
    );
    const canonical = await canonicalStoredEvidenceRecord({
      raw: record.raw,
      storeRoot: record.storeRoot,
      targetRef: record.raw.ref as string,
      canonicalKind: String(record.raw.kind),
      mapping: inventory.mapping,
    });
    addWriteOperation(
      operations,
      filesBefore,
      record.path,
      jsonBytes(canonical.metadata),
      inventory.ambiguous,
      true,
    );
    addWriteOperation(
      operations,
      filesBefore,
      relativeWorkspacePath(rootDir, join(record.storeRoot, canonical.blobPath)),
      Buffer.from(canonical.serializedBody, "utf8"),
      inventory.ambiguous,
      false,
    );
  } catch (error) {
    inventory.invalid.push(
      migrationIssue(
        record.path,
        "invalid_canonical_evidence",
        errorMessage(error),
        typeof record.raw.ref === "string" ? record.raw.ref : undefined,
      ),
    );
  }
}
