import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductArtifactStore } from "./product/store.ts";
import { isProductArtifactKind, type ProductArtifactRef } from "./product/types.ts";
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

export interface ProductScanInventory {
  mapping: ReadonlyMap<string, string>;
  productRefs: Set<string>;
  productPaths: Set<string>;
  invalid: EvidenceMigrationIssue[];
  ambiguous: EvidenceMigrationIssue[];
  productPreserved: number;
}

export async function scanProductArtifactRecord(options: {
  rootDir: string;
  artifactRoot: string;
  filename: string;
  path: string;
  raw: Record<string, unknown>;
  inventory: ProductScanInventory;
}): Promise<void> {
  const ref = stringValue(options.raw.ref);
  if (!ref || !isArtifactRef(ref)) {
    options.inventory.invalid.push(
      migrationIssue(
        options.path,
        "invalid_product_ref",
        "product artifact ref must use artifact:",
      ),
    );
    return;
  }
  if (!metadataFilenameMatchesRef(options.filename, ref)) {
    options.inventory.invalid.push(
      migrationIssue(
        options.path,
        "product_ref_path_mismatch",
        "product artifact filename does not match ref",
        ref,
      ),
    );
    return;
  }
  if (options.inventory.mapping.has(ref) || options.inventory.productRefs.has(ref)) {
    options.inventory.ambiguous.push(
      migrationIssue(options.path, "duplicate_ref", "duplicate artifact ref", ref),
    );
    return;
  }
  try {
    const store = new ProductArtifactStore({ rootDir: options.artifactRoot });
    const product = await store.get(ref as ProductArtifactRef);
    await verifyDeclaredBlob(options.artifactRoot, options.raw, product.hash, options.path);
    options.inventory.productRefs.add(ref);
    options.inventory.productPreserved += 1;
    options.inventory.productPaths.add(options.path);
    if (typeof options.raw.blobPath === "string") {
      const blob = scopedBlobPath(options.artifactRoot, options.raw.blobPath);
      if (!blob) throw new Error("product blob path escapes artifact store");
      options.inventory.productPaths.add(relativeWorkspacePath(options.rootDir, blob));
    }
  } catch (error) {
    options.inventory.invalid.push(
      migrationIssue(options.path, "invalid_product", errorMessage(error), ref),
    );
  }
}

export async function productPathsForWorkspace(rootDir: string): Promise<Set<string>> {
  const paths = new Set<string>();
  const artifactRoot = join(rootDir, ".spark", "artifacts");
  for (const entry of await jsonMetadataEntries(artifactRoot)) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(entry.path, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(raw) || !isProductArtifactKind(raw.kind)) continue;
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
    throw new Error(`${relativePath}: product blob hash mismatch`);
}
