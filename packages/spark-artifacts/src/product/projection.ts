import { createHash } from "node:crypto";

import type {
  PreviewContentFormat,
  PreviewProgress,
  ProductArtifact,
  ProductArtifactBody,
  ProductArtifactRef,
} from "./types.ts";

/** Keep Product Artifact projections within Cockpit's inline-preview budget. */
export const PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES = 256 * 1024;

/** Coarse transport formats accepted by the daemon/Cockpit projection spine. */
export type ProductArtifactProjectionFormat = "markdown" | "json" | "text" | "blob";

/**
 * A content-addressed, bounded pointer to the Product Artifact body.
 *
 * The canonical body remains in the Product Artifact store. Inline fields are
 * an optional transport optimization and are omitted once they exceed the
 * projection budget.
 */
export interface ProductArtifactProjectionContentRef {
  productArtifactRef: ProductArtifactRef;
  inlineJson?: Record<string, unknown>;
  inlineMarkdown?: string;
  inlineText?: string;
  previewFormat?: PreviewContentFormat;
  version?: number;
  progress?: PreviewProgress | null;
}

export interface ProductArtifactProjection {
  schemaVersion: 1;
  format: ProductArtifactProjectionFormat;
  mime: string;
  sizeBytes: number;
  hash: string;
  contentRef: ProductArtifactProjectionContentRef;
}

/**
 * Convert a canonical Product Artifact into the bounded transport contract
 * consumed by daemon and Cockpit projections.
 */
export function projectProductArtifact(artifact: ProductArtifact): ProductArtifactProjection {
  if (artifact.body.kind === "preview") {
    const content = artifact.body.content;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const isMarkdown = artifact.body.format === "md";
    return {
      schemaVersion: 1,
      format: isMarkdown ? "markdown" : "text",
      mime: isMarkdown ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
      sizeBytes,
      hash: sha256(content),
      contentRef: {
        productArtifactRef: artifact.ref,
        previewFormat: artifact.body.format,
        version: artifact.body.version,
        progress: artifact.body.progress ?? null,
        ...(sizeBytes <= PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES
          ? isMarkdown
            ? { inlineMarkdown: content }
            : { inlineText: content }
          : {}),
      },
    };
  }

  // Cockpit renders inline JSON with a trailing newline. Include it in the
  // budget/size calculation so a projection accepted here cannot overflow
  // while being materialized there.
  const canonicalBody = serializeBody(artifact.body);
  const previewJson = `${canonicalBody}\n`;
  const sizeBytes = Buffer.byteLength(previewJson, "utf8");
  return {
    schemaVersion: 1,
    format: "json",
    mime: "application/json",
    sizeBytes,
    hash: sha256(previewJson),
    contentRef: {
      productArtifactRef: artifact.ref,
      ...(sizeBytes <= PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES
        ? { inlineJson: JSON.parse(canonicalBody) as Record<string, unknown> }
        : {}),
    },
  };
}

function serializeBody(body: ProductArtifactBody): string {
  return JSON.stringify(body, null, 2);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
