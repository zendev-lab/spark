import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  contentHash,
  isEvidenceFormat,
  validateEvidenceRecord,
  type EvidenceFormat,
  type EvidenceRecord,
  type JsonValue,
} from "./index.ts";
import {
  EVIDENCE_METADATA_BODY_PREVIEW_CHARS,
  EVIDENCE_METADATA_BODY_THRESHOLD_BYTES,
  isRecord,
} from "./evidence-migration-types.ts";
import { isEvidenceRef, scopedBlobPath } from "./evidence-migration-paths.ts";
import { rewriteExactRefs } from "./evidence-migration-references.ts";

export async function canonicalStoredEvidenceRecord(options: {
  raw: Record<string, unknown>;
  storeRoot: string;
  targetRef: string;
  canonicalKind: string;
  mapping: ReadonlyMap<string, string>;
}): Promise<{ metadata: EvidenceRecord; serializedBody: string; blobPath: string }> {
  if (!isEvidenceRef(options.targetRef)) throw new Error("target ref must use evidence:");
  const format = options.raw.format;
  if (!isEvidenceFormat(format)) throw new Error(`invalid evidence format: ${String(format)}`);
  const fullBody = await readFullEvidenceBody(options.raw, options.storeRoot, format);
  const rewrittenBody = rewriteExactRefs(fullBody, options.mapping).value as JsonValue | string;
  const rewritten = rewriteExactRefs({ ...options.raw, body: rewrittenBody }, options.mapping)
    .value as Record<string, unknown>;
  const provenance = isRecord(rewritten.provenance)
    ? { ...rewritten.provenance }
    : rewritten.provenance;
  if (isRecord(provenance) && Object.hasOwn(provenance, "parentArtifactRefs")) {
    if (Object.hasOwn(provenance, "parentEvidenceRefs")) {
      throw new Error("provenance contains canonical and legacy parent evidence fields");
    }
    provenance.parentEvidenceRefs = provenance.parentArtifactRefs;
    delete provenance.parentArtifactRefs;
  }
  const serializedBody = serializeEvidenceBody(format, rewrittenBody);
  const hash = contentHash(serializedBody);
  const blobPath = join("blobs", `${hash}.${extensionForEvidenceFormat(format)}`);
  const truncated =
    Buffer.byteLength(serializedBody, "utf8") > EVIDENCE_METADATA_BODY_THRESHOLD_BYTES;
  const metadata: Record<string, unknown> = {
    ...rewritten,
    ref: options.targetRef,
    kind: options.canonicalKind,
    body: truncated ? previewBody(serializedBody) : rewrittenBody,
    hash,
    blobPath,
    provenance,
  };
  if (truncated) {
    metadata.bodyPreview = previewBody(serializedBody);
    metadata.bodySize = Buffer.byteLength(serializedBody, "utf8");
    metadata.bodyTruncated = true;
  } else {
    delete metadata.bodyPreview;
    delete metadata.bodySize;
    delete metadata.bodyTruncated;
  }
  validateEvidenceRecord(metadata);
  return { metadata, serializedBody, blobPath };
}

async function readFullEvidenceBody(
  raw: Record<string, unknown>,
  storeRoot: string,
  format: EvidenceFormat,
): Promise<JsonValue | string> {
  let serialized: string;
  if (typeof raw.blobPath === "string") {
    const blob = scopedBlobPath(storeRoot, raw.blobPath);
    if (!blob) throw new Error("evidence blob path escapes store");
    serialized = await readFile(blob, "utf8");
  } else {
    if (raw.bodyTruncated === true) throw new Error("truncated evidence body has no blobPath");
    if (!isJsonValue(raw.body)) throw new Error("evidence body must be a JSON value");
    serialized = serializeEvidenceBody(format, raw.body);
  }
  if (typeof raw.hash === "string" && contentHash(serialized) !== raw.hash) {
    throw new Error("evidence body hash does not match metadata");
  }
  if (format !== "json") return serialized;
  try {
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new Error(
      `invalid JSON evidence blob: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function previewBody(serialized: string): string {
  return serialized.length > EVIDENCE_METADATA_BODY_PREVIEW_CHARS
    ? `${serialized.slice(0, EVIDENCE_METADATA_BODY_PREVIEW_CHARS)}\n… truncated ${serialized.length - EVIDENCE_METADATA_BODY_PREVIEW_CHARS} char(s)`
    : serialized;
}

function serializeEvidenceBody(format: EvidenceFormat, body: JsonValue | string): string {
  if (typeof body === "string") return body;
  if (format === "json") return JSON.stringify(body, null, 2);
  return JSON.stringify(body, null, 2);
}

function extensionForEvidenceFormat(format: EvidenceFormat): string {
  if (format === "markdown") return "md";
  if (format === "text") return "txt";
  return "json";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}
