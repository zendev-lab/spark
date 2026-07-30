import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "./artifact/store.ts";
import { isArtifactKind, type ArtifactRef } from "./artifact/types.ts";
import {
  errorMessage,
  isRecord,
  migrationIssue,
  type EvidenceMigrationIssue,
} from "./evidence-migration-types.ts";
import {
  hashBytes,
  isArtifactRef,
  jsonMetadataEntries,
  metadataFilenameMatchesRef,
  relativeWorkspacePath,
  scopedBlobPath,
  stringValue,
} from "./evidence-migration-paths.ts";

export interface ArtifactScanInventory {
  mapping: ReadonlyMap<string, string>;
  artifactRefs: Set<string>;
  artifactPaths: Set<string>;
  invalid: EvidenceMigrationIssue[];
  ambiguous: EvidenceMigrationIssue[];
  artifactPreserved: number;
}

export async function scanArtifactRecord(options: {
  rootDir: string;
  artifactRoot: string;
  filename: string;
  path: string;
  raw: Record<string, unknown>;
  inventory: ArtifactScanInventory;
}): Promise<void> {
  const ref = stringValue(options.raw.ref);
  if (!ref || !isArtifactRef(ref)) {
    options.inventory.invalid.push(
      migrationIssue(options.path, "invalid_artifact_ref", "artifact ref must use artifact:"),
    );
    return;
  }
  if (!metadataFilenameMatchesRef(options.filename, ref)) {
    options.inventory.invalid.push(
      migrationIssue(
        options.path,
        "artifact_ref_path_mismatch",
        "artifact filename does not match ref",
        ref,
      ),
    );
    return;
  }
  if (options.inventory.mapping.has(ref) || options.inventory.artifactRefs.has(ref)) {
    options.inventory.ambiguous.push(
      migrationIssue(options.path, "duplicate_ref", "duplicate artifact ref", ref),
    );
    return;
  }
  try {
    const store = new ArtifactStore({ rootDir: options.artifactRoot });
    const artifact = await store.get(ref as ArtifactRef);
    await verifyDeclaredBlob(options.artifactRoot, options.raw, artifact.hash, options.path);
    options.inventory.artifactRefs.add(ref);
    options.inventory.artifactPreserved += 1;
    options.inventory.artifactPaths.add(options.path);
    if (typeof options.raw.blobPath === "string") {
      const blob = scopedBlobPath(options.artifactRoot, options.raw.blobPath);
      if (!blob) throw new Error("Artifact blob path escapes artifact store");
      options.inventory.artifactPaths.add(relativeWorkspacePath(options.rootDir, blob));
    }
  } catch (error) {
    options.inventory.invalid.push(
      migrationIssue(options.path, "invalid_artifact", errorMessage(error), ref),
    );
  }
}

export async function artifactPathsForWorkspace(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  const artifactRoot = join(rootDir, ".spark", "artifacts");
  for (const entry of await jsonMetadataEntries(artifactRoot)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(entry.path, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(raw) || !isArtifactKind(raw.kind)) continue;
    paths.add(relativeWorkspacePath(rootDir, entry.path));
    if (typeof raw.blobPath === "string") {
      const blob = scopedBlobPath(artifactRoot, raw.blobPath);
      if (blob) paths.add(relativeWorkspacePath(rootDir, blob));
    }
  }
  return paths;
}

async function verifyDeclaredBlob(
  rootDir: string,
  raw: Record<string, unknown>,
  normalizedHash: string | undefined,
  relativePath: string,
): Promise<void> {
  if (typeof raw.blobPath !== "string") return;
  const path = scopedBlobPath(rootDir, raw.blobPath);
  if (!path) throw new Error(`${relativePath}: blob path escapes store`);
  const actual = hashBytes(await readFile(path));
  const declared = stringValue(raw.hash) ?? normalizedHash;
  if (declared && declared !== actual)
    throw new Error(`${relativePath}: Artifact blob hash mismatch`);
}
