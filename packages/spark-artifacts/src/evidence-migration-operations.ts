import {
  migrationIssue,
  type EvidenceMigrationIssue,
  type FileFact,
  type PlannedOperation,
} from "./evidence-migration-types.ts";
import { hashBytes } from "./evidence-migration-paths.ts";

export function addWriteOperation(
  operations: Map<string, PlannedOperation>,
  filesBefore: ReadonlyMap<string, FileFact>,
  relativePath: string,
  content: Buffer,
  ambiguous: EvidenceMigrationIssue[],
  allowOverwrite: boolean,
): void {
  const afterHash = hashBytes(content);
  const before = filesBefore.get(relativePath);
  if (before?.hash === afterHash) return;
  const existing = operations.get(relativePath);
  if (existing) {
    if (existing.kind === "write" && existing.afterHash === afterHash) return;
    ambiguous.push(
      migrationIssue(
        relativePath,
        "conflicting_operations",
        "multiple operations target the same path",
      ),
    );
    return;
  }
  if (before && !allowOverwrite) {
    ambiguous.push(
      migrationIssue(relativePath, "destination_collision", "destination has different bytes"),
    );
    return;
  }
  operations.set(relativePath, {
    kind: "write",
    relativePath,
    beforeHash: before?.hash ?? null,
    afterHash,
    content,
  });
}

export function addDeleteOperation(
  operations: Map<string, PlannedOperation>,
  filesBefore: ReadonlyMap<string, FileFact>,
  relativePath: string,
  invalid: EvidenceMigrationIssue[],
): void {
  const before = filesBefore.get(relativePath);
  if (!before) {
    invalid.push(migrationIssue(relativePath, "missing_source", "legacy metadata disappeared"));
    return;
  }
  if (operations.has(relativePath)) {
    invalid.push(
      migrationIssue(relativePath, "conflicting_operations", "cannot write and delete path"),
    );
    return;
  }
  operations.set(relativePath, {
    kind: "delete",
    relativePath,
    beforeHash: before.hash,
    afterHash: null,
  });
}

export function operationOrder(left: PlannedOperation, right: PlannedOperation): number {
  if (left.kind !== right.kind) return left.kind === "write" ? -1 : 1;
  return left.relativePath.localeCompare(right.relativePath);
}

export function operationDescriptor(operation: PlannedOperation): Record<string, unknown> {
  return {
    kind: operation.kind,
    path: operation.relativePath,
    beforeHash: operation.beforeHash,
    afterHash: operation.afterHash,
  };
}
