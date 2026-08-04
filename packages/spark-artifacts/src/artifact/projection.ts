import { createHash } from "node:crypto";

import type {
  Artifact,
  ArtifactBody,
  ArtifactProgress,
  ArtifactRef,
  PreviewContentFormat,
} from "./types.ts";

/** Keep Artifact projections within Cockpit's inline-preview budget. */
export const ARTIFACT_PROJECTION_MAX_INLINE_BYTES = 256 * 1024;

/** Coarse transport formats accepted by the daemon/Cockpit projection spine. */
export type ArtifactProjectionFormat = "markdown" | "json" | "text" | "blob";

/**
 * A content-addressed, bounded pointer to the Artifact body.
 *
 * The canonical body remains in the Artifact store. Inline fields are
 * an optional transport optimization and are omitted once they exceed the
 * projection budget.
 */
export interface ArtifactProjectionContentRef {
  artifactRef: ArtifactRef;
  inlineJson?: Record<string, unknown>;
  inlineMarkdown?: string;
  inlineText?: string;
  mediaType?: string;
  revision?: number;
  previewFormat?: PreviewContentFormat;
  version?: number;
  progress?: ArtifactProgress | null;
}

export interface ArtifactProjection {
  schemaVersion: 1;
  format: ArtifactProjectionFormat;
  mime: string;
  sizeBytes: number;
  hash: string;
  contentRef: ArtifactProjectionContentRef;
}

/**
 * Convert a canonical Artifact into the bounded transport contract
 * consumed by daemon and Cockpit projections.
 */
export function projectArtifact(artifact: Artifact): ArtifactProjection {
  if (artifact.body.kind === "document") {
    const content = artifact.body.content;
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const isMarkdown = artifact.body.mediaType === "text/markdown";
    return {
      schemaVersion: 1,
      format: isMarkdown ? "markdown" : "text",
      mime: artifact.body.mediaType,
      sizeBytes,
      hash: sha256(content),
      contentRef: {
        artifactRef: artifact.ref,
        mediaType: artifact.body.mediaType,
        revision: artifact.body.revision,
        previewFormat: compatibilityPreviewFormat(artifact.body.mediaType),
        version: artifact.body.revision,
        progress: artifact.body.progress ?? null,
        ...(sizeBytes <= ARTIFACT_PROJECTION_MAX_INLINE_BYTES
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
      artifactRef: artifact.ref,
      ...(sizeBytes <= ARTIFACT_PROJECTION_MAX_INLINE_BYTES
        ? { inlineJson: JSON.parse(canonicalBody) as Record<string, unknown> }
        : {}),
    },
  };
}

function compatibilityPreviewFormat(mediaType: string): PreviewContentFormat | undefined {
  switch (mediaType) {
    case "text/markdown":
      return "md";
    case "text/mdx":
      return "mdx";
    case "text/html":
      return "html";
    case "application/vnd.a2ui+json":
      return "a2ui";
    default:
      return undefined;
  }
}

function serializeBody(body: ArtifactBody): string {
  return JSON.stringify(body, null, 2);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
