import { readFile } from "node:fs/promises";
import {
  errorMessage,
  migrationIssue,
  type EvidenceMigrationIssue,
  type FileFact,
  type PlannedOperation,
} from "./evidence-migration-types.ts";
import {
  evidenceRefForLegacy,
  isArtifactRef,
  jsonBytes,
  stateScanPathExcluded,
  workspacePath,
} from "./evidence-migration-paths.ts";
import { rewriteStateRefs } from "./evidence-migration-references.ts";
import { addWriteOperation } from "./evidence-migration-operations.ts";
import type { WorkspaceEvidenceInventory } from "./evidence-migration-scan.ts";

export async function discoverSchemaEvidenceRefs(
  rootDir: string,
  inventory: WorkspaceEvidenceInventory,
  filesBefore: ReadonlyMap<string, FileFact>,
): Promise<void> {
  for (const relativePath of filesBefore.keys()) {
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      !relativePath.endsWith(".json") ||
      (!normalized.startsWith(".spark/reviews/") && !normalized.includes("/goal-reviews/"))
    ) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(workspacePath(rootDir, relativePath), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    for (const key of ["artifactRef", "reviewArtifactRef"] as const) {
      const sourceRef = (raw as Record<string, unknown>)[key];
      if (typeof sourceRef !== "string") continue;
      if (sourceRef.startsWith("evidence:") && sourceRef.length > "evidence:".length) {
        inventory.evidenceRefs.add(sourceRef);
        continue;
      }
      if (!isArtifactRef(sourceRef) || inventory.mapping.has(sourceRef)) continue;
      if (inventory.artifactRefs.has(sourceRef)) {
        inventory.invalid.push(
          migrationIssue(
            relativePath,
            "artifact_review_evidence_ref",
            `${key} resolves to an Artifact`,
            sourceRef,
          ),
        );
        continue;
      }
      const targetRef = evidenceRefForLegacy(sourceRef);
      if (inventory.evidenceRefs.has(targetRef)) {
        inventory.ambiguous.push(
          migrationIssue(
            relativePath,
            "review_evidence_ref_collision",
            `${key} collides with an existing Evidence ref`,
            targetRef,
          ),
        );
        continue;
      }
      inventory.mapping.set(sourceRef, targetRef);
      inventory.evidenceRefs.add(targetRef);
      inventory.schemaMappings.push({
        fromRef: sourceRef,
        toRef: targetRef,
        kind: "record",
        path: relativePath,
        hash: filesBefore.get(relativePath)?.hash,
      });
      inventory.discovered += 1;
    }
  }
}

export async function planStateFileRewrites(
  rootDir: string,
  inventory: WorkspaceEvidenceInventory,
  filesBefore: ReadonlyMap<string, FileFact>,
  operations: Map<string, PlannedOperation>,
  issues: { dangling: EvidenceMigrationIssue[]; artifactMisclassified: EvidenceMigrationIssue[] },
): Promise<void> {
  for (const relativePath of filesBefore.keys()) {
    if (!relativePath.endsWith(".json")) continue;
    if (
      inventory.artifactMetadataPaths.has(relativePath) ||
      inventory.evidenceMetadataPaths.has(relativePath) ||
      stateScanPathExcluded(relativePath)
    ) {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(workspacePath(rootDir, relativePath), "utf8"));
    } catch (error) {
      inventory.invalid.push(migrationIssue(relativePath, "invalid_json", errorMessage(error)));
      continue;
    }
    const rewritten = rewriteStateRefs(
      raw,
      relativePath,
      inventory.mapping,
      inventory.artifactRefs,
      inventory.evidenceRefs,
      issues,
    );
    if (rewritten.changed > 0) {
      addWriteOperation(
        operations,
        filesBefore,
        relativePath,
        jsonBytes(rewritten.value),
        inventory.ambiguous,
        true,
      );
    }
  }
}
