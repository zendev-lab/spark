import { createHash } from "node:crypto";

import type { JsonValue } from "@zendev-lab/spark-invocation";

export const MEMORY_LIFECYCLE_SCHEMA_VERSION = 2 as const;

export type MemoryContentKind = "episodic" | "semantic" | "procedural" | "preference" | "unknown";
export type MemoryLifecycleState =
  | "candidate"
  | "promoted"
  | "rejected"
  | "forgotten"
  | "stale"
  | "merged"
  | "superseded"
  | "quarantined";
export type MemoryLifecycleScope = "user" | "workspace" | "repo" | "project" | "agent";
export type MemoryRisk = "normal" | "behavior_changing" | "sensitive";
export type MemorySourceKind =
  | "user_intent"
  | "canonical_ask"
  | "evidence"
  | "compaction"
  | "task"
  | "import"
  | "legacy"
  | "unknown";
export type MemoryApprovalStatus = "verified" | "not_required" | "legacy_unverified";

export interface MemoryProvenance extends Record<string, JsonValue> {
  sourceKind: MemorySourceKind;
  evidenceRefs: string[];
  sourceRefs: string[];
  sourceDigest: string | null;
  capturedAt: string;
  capturedBy: string | null;
  extractionMethod: string | null;
  extractionModel: string | null;
  legacyUnverified: boolean;
}

export interface MemoryRevision extends Record<string, JsonValue> {
  version: number;
  revisionRef: string;
  contentDigest: string;
  createdAt: string;
  predecessorRefs: string[];
  transactionId: string | null;
  proposalDigest: string | null;
  proofRef: string | null;
}

export interface MemoryLineage extends Record<string, JsonValue> {
  predecessors: string[];
  mergedFrom: string[];
  mergedInto: string[];
  supersedes: string[];
  supersededBy: string[];
}

export interface MemoryExpiry extends Record<string, JsonValue> {
  expiresAt: string | null;
  visibility: "visible" | "expired";
  purgeAfter: string | null;
}

export interface MemoryApprovalBinding extends Record<string, JsonValue> {
  status: MemoryApprovalStatus;
  proofRef: string | null;
  proposalDigest: string | null;
  approvedAt: string | null;
  actorKind: "user" | "system" | "unknown";
}

export interface MemoryLifecycleEnvelope extends Record<string, JsonValue> {
  schemaVersion: typeof MEMORY_LIFECYCLE_SCHEMA_VERSION;
  kind: MemoryContentKind;
  state: MemoryLifecycleState;
  scope: MemoryLifecycleScope;
  risk: MemoryRisk;
  provenance: MemoryProvenance;
  revision: MemoryRevision;
  revisionHistory: MemoryRevision[];
  lineage: MemoryLineage;
  expiry: MemoryExpiry;
  approval: MemoryApprovalBinding;
}

export interface MemoryLifecycleInput {
  recordRef: string;
  kind?: MemoryContentKind;
  state: MemoryLifecycleState;
  scope: MemoryLifecycleScope;
  risk?: MemoryRisk;
  evidenceRefs?: readonly string[];
  sourceRefs?: readonly string[];
  sourceDigest?: string | null;
  sourceKind?: MemorySourceKind;
  capturedAt: string;
  capturedBy?: string | null;
  extractionMethod?: string | null;
  extractionModel?: string | null;
  legacyUnverified?: boolean;
  approvalStatus?: MemoryApprovalStatus;
  content: unknown;
  supersedes?: readonly string[];
  supersededBy?: readonly string[];
}

export type LegacyMemoryLifecycleInput = Omit<
  MemoryLifecycleInput,
  | "sourceKind"
  | "capturedBy"
  | "extractionMethod"
  | "extractionModel"
  | "legacyUnverified"
  | "approvalStatus"
>;

const MEMORY_CONTENT_KINDS: readonly MemoryContentKind[] = [
  "episodic",
  "semantic",
  "procedural",
  "preference",
  "unknown",
];
const MEMORY_LIFECYCLE_STATES: readonly MemoryLifecycleState[] = [
  "candidate",
  "promoted",
  "rejected",
  "forgotten",
  "stale",
  "merged",
  "superseded",
  "quarantined",
];
const MEMORY_LIFECYCLE_SCOPES: readonly MemoryLifecycleScope[] = [
  "user",
  "workspace",
  "repo",
  "project",
  "agent",
];
const MEMORY_RISKS: readonly MemoryRisk[] = ["normal", "behavior_changing", "sensitive"];
const MEMORY_SOURCE_KINDS: readonly MemorySourceKind[] = [
  "user_intent",
  "canonical_ask",
  "evidence",
  "compaction",
  "task",
  "import",
  "legacy",
  "unknown",
];
const MEMORY_APPROVAL_STATUSES: readonly MemoryApprovalStatus[] = [
  "verified",
  "not_required",
  "legacy_unverified",
];

export function createMemoryLifecycle(input: MemoryLifecycleInput): MemoryLifecycleEnvelope {
  const recordRef = requiredString(input.recordRef, "recordRef");
  const capturedAt = requiredString(input.capturedAt, "capturedAt");
  const approvalStatus = input.approvalStatus ?? "legacy_unverified";
  const lifecycle: MemoryLifecycleEnvelope = {
    schemaVersion: MEMORY_LIFECYCLE_SCHEMA_VERSION,
    kind: input.kind ?? "unknown",
    state: input.state,
    scope: input.scope,
    risk: input.risk ?? "normal",
    provenance: {
      sourceKind: input.sourceKind ?? "unknown",
      evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
      sourceRefs: uniqueStrings(input.sourceRefs ?? []),
      sourceDigest: input.sourceDigest?.trim() || null,
      capturedAt,
      capturedBy: input.capturedBy?.trim() || null,
      extractionMethod: input.extractionMethod?.trim() || null,
      extractionModel: input.extractionModel?.trim() || null,
      legacyUnverified: input.legacyUnverified ?? approvalStatus === "legacy_unverified",
    },
    revision: {
      version: 1,
      revisionRef: `${recordRef}:revision:1`,
      contentDigest: memoryContentDigest(input.content),
      createdAt: capturedAt,
      predecessorRefs: [],
      transactionId: null,
      proposalDigest: null,
      proofRef: null,
    },
    revisionHistory: [],
    lineage: {
      predecessors: [],
      mergedFrom: [],
      mergedInto: [],
      supersedes: uniqueStrings(input.supersedes ?? []),
      supersededBy: uniqueStrings(input.supersededBy ?? []),
    },
    expiry: { expiresAt: null, visibility: "visible", purgeAfter: null },
    approval: {
      status: approvalStatus,
      proofRef: null,
      proposalDigest: null,
      approvedAt: null,
      actorKind: approvalStatus === "not_required" ? "system" : "unknown",
    },
  };
  lifecycle.revisionHistory = [lifecycle.revision];
  return lifecycle;
}

export function createLegacyMemoryLifecycle(
  input: LegacyMemoryLifecycleInput,
): MemoryLifecycleEnvelope {
  return createMemoryLifecycle({
    ...input,
    sourceKind: "legacy",
    legacyUnverified: true,
    approvalStatus: "legacy_unverified",
  });
}

export function normalizeMemoryLifecycle(
  value: unknown,
  fallback: MemoryLifecycleInput,
): MemoryLifecycleEnvelope {
  if (value === undefined || value === null) return createMemoryLifecycle(fallback);
  const lifecycle = normalizeRevisionContract(value);
  validateMemoryLifecycle(lifecycle);
  return lifecycle;
}

function normalizeRevisionContract(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const lifecycle = structuredClone(value) as Record<string, unknown>;
  const revision = lifecycle.revision;
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) return lifecycle;
  const normalizedRevision = revision as Record<string, unknown>;
  normalizedRevision.transactionId ??= null;
  normalizedRevision.proposalDigest ??= null;
  normalizedRevision.proofRef ??= null;
  lifecycle.revisionHistory ??= [structuredClone(normalizedRevision)];
  const lineage = lifecycle.lineage;
  if (lineage && typeof lineage === "object" && !Array.isArray(lineage)) {
    (lineage as Record<string, unknown>).mergedInto ??= [];
  }
  return lifecycle;
}

export function assertMemoryLifecycleProjection(
  lifecycle: MemoryLifecycleEnvelope,
  expected: { state: MemoryLifecycleState; scope: MemoryLifecycleScope },
  label = "memory lifecycle",
): void {
  if (lifecycle.state !== expected.state) {
    throw new Error(`${label}.state must be ${expected.state}, received ${lifecycle.state}`);
  }
  if (lifecycle.scope !== expected.scope) {
    throw new Error(`${label}.scope must be ${expected.scope}, received ${lifecycle.scope}`);
  }
}

export function validateMemoryLifecycle(
  value: unknown,
  label = "memory lifecycle",
): asserts value is MemoryLifecycleEnvelope {
  const lifecycle = recordValue(value, label);
  if (lifecycle.schemaVersion !== MEMORY_LIFECYCLE_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${MEMORY_LIFECYCLE_SCHEMA_VERSION}`);
  }
  assertEnum(lifecycle.kind, MEMORY_CONTENT_KINDS, `${label}.kind`);
  assertEnum(lifecycle.state, MEMORY_LIFECYCLE_STATES, `${label}.state`);
  assertEnum(lifecycle.scope, MEMORY_LIFECYCLE_SCOPES, `${label}.scope`);
  assertEnum(lifecycle.risk, MEMORY_RISKS, `${label}.risk`);

  const provenance = recordValue(lifecycle.provenance, `${label}.provenance`);
  assertEnum(provenance.sourceKind, MEMORY_SOURCE_KINDS, `${label}.provenance.sourceKind`);
  assertStringArray(provenance.evidenceRefs, `${label}.provenance.evidenceRefs`);
  assertStringArray(provenance.sourceRefs, `${label}.provenance.sourceRefs`);
  assertNullableString(provenance.sourceDigest, `${label}.provenance.sourceDigest`);
  assertString(provenance.capturedAt, `${label}.provenance.capturedAt`);
  assertNullableString(provenance.capturedBy, `${label}.provenance.capturedBy`);
  assertNullableString(provenance.extractionMethod, `${label}.provenance.extractionMethod`);
  assertNullableString(provenance.extractionModel, `${label}.provenance.extractionModel`);
  if (typeof provenance.legacyUnverified !== "boolean") {
    throw new Error(`${label}.provenance.legacyUnverified must be a boolean`);
  }

  const revision = recordValue(lifecycle.revision, `${label}.revision`);
  validateMemoryRevision(revision, `${label}.revision`);
  if (lifecycle.revisionHistory !== undefined) {
    if (!Array.isArray(lifecycle.revisionHistory) || lifecycle.revisionHistory.length === 0) {
      throw new Error(`${label}.revisionHistory must be a non-empty array when present`);
    }
    const seenRevisionRefs = new Set<string>();
    lifecycle.revisionHistory.forEach((item, index) => {
      const revisionValue = recordValue(item, `${label}.revisionHistory[${index}]`);
      validateMemoryRevision(revisionValue, `${label}.revisionHistory[${index}]`);
      const revision = revisionValue as unknown as MemoryRevision;
      if (seenRevisionRefs.has(revision.revisionRef)) {
        throw new Error(
          `${label}.revisionHistory contains duplicate revisionRef ${revision.revisionRef}`,
        );
      }
      seenRevisionRefs.add(revision.revisionRef);
      if (revision.version !== index + 1) {
        throw new Error(`${label}.revisionHistory[${index}].version must be ${index + 1}`);
      }
      if (index > 0) {
        const predecessor = recordValue(
          (lifecycle.revisionHistory as unknown[])[index - 1],
          `${label}.revisionHistory[${index - 1}]`,
        ) as unknown as MemoryRevision;
        if (!revision.predecessorRefs.includes(predecessor.revisionRef)) {
          throw new Error(
            `${label}.revisionHistory[${index}] must reference predecessor ${predecessor.revisionRef}`,
          );
        }
      }
      if (
        revision.transactionId !== null &&
        !revision.transactionId.startsWith("system:") &&
        revision.proofRef === null
      ) {
        throw new Error(
          `${label}.revisionHistory[${index}] must bind transactionId and proofRef together`,
        );
      }
      if (
        revision.transactionId !== null &&
        !revision.transactionId.startsWith("system:") &&
        revision.proposalDigest === null
      ) {
        throw new Error(
          `${label}.revisionHistory[${index}] must bind proposalDigest with its approval proof`,
        );
      }
    });
    const latest = lifecycle.revisionHistory.at(-1)!;
    if (
      latest.revisionRef !== revision.revisionRef ||
      latest.version !== revision.version ||
      latest.contentDigest !== revision.contentDigest ||
      latest.transactionId !== revision.transactionId ||
      latest.proposalDigest !== revision.proposalDigest ||
      latest.proofRef !== revision.proofRef
    ) {
      throw new Error(`${label}.revisionHistory must end at the current revision`);
    }
  }

  const lineage = recordValue(lifecycle.lineage, `${label}.lineage`);
  assertStringArray(lineage.predecessors, `${label}.lineage.predecessors`);
  assertStringArray(lineage.mergedFrom, `${label}.lineage.mergedFrom`);
  assertStringArray(lineage.mergedInto, `${label}.lineage.mergedInto`);
  assertStringArray(lineage.supersedes, `${label}.lineage.supersedes`);
  assertStringArray(lineage.supersededBy, `${label}.lineage.supersededBy`);

  const expiry = recordValue(lifecycle.expiry, `${label}.expiry`);
  assertNullableString(expiry.expiresAt, `${label}.expiry.expiresAt`);
  assertEnum(expiry.visibility, ["visible", "expired"] as const, `${label}.expiry.visibility`);
  assertNullableString(expiry.purgeAfter, `${label}.expiry.purgeAfter`);

  const approval = recordValue(lifecycle.approval, `${label}.approval`);
  assertEnum(approval.status, MEMORY_APPROVAL_STATUSES, `${label}.approval.status`);
  assertNullableString(approval.proofRef, `${label}.approval.proofRef`);
  assertNullableString(approval.proposalDigest, `${label}.approval.proposalDigest`);
  assertNullableString(approval.approvedAt, `${label}.approval.approvedAt`);
  assertEnum(
    approval.actorKind,
    ["user", "system", "unknown"] as const,
    `${label}.approval.actorKind`,
  );
  if (approval.status === "verified") {
    assertString(approval.proofRef, `${label}.approval.proofRef`);
    assertSha256(approval.proposalDigest, `${label}.approval.proposalDigest`);
    assertString(approval.approvedAt, `${label}.approval.approvedAt`);
    if (
      approval.proofRef !== revision.proofRef ||
      approval.proposalDigest !== revision.proposalDigest
    ) {
      throw new Error(`${label}.approval must match the current verified revision`);
    }
  }
}

function validateMemoryRevision(revision: Record<string, unknown>, label: string): void {
  if (!Number.isInteger(revision.version) || Number(revision.version) < 1) {
    throw new Error(`${label}.version must be a positive integer`);
  }
  assertString(revision.revisionRef, `${label}.revisionRef`);
  assertSha256(revision.contentDigest, `${label}.contentDigest`);
  assertString(revision.createdAt, `${label}.createdAt`);
  assertStringArray(revision.predecessorRefs, `${label}.predecessorRefs`);
  for (const field of ["transactionId", "proofRef"] as const) {
    assertNullableString(revision[field], `${label}.${field}`);
  }
  assertNullableSha256(revision.proposalDigest, `${label}.proposalDigest`);
}

export function memoryContentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory digest value must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`memory digest value is not JSON-compatible: ${typeof value}`);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (!allowed.includes(value as T))
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string")
    throw new Error(`${label} must be a string or null`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[\da-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertNullableSha256(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertSha256(value, label);
}

function requiredString(value: unknown, label: string): string {
  assertString(value, label);
  return value.trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
