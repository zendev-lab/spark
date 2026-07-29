import { join } from "node:path";
import { canonicalEvidenceKindForPersistedKind } from "./index.ts";
import { isProductArtifactKind } from "./product/types.ts";
import { migrationIssue, type EvidenceMigrationIssue } from "./evidence-migration-types.ts";
import { scanProductArtifactRecord } from "./evidence-migration-product.ts";
import {
  evidenceRefForLegacy,
  isArtifactRef,
  isEvidenceRef,
  jsonMetadataEntries,
  metadataFilenameMatchesRef,
  readJsonObject,
  refId,
  relativeWorkspacePath,
  stringValue,
} from "./evidence-migration-paths.ts";

export interface LegacyEvidenceSource {
  path: string;
  raw: Record<string, unknown>;
  canonicalKind: string;
  storeRoot: string;
  destinationStoreRoot: string;
  destinationPath: string;
  deleteSource: boolean;
}

export interface CanonicalEvidenceSource {
  path: string;
  raw: Record<string, unknown>;
  storeRoot: string;
}

export interface WorkspaceEvidenceInventory {
  mapping: Map<string, string>;
  productRefs: Set<string>;
  evidenceRefs: Set<string>;
  productPaths: Set<string>;
  artifactMetadataPaths: Set<string>;
  evidenceMetadataPaths: Set<string>;
  legacyRecords: LegacyEvidenceSource[];
  canonicalRecords: CanonicalEvidenceSource[];
  schemaMappings: Array<{
    fromRef: string;
    toRef: string;
    kind: string;
    path: string;
    hash?: string;
  }>;
  invalid: EvidenceMigrationIssue[];
  ambiguous: EvidenceMigrationIssue[];
  discovered: number;
  productPreserved: number;
}

export async function scanWorkspaceEvidenceStores(
  rootDir: string,
): Promise<WorkspaceEvidenceInventory> {
  const inventory: WorkspaceEvidenceInventory = {
    mapping: new Map(),
    productRefs: new Set(),
    evidenceRefs: new Set(),
    productPaths: new Set(),
    artifactMetadataPaths: new Set(),
    evidenceMetadataPaths: new Set(),
    legacyRecords: [],
    canonicalRecords: [],
    schemaMappings: [],
    invalid: [],
    ambiguous: [],
    discovered: 0,
    productPreserved: 0,
  };
  const artifactRoot = join(rootDir, ".spark", "artifacts");
  const evidenceRoot = join(rootDir, ".spark", "evidence");
  const learningRoot = join(rootDir, ".spark", "memory", "learnings");
  await scanLegacyArtifactStore(rootDir, artifactRoot, evidenceRoot, inventory);
  await scanLearningStore(rootDir, learningRoot, inventory);
  await scanCanonicalEvidenceStore(rootDir, evidenceRoot, inventory);
  return inventory;
}

async function scanLegacyArtifactStore(
  rootDir: string,
  artifactRoot: string,
  evidenceRoot: string,
  inventory: WorkspaceEvidenceInventory,
): Promise<void> {
  for (const entry of await jsonMetadataEntries(artifactRoot)) {
    const path = relativeWorkspacePath(rootDir, entry.path);
    inventory.artifactMetadataPaths.add(path);
    inventory.discovered += 1;
    const raw = await readJsonObject(entry.path, inventory.invalid, path);
    if (!raw) continue;
    const canonicalKind = canonicalEvidenceKindForPersistedKind(raw.kind);
    if (isProductArtifactKind(raw.kind)) {
      await scanProductArtifactRecord({
        rootDir,
        artifactRoot,
        filename: entry.name,
        path,
        raw,
        inventory,
      });
      continue;
    }
    if (!canonicalKind) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "unknown_kind",
          `metadata kind is not evidence or product: ${String(raw.kind)}`,
        ),
      );
      continue;
    }
    const ref = stringValue(raw.ref);
    if (!ref || !isArtifactRef(ref)) {
      inventory.invalid.push(
        migrationIssue(path, "invalid_legacy_ref", "legacy evidence ref must use artifact:"),
      );
      continue;
    }
    if (!metadataFilenameMatchesRef(entry.name, ref)) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "legacy_ref_path_mismatch",
          "legacy evidence filename does not match ref",
          ref,
        ),
      );
      continue;
    }
    if (inventory.mapping.has(ref) || inventory.productRefs.has(ref)) {
      inventory.ambiguous.push(
        migrationIssue(path, "duplicate_ref", "duplicate or cross-kind artifact ref", ref),
      );
      continue;
    }
    const target = evidenceRefForLegacy(ref);
    inventory.mapping.set(ref, target);
    inventory.evidenceRefs.add(target);
    inventory.legacyRecords.push({
      path,
      raw,
      canonicalKind,
      storeRoot: artifactRoot,
      destinationStoreRoot: evidenceRoot,
      destinationPath: join(".spark", "evidence", `${refId(target)}.json`),
      deleteSource: true,
    });
  }
}

async function scanLearningStore(
  rootDir: string,
  learningRoot: string,
  inventory: WorkspaceEvidenceInventory,
): Promise<void> {
  for (const entry of await jsonMetadataEntries(learningRoot)) {
    const path = relativeWorkspacePath(rootDir, entry.path);
    inventory.evidenceMetadataPaths.add(path);
    inventory.discovered += 1;
    const raw = await readJsonObject(entry.path, inventory.invalid, path);
    if (!raw) continue;
    const canonicalKind = canonicalEvidenceKindForPersistedKind(raw.kind);
    if (!canonicalKind || isProductArtifactKind(raw.kind)) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "invalid_learning_kind",
          "learning metadata must use an Evidence kind",
        ),
      );
      continue;
    }
    const ref = stringValue(raw.ref);
    if (!ref || (!isArtifactRef(ref) && !isEvidenceRef(ref))) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "invalid_learning_ref",
          "learning Evidence ref must use artifact: or evidence:",
        ),
      );
      continue;
    }
    if (!metadataFilenameMatchesRef(entry.name, ref)) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "learning_ref_path_mismatch",
          "learning filename does not match ref",
          ref,
        ),
      );
      continue;
    }
    if (isArtifactRef(ref))
      addLegacyLearning(path, raw, canonicalKind, learningRoot, ref, inventory);
    else addCanonicalLearning(path, raw, learningRoot, ref, inventory);
  }
}

function addLegacyLearning(
  path: string,
  raw: Record<string, unknown>,
  canonicalKind: string,
  learningRoot: string,
  ref: string,
  inventory: WorkspaceEvidenceInventory,
): void {
  if (inventory.mapping.has(ref) || inventory.productRefs.has(ref)) {
    inventory.ambiguous.push(
      migrationIssue(path, "duplicate_ref", "duplicate or cross-kind artifact ref", ref),
    );
    return;
  }
  const target = evidenceRefForLegacy(ref);
  if (inventory.evidenceRefs.has(target)) {
    inventory.ambiguous.push(
      migrationIssue(
        path,
        "destination_collision",
        "learning Evidence target already exists",
        target,
      ),
    );
    return;
  }
  inventory.mapping.set(ref, target);
  inventory.evidenceRefs.add(target);
  inventory.legacyRecords.push({
    path,
    raw,
    canonicalKind,
    storeRoot: learningRoot,
    destinationStoreRoot: learningRoot,
    destinationPath: path,
    deleteSource: false,
  });
}

function addCanonicalLearning(
  path: string,
  raw: Record<string, unknown>,
  learningRoot: string,
  ref: string,
  inventory: WorkspaceEvidenceInventory,
): void {
  if (inventory.evidenceRefs.has(ref)) {
    inventory.ambiguous.push(migrationIssue(path, "duplicate_ref", "duplicate Evidence ref", ref));
    return;
  }
  inventory.evidenceRefs.add(ref);
  inventory.canonicalRecords.push({ path, raw, storeRoot: learningRoot });
}

async function scanCanonicalEvidenceStore(
  rootDir: string,
  evidenceRoot: string,
  inventory: WorkspaceEvidenceInventory,
): Promise<void> {
  for (const entry of await jsonMetadataEntries(evidenceRoot)) {
    const path = relativeWorkspacePath(rootDir, entry.path);
    inventory.evidenceMetadataPaths.add(path);
    const raw = await readJsonObject(entry.path, inventory.invalid, path);
    if (!raw) continue;
    const ref = stringValue(raw.ref);
    if (!ref || !isEvidenceRef(ref)) {
      inventory.invalid.push(
        migrationIssue(path, "invalid_evidence_ref", "evidence metadata ref must use evidence:"),
      );
      continue;
    }
    if (!metadataFilenameMatchesRef(entry.name, ref)) {
      inventory.invalid.push(
        migrationIssue(
          path,
          "evidence_ref_path_mismatch",
          "evidence filename does not match ref",
          ref,
        ),
      );
      continue;
    }
    if (inventory.evidenceRefs.has(ref)) {
      inventory.ambiguous.push(
        migrationIssue(path, "destination_collision", "legacy evidence target already exists", ref),
      );
    }
    inventory.evidenceRefs.add(ref);
    inventory.canonicalRecords.push({ path, raw, storeRoot: evidenceRoot });
  }
}
