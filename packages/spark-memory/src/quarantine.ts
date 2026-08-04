import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { MemoryMutationAuthorization } from "./approval.ts";
import { createMemoryProposal, digestProposal, type MemoryApprovalVerifier } from "./approval.ts";
import type { MemoryLifecycleScope } from "./lifecycle.ts";

const verifiedLegacyManifests = new WeakSet<object>();

export const MEMORY_QUARANTINE_MANIFEST_SCHEMA = "spark.memory.quarantine-manifest/v1" as const;
export const MEMORY_QUARANTINE_PROPOSAL_SCHEMA = "spark.memory.proposal/v1" as const;
export const MEMORY_PURGE_PLAN_SCHEMA = "spark.memory.purge-plan/v1" as const;
export const MEMORY_PURGE_RECEIPT_SCHEMA = "spark.memory.purge-receipt/v1" as const;
export const MEMORY_QUARANTINE_TOMBSTONE_SCHEMA = "spark.memory.quarantine-tombstone/v1" as const;

export type MemoryQuarantineOperation = "quarantine" | "restore" | "purge";
export type MemoryQuarantineProposalStatus =
  | "pending"
  | "approved"
  | "committing"
  | "rejected"
  | "cancelled"
  | "expired"
  | "conflict"
  | "committed";
export type MemoryQuarantineTargetKind =
  | "content"
  | "revision"
  | "retrieval_index"
  | "telemetry_cache"
  | "cockpit_projection"
  | "backup_ref";
export type MemoryPurgeReceiptStatus = "pending" | "completed" | "failed";
export type MemoryQuarantineTombstoneStatus = "complete" | "purge_incomplete";

export interface MemoryQuarantineManifestItem {
  source: string;
  destination: string;
  bytes: number;
  sha256: string;
  reasonCode: string;
  reverseRefs: string[];
  purgeAfter: string;
  targetKind?: MemoryQuarantineTargetKind;
  fileVersion?: string | null;
}

export interface MemoryQuarantineManifest {
  schemaVersion: 1;
  quarantineId: string;
  createdAt: string;
  expiresAt: string;
  policy: {
    physicalPurgeRequiresApproval: true;
    restoreBefore: string;
    naviaGraceDays?: number;
  };
  items: MemoryQuarantineManifestItem[];
  planDigest: string;
  status: "quarantined" | "restored" | "purged";
  appliedAt?: string;
  restoredAt?: string;
}

export interface MemoryQuarantineProposal {
  schema: typeof MEMORY_QUARANTINE_PROPOSAL_SCHEMA;
  proposalId: string;
  operation: MemoryQuarantineOperation;
  workspaceId: string;
  recordRef: string;
  scope: MemoryLifecycleScope;
  expectedRevision: number;
  manifestDigest: string;
  planDigest: string | null;
  proposalDigest: string;
  contentDigest: string;
  createdAt: string;
  expiresAt: string;
  status: MemoryQuarantineProposalStatus;
  transactionId: string | null;
}

export interface MemoryQuarantineProposalInput {
  operation: MemoryQuarantineOperation;
  workspaceId: string;
  recordRef: string;
  scope: MemoryLifecycleScope;
  expectedRevision: number;
  manifestDigest: string;
  planDigest?: string;
  createdAt?: string;
  expiresAt: string;
  proposalId?: string;
}

export interface MemoryQuarantineTarget {
  id: string;
  kind: MemoryQuarantineTargetKind;
  path: string;
  sha256: string;
  bytes: number;
  reverseRefs: string[];
  fileVersion: string | null;
}

export interface MemoryPurgePlan {
  schema: typeof MEMORY_PURGE_PLAN_SCHEMA;
  planId: string;
  proposalId: string;
  workspaceId: string;
  manifestDigest: string;
  createdAt: string;
  purgeAfter: string;
  targets: MemoryQuarantineTarget[];
  planDigest: string;
}

export interface MemoryPurgeTargetReceipt {
  receiptId: string;
  targetId: string;
  kind: MemoryQuarantineTargetKind;
  planDigest: string;
  manifestDigest: string;
  expectedSha256: string;
  expectedBytes: number;
  expectedFileVersion: string | null;
  status: MemoryPurgeReceiptStatus;
  recordedAt: string;
  error: string | null;
}

export interface MemoryPurgeTombstone {
  schema: typeof MEMORY_QUARANTINE_TOMBSTONE_SCHEMA;
  tombstoneId: string;
  operation: "purge";
  proposalId: string | null;
  manifestDigest: string;
  status: MemoryQuarantineTombstoneStatus;
  objectKinds: MemoryQuarantineTargetKind[];
  targetReceipts: MemoryPurgeTargetReceipt[];
  remainingTargets: string[];
  createdAt: string;
  completedAt: string | null;
}

export interface MemoryPurgeExecutionState {
  targetReceipts: MemoryPurgeTargetReceipt[];
  tombstone?: MemoryPurgeTombstone;
}

export interface MemoryPurgeTargetCompletion {
  state: "completed" | "already_completed";
  receiptId: string;
  targetId: string;
  planDigest: string;
  expectedSha256: string;
  expectedBytes: number;
  expectedFileVersion: string | null;
}

export type MemoryPurgeTargetInspection =
  | { state: "not_started" }
  | MemoryPurgeTargetCompletion
  | { state: "conflict"; reason: string };

export interface MemoryPurgeApplyOptions {
  now?: string;
  state?: MemoryPurgeExecutionState;
  proposal: MemoryQuarantineProposal;
  verifier?: MemoryApprovalVerifier;
  persistState: (state: MemoryPurgeExecutionState) => Promise<void> | void;
  inspectTarget: (
    target: MemoryQuarantineTarget,
    receipt: MemoryPurgeTargetReceipt,
  ) => Promise<MemoryPurgeTargetInspection> | MemoryPurgeTargetInspection;
  executeTarget: (
    target: MemoryQuarantineTarget,
    receipt: MemoryPurgeTargetReceipt,
  ) => Promise<MemoryPurgeTargetCompletion> | MemoryPurgeTargetCompletion;
  verifyReachability: (target: MemoryQuarantineTarget) => Promise<boolean> | boolean;
  verifySource: (target: MemoryQuarantineTarget) => Promise<boolean> | boolean;
  omitProposalIdFromTombstone?: boolean;
}

export interface MemoryRestorePlan {
  schema: "spark.memory.restore-plan/v1";
  planId: string;
  proposalId: string;
  workspaceId: string;
  manifestDigest: string;
  createdAt: string;
  restoreBefore: string;
  items: MemoryQuarantineManifestItem[];
  planDigest: string;
}

export interface MemoryRestoreItemReceipt {
  receiptId: string;
  itemId: string;
  planDigest: string;
  manifestDigest: string;
  source: string;
  destination: string;
  expectedSha256: string;
  expectedBytes: number;
  expectedFileVersion: string | null;
  status: MemoryPurgeReceiptStatus;
  recordedAt: string;
  error: string | null;
}

export interface MemoryRestoreExecutionState {
  itemReceipts: MemoryRestoreItemReceipt[];
}

export interface MemoryRestoreItemCompletion {
  state: "completed" | "already_completed";
  receiptId: string;
  itemId: string;
  planDigest: string;
  expectedSha256: string;
  expectedBytes: number;
  expectedFileVersion: string | null;
}

export type MemoryRestoreItemInspection =
  | { state: "not_started" }
  | MemoryRestoreItemCompletion
  | { state: "conflict"; reason: string };

export interface MemoryRestoreApplyOptions {
  now?: string;
  state?: MemoryRestoreExecutionState;
  proposal: MemoryQuarantineProposal;
  verifier?: MemoryApprovalVerifier;
  persistState: (state: MemoryRestoreExecutionState) => Promise<void> | void;
  inspectItem: (
    item: MemoryQuarantineManifestItem,
    receipt: MemoryRestoreItemReceipt,
  ) => Promise<MemoryRestoreItemInspection> | MemoryRestoreItemInspection;
  executeItem: (
    item: MemoryQuarantineManifestItem,
    receipt: MemoryRestoreItemReceipt,
  ) => Promise<MemoryRestoreItemCompletion> | MemoryRestoreItemCompletion;
  verifyDestination: (item: MemoryQuarantineManifestItem) => Promise<boolean> | boolean;
}

export interface MemoryQuarantineVerifyResult {
  quarantineId: string;
  manifestDigest: string;
  files: number;
  bytes: number;
  verified: number;
  mismatches: string[];
}

export class MemoryQuarantineError extends Error {
  readonly code:
    | "MEMORY_QUARANTINE_INVALID"
    | "MEMORY_QUARANTINE_EXPIRED"
    | "MEMORY_QUARANTINE_MANIFEST_TAMPERED"
    | "MEMORY_QUARANTINE_REVERSE_REFERENCE"
    | "MEMORY_QUARANTINE_REACHABILITY"
    | "MEMORY_CANONICAL_ASK_REQUIRED"
    | "MEMORY_QUARANTINE_PROPOSAL_MISMATCH"
    | "MEMORY_QUARANTINE_REVISION_CONFLICT";

  constructor(code: MemoryQuarantineError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "MemoryQuarantineError";
    this.code = code;
  }
}

export function createMemoryQuarantineManifest(input: {
  quarantineId?: string;
  rootDir: string;
  createdAt: string;
  expiresAt: string;
  items: readonly Omit<MemoryQuarantineManifestItem, "bytes" | "sha256">[];
  naviaGraceDays?: number;
}): Promise<MemoryQuarantineManifest> {
  if (
    !isTimestamp(input.createdAt) ||
    !isTimestamp(input.expiresAt) ||
    input.expiresAt <= input.createdAt
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "manifest timestamps must define a positive canonical quarantine window",
    );
  }
  return (async () => {
    const items: MemoryQuarantineManifestItem[] = [];
    for (const item of input.items) {
      const source = normalizeRelativePath(item.source, "source");
      const destination = normalizeRelativePath(item.destination, "destination");
      if (!isTimestamp(item.purgeAfter) || item.purgeAfter < input.expiresAt) {
        throw new MemoryQuarantineError(
          "MEMORY_QUARANTINE_INVALID",
          `purgeAfter must not precede expiresAt: ${source}`,
        );
      }
      const file = await readFile(resolveSafePath(input.rootDir, source));
      items.push({
        ...item,
        source,
        destination,
        bytes: file.byteLength,
        sha256: sha256(file),
        reverseRefs: uniqueStrings(item.reverseRefs),
        purgeAfter: item.purgeAfter,
        ...(item.fileVersion === undefined ? {} : { fileVersion: item.fileVersion }),
      });
    }
    const manifest = {
      schemaVersion: 1 as const,
      quarantineId: input.quarantineId ?? `quarantine:${randomUUID()}`,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      policy: {
        physicalPurgeRequiresApproval: true as const,
        restoreBefore: input.expiresAt,
        ...(input.naviaGraceDays === undefined ? {} : { naviaGraceDays: input.naviaGraceDays }),
      },
      items: items.sort(compareItems),
      planDigest: "",
      status: "quarantined" as const,
    };
    manifest.planDigest = digestManifest(manifest);
    return manifest;
  })();
}

export function parseMemoryQuarantineManifest(value: unknown): MemoryQuarantineManifest {
  if (isRecord(value) && verifiedLegacyManifests.has(value)) {
    return value as unknown as MemoryQuarantineManifest;
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "manifest schemaVersion must be 1",
    );
  }
  if (
    typeof value.quarantineId !== "string" ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt <= value.createdAt ||
    !Array.isArray(value.items) ||
    typeof value.planDigest !== "string" ||
    !isRecord(value.policy) ||
    value.policy.physicalPurgeRequiresApproval !== true ||
    value.policy.restoreBefore !== value.expiresAt
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "manifest fields are invalid");
  }
  const items = value.items.map((item, index) => parseManifestItem(item, index, value.expiresAt));
  const manifest: MemoryQuarantineManifest = {
    schemaVersion: 1,
    quarantineId: value.quarantineId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    policy: {
      physicalPurgeRequiresApproval: true,
      restoreBefore: value.expiresAt,
      ...(typeof value.policy.naviaGraceDays === "number"
        ? { naviaGraceDays: value.policy.naviaGraceDays }
        : {}),
    },
    items: items.sort(compareItems),
    planDigest: value.planDigest,
    status: normalizeManifestStatus(value.status),
    ...(typeof value.appliedAt === "string" ? { appliedAt: value.appliedAt } : {}),
    ...(typeof value.restoredAt === "string" ? { restoredAt: value.restoredAt } : {}),
  };
  const legacyDigest = legacyPlanDigest(value);
  const isLegacyShape = value.items.every(
    (item) =>
      isRecord(item) &&
      hasOnlyKeys(item, ["source", "destination", "reasonCode", "bytes", "sha256"]),
  );
  const acceptedLegacy = isLegacyShape && manifest.planDigest === legacyDigest;
  if (manifest.planDigest !== digestManifest(manifest) && !acceptedLegacy) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
      "manifest planDigest does not match its immutable contents",
    );
  }
  if (acceptedLegacy) {
    const frozen = freezeManifest(manifest);
    verifiedLegacyManifests.add(frozen);
    return frozen;
  }
  return manifest;
}

export async function verifyMemoryQuarantineManifest(
  manifestValue: unknown,
  rootDir: string,
  options: { useDestination?: boolean } = {},
): Promise<MemoryQuarantineVerifyResult> {
  const manifest = parseMemoryQuarantineManifest(manifestValue);
  const mismatches: string[] = [];
  let verified = 0;
  let bytes = 0;
  for (const item of manifest.items) {
    const path = resolveSafePath(rootDir, options.useDestination ? item.destination : item.source);
    try {
      const content = await readFile(path);
      bytes += content.byteLength;
      if (content.byteLength !== item.bytes || sha256(content) !== item.sha256) {
        mismatches.push(item.source);
      } else {
        verified += 1;
      }
    } catch {
      mismatches.push(item.source);
    }
  }
  return {
    quarantineId: manifest.quarantineId,
    manifestDigest: manifest.planDigest,
    files: manifest.items.length,
    bytes,
    verified,
    mismatches,
  };
}

export function createMemoryQuarantineProposal(
  input: MemoryQuarantineProposalInput,
): MemoryQuarantineProposal {
  assertDigest(input.manifestDigest, "manifestDigest");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "expectedRevision must be non-negative",
    );
  }
  const canonical = createMemoryProposal({
    proposalId: input.proposalId,
    operation: input.operation,
    workspaceId: input.workspaceId,
    scope: input.scope,
    recordRef: input.recordRef,
    expectedRevision: input.expectedRevision,
    content: {
      manifestDigest: input.manifestDigest,
      planDigest: input.planDigest ?? null,
    },
    expiresAt: input.expiresAt,
  });
  return {
    ...canonical,
    manifestDigest: input.manifestDigest,
    planDigest: input.planDigest ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: "pending",
    transactionId: null,
  } as MemoryQuarantineProposal;
}

export function parseMemoryQuarantineProposal(value: unknown): MemoryQuarantineProposal {
  if (
    !isRecord(value) ||
    value.schema !== MEMORY_QUARANTINE_PROPOSAL_SCHEMA ||
    !isString(value.proposalId) ||
    !isQuarantineOperation(value.operation) ||
    !isString(value.workspaceId) ||
    !isLifecycleScope(value.scope) ||
    !isString(value.recordRef) ||
    !Number.isInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !isDigest(value.contentDigest) ||
    !isDigest(value.proposalDigest) ||
    !isString(value.expiresAt) ||
    !isDigest(value.manifestDigest) ||
    !isString(value.createdAt) ||
    !(value.planDigest === null || value.planDigest === undefined || isDigest(value.planDigest))
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "invalid quarantine proposal fields",
    );
  }
  const canonical = {
    schema: MEMORY_QUARANTINE_PROPOSAL_SCHEMA,
    proposalId: value.proposalId,
    operation: value.operation,
    workspaceId: value.workspaceId,
    scope: value.scope,
    recordRef: value.recordRef,
    expectedRevision: value.expectedRevision,
    contentDigest: value.contentDigest,
    proposalDigest: value.proposalDigest,
    expiresAt: value.expiresAt,
  };
  const { proposalDigest, ...unsigned } = canonical;
  const planDigest = isDigest(value.planDigest) ? value.planDigest : null;
  if (
    digestProposal(unsigned) !== proposalDigest ||
    canonical.contentDigest !== digest({ manifestDigest: value.manifestDigest, planDigest })
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
      "quarantine proposal digest mismatch",
    );
  }
  return {
    ...canonical,
    manifestDigest: value.manifestDigest,
    planDigest,
    createdAt: value.createdAt,
    status: normalizeProposalStatus(value.status),
    transactionId: typeof value.transactionId === "string" ? value.transactionId : null,
  };
}

export function assertMemoryQuarantineAuthorizationBound(
  proposal: MemoryQuarantineProposal,
  authorization: MemoryMutationAuthorization,
): void {
  const proof = authorization.proof;
  if (
    proof.operation !== proposal.operation ||
    proof.workspaceId !== proposal.workspaceId ||
    proof.recordRef !== proposal.recordRef ||
    proof.scope !== proposal.scope ||
    proof.expectedRevision !== proposal.expectedRevision ||
    proof.proposalId !== proposal.proposalId ||
    proof.proposalDigest !== proposal.proposalDigest ||
    authorization.proposal.proposalDigest !== proposal.proposalDigest ||
    authorization.proposal.contentDigest !== proposal.contentDigest
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
      "approval proof is not bound to the quarantine proposal",
    );
  }
}

export function createMemoryPurgePlan(input: {
  manifest: unknown;
  proposal?: MemoryQuarantineProposal;
  proposalId?: string;
  workspaceId?: string;
  now: string;
  verifySource: (item: MemoryQuarantineManifestItem) => Promise<boolean> | boolean;
  verifyReachability: (item: MemoryQuarantineManifestItem) => Promise<boolean> | boolean;
}): Promise<MemoryPurgePlan> {
  return (async () => {
    if (!isTimestamp(input.now)) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_INVALID",
        "purge plan now must be canonical",
      );
    }
    const manifest = parseMemoryQuarantineManifest(input.manifest);
    const proposalId = input.proposal?.proposalId ?? requiredString(input.proposalId, "proposalId");
    const workspaceId =
      input.proposal?.workspaceId ?? requiredString(input.workspaceId, "workspaceId");
    if (
      input.proposal &&
      (input.proposal.operation !== "purge" ||
        input.proposal.manifestDigest !== manifest.planDigest)
    ) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
        "purge proposal does not bind manifest",
      );
    }
    const purgeAfter = manifest.items.reduce(
      (latest, item) => (item.purgeAfter > latest ? item.purgeAfter : latest),
      manifest.expiresAt,
    );
    if (input.now < purgeAfter) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_EXPIRED",
        "purge is not available before purgeAfter",
      );
    }
    const targets: MemoryQuarantineTarget[] = [];
    for (const [index, item] of manifest.items.entries()) {
      if (item.reverseRefs.length > 0) {
        throw new MemoryQuarantineError(
          "MEMORY_QUARANTINE_REVERSE_REFERENCE",
          `target ${item.source} has reverse references`,
        );
      }
      if (!(await input.verifySource(item))) {
        throw new MemoryQuarantineError(
          "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
          `source verification failed: ${item.source}`,
        );
      }
      if (!(await input.verifyReachability(item))) {
        throw new MemoryQuarantineError(
          "MEMORY_QUARANTINE_REACHABILITY",
          `target remains reachable: ${item.source}`,
        );
      }
      targets.push({
        id: `target:${index + 1}:${item.targetKind ?? "content"}`,
        kind: item.targetKind ?? "content",
        path: item.destination,
        sha256: item.sha256,
        bytes: item.bytes,
        reverseRefs: [...item.reverseRefs],
        fileVersion: item.fileVersion ?? null,
      });
    }
    const base = {
      schema: MEMORY_PURGE_PLAN_SCHEMA,
      planId: `purge-plan:${randomUUID()}`,
      proposalId,
      workspaceId,
      manifestDigest: manifest.planDigest,
      createdAt: input.now,
      purgeAfter,
      targets,
    };
    return { ...base, planDigest: digest(base) };
  })();
}

export async function applyMemoryPurgePlan(
  planValue: unknown,
  authorization: MemoryMutationAuthorization | undefined,
  options: MemoryPurgeApplyOptions,
): Promise<MemoryPurgeExecutionState> {
  const plan = parseMemoryPurgePlan(planValue);
  if (!authorization || !options.verifier) {
    throw new MemoryQuarantineError(
      "MEMORY_CANONICAL_ASK_REQUIRED",
      "physical purge requires a fresh canonical Ask approval",
    );
  }
  const proposal = parseMemoryQuarantineProposal(options.proposal);
  assertMemoryQuarantineAuthorizationBound(proposal, authorization);
  if (
    proposal.operation !== "purge" ||
    proposal.proposalId !== plan.proposalId ||
    proposal.workspaceId !== plan.workspaceId ||
    proposal.manifestDigest !== plan.manifestDigest ||
    proposal.planDigest !== plan.planDigest ||
    authorization.proposal.contentDigest !==
      digest({ manifestDigest: plan.manifestDigest, planDigest: plan.planDigest })
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
      "purge authorization does not bind plan proposal",
    );
  }
  const verification = await options.verifier.verify({
    workspaceId: plan.workspaceId,
    scope: proposal.scope,
    recordRef: proposal.recordRef,
    operation: "purge",
    expectedRevision: proposal.expectedRevision,
    content: { manifestDigest: plan.manifestDigest, planDigest: plan.planDigest },
    proposalId: plan.proposalId,
    transactionId: authorization.transactionId,
    proposal,
    proof: authorization.proof,
  });
  const now = options.now ?? new Date().toISOString();
  if (!isTimestamp(now)) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "purge apply now must be canonical",
    );
  }
  if (now < plan.purgeAfter) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_EXPIRED",
      "physical purge is not available before purgeAfter",
    );
  }
  const receipts = [...(options.state?.targetReceipts ?? [])];
  const completed = new Set(
    receipts.filter((receipt) => receipt.status === "completed").map((receipt) => receipt.targetId),
  );
  for (const target of plan.targets) {
    if (completed.has(target.id)) continue;
    const previous = receipts.find((receipt) => receipt.targetId === target.id);
    if (!(await options.verifyReachability(target))) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_REACHABILITY",
        `target remains reachable: ${target.path}`,
      );
    }
    const pending: MemoryPurgeTargetReceipt = {
      receiptId: previous?.receiptId ?? `purge-receipt:${randomUUID()}`,
      targetId: target.id,
      kind: target.kind,
      planDigest: plan.planDigest,
      manifestDigest: plan.manifestDigest,
      expectedSha256: target.sha256,
      expectedBytes: target.bytes,
      expectedFileVersion: target.fileVersion,
      status: "pending",
      recordedAt: previous?.recordedAt ?? now,
      error: null,
    };
    let inspection: MemoryPurgeTargetInspection;
    try {
      inspection = await options.inspectTarget(target, pending);
    } catch (caught) {
      inspection = {
        state: "conflict",
        reason: caught instanceof Error ? caught.message : String(caught),
      };
    }
    if (inspection.state === "conflict") {
      replaceReceipt(receipts, { ...pending, status: "failed", error: inspection.reason });
      await options.persistState({ targetReceipts: [...receipts] });
      continue;
    }
    if (inspection.state !== "not_started") {
      const completionError = targetCompletionError(target, pending, inspection);
      if (!previous || completionError) {
        replaceReceipt(receipts, {
          ...pending,
          status: "failed",
          error: completionError ?? "completed target has no durable prior receipt",
        });
      } else {
        replaceReceipt(receipts, { ...pending, status: "completed", error: null });
      }
      await options.persistState({ targetReceipts: [...receipts] });
      continue;
    }
    if (!(await options.verifySource(target))) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
        `source verification failed: ${target.path}`,
      );
    }
    replaceReceipt(receipts, pending);
    await options.persistState({ targetReceipts: [...receipts] });
    try {
      const completion = await options.executeTarget(target, pending);
      const completionError = targetCompletionError(target, pending, completion);
      if (completionError) throw new Error(completionError);
      replaceReceipt(receipts, { ...pending, status: "completed", error: null });
    } catch (caught) {
      replaceReceipt(receipts, {
        ...pending,
        status: "failed",
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
    await options.persistState({ targetReceipts: [...receipts] });
  }
  const remainingTargets = plan.targets
    .filter(
      (target) =>
        receipts.find((receipt) => receipt.targetId === target.id)?.status !== "completed",
    )
    .map((target) => target.id);
  const tombstone: MemoryPurgeTombstone = {
    schema: MEMORY_QUARANTINE_TOMBSTONE_SCHEMA,
    tombstoneId: options.state?.tombstone?.tombstoneId ?? `tombstone:${randomUUID()}`,
    operation: "purge",
    proposalId: options.omitProposalIdFromTombstone ? null : plan.proposalId,
    manifestDigest: plan.manifestDigest,
    status: remainingTargets.length === 0 ? "complete" : "purge_incomplete",
    objectKinds: uniqueKinds(plan.targets.map((target) => target.kind)),
    targetReceipts: receipts,
    remainingTargets,
    createdAt: options.state?.tombstone?.createdAt ?? now,
    completedAt: remainingTargets.length === 0 ? now : null,
  };
  const state = { targetReceipts: receipts, tombstone };
  await options.persistState(state);
  const committed = await options.verifier.commit(authorization.proof, verification.transactionId);
  if (!committed) {
    throw new MemoryQuarantineError(
      "MEMORY_CANONICAL_ASK_REQUIRED",
      "purge approval could not be committed",
    );
  }
  return state;
}

export function createMemoryRestorePlan(input: {
  manifest: unknown;
  proposal?: MemoryQuarantineProposal;
  proposalId?: string;
  workspaceId?: string;
  now: string;
}): MemoryRestorePlan {
  if (!isTimestamp(input.now)) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "restore plan now must be canonical",
    );
  }
  const manifest = parseMemoryQuarantineManifest(input.manifest);
  const proposalId = input.proposal?.proposalId ?? requiredString(input.proposalId, "proposalId");
  const workspaceId =
    input.proposal?.workspaceId ?? requiredString(input.workspaceId, "workspaceId");
  if (
    input.proposal &&
    (input.proposal.operation !== "restore" ||
      input.proposal.manifestDigest !== manifest.planDigest)
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
      "restore proposal does not bind manifest",
    );
  }
  if (input.now >= manifest.expiresAt) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_EXPIRED", "restore window has expired");
  }
  const base = {
    schema: "spark.memory.restore-plan/v1" as const,
    planId: `restore-plan:${randomUUID()}`,
    proposalId,
    workspaceId,
    manifestDigest: manifest.planDigest,
    createdAt: input.now,
    restoreBefore: manifest.expiresAt,
    items: manifest.items,
  };
  return { ...base, planDigest: digest(base) };
}

export async function applyMemoryRestorePlan(
  planValue: unknown,
  authorization: MemoryMutationAuthorization | undefined,
  options: MemoryRestoreApplyOptions,
): Promise<{ restored: number; planDigest: string; state: MemoryRestoreExecutionState }> {
  const plan = parseMemoryRestorePlan(planValue);
  if (!authorization || !options.verifier) {
    throw new MemoryQuarantineError(
      "MEMORY_CANONICAL_ASK_REQUIRED",
      "restore requires canonical Ask approval",
    );
  }
  const proposal = parseMemoryQuarantineProposal(options.proposal);
  assertMemoryQuarantineAuthorizationBound(proposal, authorization);
  if (
    proposal.operation !== "restore" ||
    proposal.proposalId !== plan.proposalId ||
    proposal.workspaceId !== plan.workspaceId ||
    proposal.manifestDigest !== plan.manifestDigest ||
    proposal.planDigest !== plan.planDigest ||
    authorization.proposal.contentDigest !==
      digest({ manifestDigest: plan.manifestDigest, planDigest: plan.planDigest })
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
      "restore authorization does not bind plan",
    );
  }
  const verification = await options.verifier.verify({
    workspaceId: plan.workspaceId,
    scope: proposal.scope,
    recordRef: proposal.recordRef,
    operation: "restore",
    expectedRevision: proposal.expectedRevision,
    content: { manifestDigest: plan.manifestDigest, planDigest: plan.planDigest },
    proposalId: plan.proposalId,
    transactionId: authorization.transactionId,
    proposal,
    proof: authorization.proof,
  });
  const now = options.now ?? new Date().toISOString();
  if (!isTimestamp(now)) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "restore apply now must be canonical",
    );
  }
  if (now >= plan.restoreBefore) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_EXPIRED", "restore window has expired");
  }
  const receipts = validatedRestoreReceipts(plan, options.state);
  for (const [index, item] of plan.items.entries()) {
    const itemId = restoreItemId(index);
    const previous = receipts.find((receipt) => receipt.itemId === itemId);
    if (previous?.status === "completed") continue;
    const pending: MemoryRestoreItemReceipt = {
      receiptId: previous?.receiptId ?? `restore-receipt:${randomUUID()}`,
      itemId,
      planDigest: plan.planDigest,
      manifestDigest: plan.manifestDigest,
      source: item.source,
      destination: item.destination,
      expectedSha256: item.sha256,
      expectedBytes: item.bytes,
      expectedFileVersion: item.fileVersion ?? null,
      status: "pending",
      recordedAt: previous?.recordedAt ?? now,
      error: null,
    };
    let inspection: MemoryRestoreItemInspection;
    try {
      inspection = await options.inspectItem(item, pending);
    } catch (caught) {
      inspection = {
        state: "conflict",
        reason: caught instanceof Error ? caught.message : String(caught),
      };
    }
    if (inspection.state === "conflict") {
      replaceRestoreReceipt(receipts, {
        ...pending,
        status: "failed",
        error: inspection.reason,
      });
      await options.persistState({ itemReceipts: [...receipts] });
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
        `restore target inspection failed: ${item.source}: ${inspection.reason}`,
      );
    }
    if (inspection.state !== "not_started") {
      const completionError = restoreCompletionError(item, pending, inspection);
      if (!previous || completionError) {
        const error = completionError ?? "completed restore target has no durable prior receipt";
        replaceRestoreReceipt(receipts, { ...pending, status: "failed", error });
        await options.persistState({ itemReceipts: [...receipts] });
        throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", error);
      }
      replaceRestoreReceipt(receipts, { ...pending, status: "completed", error: null });
      await options.persistState({ itemReceipts: [...receipts] });
      continue;
    }
    if (!(await options.verifyDestination(item))) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
        `destination verification failed: ${item.destination}`,
      );
    }
    replaceRestoreReceipt(receipts, pending);
    await options.persistState({ itemReceipts: [...receipts] });
    try {
      const completion = await options.executeItem(item, pending);
      const completionError = restoreCompletionError(item, pending, completion);
      if (completionError) throw new Error(completionError);
      replaceRestoreReceipt(receipts, { ...pending, status: "completed", error: null });
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      replaceRestoreReceipt(receipts, { ...pending, status: "failed", error });
      await options.persistState({ itemReceipts: [...receipts] });
      throw caught;
    }
    await options.persistState({ itemReceipts: [...receipts] });
  }
  const state = { itemReceipts: receipts };
  await options.persistState(state);
  const committed = await options.verifier.commit(authorization.proof, verification.transactionId);
  if (!committed) {
    throw new MemoryQuarantineError(
      "MEMORY_CANONICAL_ASK_REQUIRED",
      "restore approval could not be committed",
    );
  }
  return {
    restored: receipts.filter((receipt) => receipt.status === "completed").length,
    planDigest: plan.planDigest,
    state,
  };
}

export function parseMemoryPurgePlan(value: unknown): MemoryPurgePlan {
  if (
    !isRecord(value) ||
    value.schema !== MEMORY_PURGE_PLAN_SCHEMA ||
    !Array.isArray(value.targets)
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid purge plan");
  }
  const plan = value as unknown as MemoryPurgePlan;
  if (
    !isDigest(plan.manifestDigest) ||
    !isDigest(plan.planDigest) ||
    !isString(plan.proposalId) ||
    !isString(plan.workspaceId) ||
    !isTimestamp(plan.createdAt) ||
    !isTimestamp(plan.purgeAfter) ||
    plan.targets.some(
      (target) =>
        !isRecord(target) ||
        !isString(target.id) ||
        !isTargetKind(target.kind) ||
        !isString(target.path) ||
        !isDigest(target.sha256) ||
        !Number.isInteger(target.bytes) ||
        Number(target.bytes) < 0 ||
        !Array.isArray(target.reverseRefs) ||
        target.reverseRefs.some((ref) => !isString(ref)),
    )
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "invalid purge plan digest fields",
    );
  }
  const { planDigest, ...unsigned } = plan;
  for (const target of plan.targets) normalizeRelativePath(target.path, "purge target path");
  if (digest(unsigned) !== planDigest) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
      "purge plan digest mismatch",
    );
  }
  return plan;
}

export function parseMemoryRestorePlan(value: unknown): MemoryRestorePlan {
  if (
    !isRecord(value) ||
    value.schema !== "spark.memory.restore-plan/v1" ||
    !Array.isArray(value.items)
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid restore plan");
  }
  const plan = value as unknown as MemoryRestorePlan;
  if (
    !isDigest(plan.manifestDigest) ||
    !isDigest(plan.planDigest) ||
    !isString(plan.proposalId) ||
    !isString(plan.workspaceId) ||
    !isTimestamp(plan.createdAt) ||
    !isTimestamp(plan.restoreBefore)
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "invalid restore plan digest fields",
    );
  }
  const { planDigest, ...unsigned } = plan;
  plan.items.forEach((item, index) => parseManifestItem(item, index, plan.restoreBefore));
  if (digest(unsigned) !== planDigest) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
      "restore plan digest mismatch",
    );
  }
  return plan;
}

export function parseMemoryPurgeTombstone(value: unknown): MemoryPurgeTombstone {
  if (
    !isRecord(value) ||
    value.schema !== MEMORY_QUARANTINE_TOMBSTONE_SCHEMA ||
    value.operation !== "purge" ||
    !isDigest(value.manifestDigest) ||
    !Array.isArray(value.targetReceipts) ||
    !Array.isArray(value.remainingTargets) ||
    !Array.isArray(value.objectKinds)
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid purge tombstone");
  }
  if (value.status !== "complete" && value.status !== "purge_incomplete") {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid tombstone status");
  }
  const receipts = value.targetReceipts;
  const receiptIds = new Set<string>();
  const targetIds = new Set<string>();
  if (
    !hasOnlyKeys(value, [
      "schema",
      "tombstoneId",
      "operation",
      "proposalId",
      "manifestDigest",
      "status",
      "objectKinds",
      "targetReceipts",
      "remainingTargets",
      "createdAt",
      "completedAt",
    ]) ||
    !isString(value.tombstoneId) ||
    !(value.proposalId === null || isString(value.proposalId)) ||
    !isTimestamp(value.createdAt) ||
    !(value.completedAt === null || isTimestamp(value.completedAt)) ||
    value.objectKinds.some((kind) => !isTargetKind(kind)) ||
    value.remainingTargets.some((target) => !isString(target)) ||
    receipts.some((receipt) => {
      if (
        !isRecord(receipt) ||
        !hasOnlyKeys(receipt, [
          "receiptId",
          "targetId",
          "kind",
          "planDigest",
          "manifestDigest",
          "expectedSha256",
          "expectedBytes",
          "expectedFileVersion",
          "status",
          "recordedAt",
          "error",
        ]) ||
        !isString(receipt.receiptId) ||
        !isString(receipt.targetId) ||
        !isTargetKind(receipt.kind) ||
        !isDigest(receipt.planDigest) ||
        receipt.manifestDigest !== value.manifestDigest ||
        !isDigest(receipt.expectedSha256) ||
        !Number.isInteger(receipt.expectedBytes) ||
        receipt.expectedBytes < 0 ||
        !(receipt.expectedFileVersion === null || isString(receipt.expectedFileVersion)) ||
        (receipt.status !== "pending" &&
          receipt.status !== "completed" &&
          receipt.status !== "failed") ||
        !isTimestamp(receipt.recordedAt) ||
        !(receipt.error === null || typeof receipt.error === "string") ||
        receiptIds.has(receipt.receiptId) ||
        targetIds.has(receipt.targetId)
      ) {
        return true;
      }
      receiptIds.add(receipt.receiptId);
      targetIds.add(receipt.targetId);
      return false;
    })
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid purge receipts");
  }
  const nonCompleted = receipts
    .filter((receipt) => isRecord(receipt) && receipt.status !== "completed")
    .map((receipt) => (receipt as { targetId: string }).targetId)
    .sort();
  const remaining = [...(value.remainingTargets as string[])].sort();
  if (nonCompleted.join("\0") !== remaining.join("\0")) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "remainingTargets must exactly match non-completed receipts",
    );
  }
  if (
    value.status === "complete" &&
    (remaining.length > 0 || receipts.some((receipt) => receipt.status !== "completed"))
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "complete tombstone requires every target receipt to be completed",
    );
  }
  return value as unknown as MemoryPurgeTombstone;
}

function normalizeProposalStatus(value: unknown): MemoryQuarantineProposalStatus {
  if (
    value === undefined ||
    value === "pending" ||
    value === "approved" ||
    value === "committing" ||
    value === "rejected" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "conflict" ||
    value === "committed"
  ) {
    return value ?? "pending";
  }
  throw new MemoryQuarantineError(
    "MEMORY_QUARANTINE_INVALID",
    "invalid quarantine proposal status",
  );
}
function parseManifestItem(
  value: unknown,
  index: number,
  defaultPurgeAfter: string,
): MemoryQuarantineManifestItem {
  if (!isRecord(value))
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `items[${index}] must be an object`,
    );
  if (
    !isString(value.source) ||
    !isString(value.destination) ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 0 ||
    !isDigest(value.sha256) ||
    !isString(value.reasonCode) ||
    !Array.isArray(value.reverseRefs ?? []) ||
    !(value.reverseRefs ?? []).every(isString)
  ) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `items[${index}] has invalid fields`,
    );
  }
  const purgeAfter = isString(value.purgeAfter) ? value.purgeAfter : defaultPurgeAfter;
  if (!isTimestamp(purgeAfter) || purgeAfter < defaultPurgeAfter) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `items[${index}].purgeAfter must not precede manifest expiry`,
    );
  }
  return {
    source: normalizeRelativePath(value.source, `items[${index}].source`),
    destination: normalizeRelativePath(value.destination, `items[${index}].destination`),
    bytes: value.bytes,
    sha256: value.sha256,
    reasonCode: value.reasonCode,
    reverseRefs: uniqueStrings(value.reverseRefs ?? []),
    purgeAfter,
    ...(isTargetKind(value.targetKind) ? { targetKind: value.targetKind } : {}),
    ...(value.fileVersion === null || typeof value.fileVersion === "string"
      ? { fileVersion: value.fileVersion ?? null }
      : {}),
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function digestManifest(
  manifest: Omit<MemoryQuarantineManifest, "planDigest"> & { planDigest?: string },
): string {
  const { planDigest: _ignored, ...unsigned } = manifest;
  return digest(unsigned);
}

function legacyPlanDigest(value: Record<string, any>): string {
  const legacy = {
    schemaVersion: value.schemaVersion,
    quarantineId: value.quarantineId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    policy: value.policy,
    items: value.items,
  };
  return sha256(JSON.stringify(legacy));
}

function freezeManifest(manifest: MemoryQuarantineManifest): MemoryQuarantineManifest {
  for (const item of manifest.items) {
    Object.freeze(item.reverseRefs);
    Object.freeze(item);
  }
  Object.freeze(manifest.items);
  Object.freeze(manifest.policy);
  return Object.freeze(manifest);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("unsupported value in memory quarantine digest");
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveSafePath(rootDir: string, path: string): string {
  const root = resolve(rootDir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel.startsWith("..") || isAbsolute(rel)) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", `path escapes root: ${path}`);
  }
  return join(root, rel);
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (!isString(value) || isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `${label} must be a relative safe path`,
    );
  }
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function requiredString(value: unknown, label: string): string {
  if (!isString(value))
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `${label} must be a non-empty string`,
    );
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{64}$/u.test(value);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (!isDigest(value))
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      `${label} must be a SHA-256 digest`,
    );
}

function hasOnlyKeys(value: Record<string, any>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQuarantineOperation(value: unknown): value is MemoryQuarantineOperation {
  return value === "quarantine" || value === "restore" || value === "purge";
}

function isLifecycleScope(value: unknown): value is MemoryLifecycleScope {
  return (
    value === "user" ||
    value === "workspace" ||
    value === "repo" ||
    value === "project" ||
    value === "agent"
  );
}

function isTargetKind(value: unknown): value is MemoryQuarantineTargetKind {
  return [
    "content",
    "revision",
    "retrieval_index",
    "telemetry_cache",
    "cockpit_projection",
    "backup_ref",
  ].includes(value as string);
}

function normalizeManifestStatus(value: unknown): MemoryQuarantineManifest["status"] {
  if (value === undefined || value === "quarantined" || value === "restored" || value === "purged")
    return value ?? "quarantined";
  throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid manifest status");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function targetCompletionError(
  target: MemoryQuarantineTarget,
  receipt: MemoryPurgeTargetReceipt,
  completion: MemoryPurgeTargetCompletion,
): string | null {
  if (
    completion.receiptId !== receipt.receiptId ||
    completion.targetId !== target.id ||
    completion.planDigest !== receipt.planDigest ||
    completion.expectedSha256 !== target.sha256 ||
    completion.expectedBytes !== target.bytes ||
    completion.expectedFileVersion !== target.fileVersion
  ) {
    return "target completion does not bind the exact receipt, plan, hash, and file version";
  }
  return null;
}

function validatedRestoreReceipts(
  plan: MemoryRestorePlan,
  state: MemoryRestoreExecutionState | undefined,
): MemoryRestoreItemReceipt[] {
  if (!state) return [];
  if (
    !isRecord(state) ||
    !hasOnlyKeys(state, ["itemReceipts"]) ||
    !Array.isArray(state.itemReceipts)
  ) {
    throw new MemoryQuarantineError("MEMORY_QUARANTINE_INVALID", "invalid restore execution state");
  }
  const receiptIds = new Set<string>();
  const itemIds = new Set<string>();
  const receipts = state.itemReceipts.map((value, index) => {
    const item = plan.items[indexForRestoreItem(value, plan.items.length)]!;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        "receiptId",
        "itemId",
        "planDigest",
        "manifestDigest",
        "source",
        "destination",
        "expectedSha256",
        "expectedBytes",
        "expectedFileVersion",
        "status",
        "recordedAt",
        "error",
      ]) ||
      !isString(value.receiptId) ||
      receiptIds.has(value.receiptId) ||
      itemIds.has(value.itemId) ||
      value.planDigest !== plan.planDigest ||
      value.manifestDigest !== plan.manifestDigest ||
      value.source !== item.source ||
      value.destination !== item.destination ||
      value.expectedSha256 !== item.sha256 ||
      value.expectedBytes !== item.bytes ||
      value.expectedFileVersion !== (item.fileVersion ?? null) ||
      (value.status !== "pending" && value.status !== "completed" && value.status !== "failed") ||
      !isTimestamp(value.recordedAt) ||
      !(value.error === null || typeof value.error === "string")
    ) {
      throw new MemoryQuarantineError(
        "MEMORY_QUARANTINE_INVALID",
        `invalid restore receipt at index ${index}`,
      );
    }
    receiptIds.add(value.receiptId);
    itemIds.add(value.itemId);
    return value as unknown as MemoryRestoreItemReceipt;
  });
  return receipts;
}

function indexForRestoreItem(value: unknown, itemCount: number): number {
  if (!isRecord(value) || typeof value.itemId !== "string") {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "restore receipt itemId is invalid",
    );
  }
  const match = /^restore-item:(\d+)$/u.exec(value.itemId);
  const index = match ? Number(match[1]) - 1 : -1;
  if (!Number.isInteger(index) || index < 0 || index >= itemCount) {
    throw new MemoryQuarantineError(
      "MEMORY_QUARANTINE_INVALID",
      "restore receipt itemId is invalid",
    );
  }
  return index;
}

function restoreItemId(index: number): string {
  return `restore-item:${index + 1}`;
}

function restoreCompletionError(
  item: MemoryQuarantineManifestItem,
  receipt: MemoryRestoreItemReceipt,
  completion: MemoryRestoreItemCompletion,
): string | null {
  if (
    completion.receiptId !== receipt.receiptId ||
    completion.itemId !== receipt.itemId ||
    completion.planDigest !== receipt.planDigest ||
    completion.expectedSha256 !== item.sha256 ||
    completion.expectedBytes !== item.bytes ||
    completion.expectedFileVersion !== (item.fileVersion ?? null)
  ) {
    return "restore completion does not bind the exact receipt, plan, hash, and file version";
  }
  return null;
}

function replaceRestoreReceipt(
  receipts: MemoryRestoreItemReceipt[],
  receipt: MemoryRestoreItemReceipt,
): void {
  const previous = receipts.find((candidate) => candidate.itemId === receipt.itemId);
  if (previous) receipts[receipts.indexOf(previous)] = receipt;
  else receipts.push(receipt);
}

function replaceReceipt(
  receipts: MemoryPurgeTargetReceipt[],
  receipt: MemoryPurgeTargetReceipt,
): void {
  const previous = receipts.find((candidate) => candidate.targetId === receipt.targetId);
  if (previous) receipts[receipts.indexOf(previous)] = receipt;
  else receipts.push(receipt);
}

function uniqueKinds(values: readonly MemoryQuarantineTargetKind[]): MemoryQuarantineTargetKind[] {
  return [...new Set(values)];
}

function compareItems(
  left: MemoryQuarantineManifestItem,
  right: MemoryQuarantineManifestItem,
): number {
  return left.source.localeCompare(right.source);
}
