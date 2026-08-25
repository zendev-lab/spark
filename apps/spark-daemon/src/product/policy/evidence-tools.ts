import { type EvidenceRecord } from "@zendev-lab/spark-artifacts";
import { isRef, type EvidenceRef } from "@zendev-lab/spark-invocation";

export function normalizeEvidenceLimit(value: unknown, fallback: number, field = "limit"): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative integer`);
  return value;
}

export function normalizePositiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number`);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

export function normalizeEvidenceBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function normalizeEvidenceRef(value: unknown): EvidenceRef {
  if (typeof value !== "string") throw new Error("evidenceRef must be a string");
  if (!isRef(value, "evidence")) throw new Error("evidenceRef must be an evidence: ref");
  return value;
}

export function compactEvidenceDetail(evidence: EvidenceRecord) {
  return {
    ref: evidence.ref,
    kind: evidence.kind,
    title: evidence.title,
    format: evidence.format,
    producer: evidence.provenance.producer,
    projectRef: evidence.provenance.projectRef,
    taskRef: evidence.provenance.taskRef,
    roleRef: evidence.provenance.roleRef,
    bodySize: evidence.bodySize,
    bodyTruncated: evidence.bodyTruncated,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
  };
}

export function truncateBlock(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
