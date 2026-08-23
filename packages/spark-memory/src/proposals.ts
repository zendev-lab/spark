import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { writeJsonFileAtomic } from "@zendev-lab/spark-platform-node/json-files";
import {
  sparkWorkspaceStatePath,
  type SparkStateRootContext,
} from "@zendev-lab/spark-platform-node/paths";

import type { MemoryMutationAuthorization } from "./approval.ts";
import { memoryContentDigest, type MemoryLifecycleScope, type MemoryRisk } from "./lifecycle.ts";
import { withFileMutationLock } from "./mutation-lock.ts";

const MEMORY_LINEAGE_PROPOSAL_SCHEMA = "spark.memory.lineage-proposal/v1" as const;

type MemoryLineageProposalOperation = "propose_update" | "propose_merge" | "propose_supersede";
export type MemoryLineageProposalStatus =
  | "pending"
  | "approved"
  | "committing"
  | "rejected"
  | "cancelled"
  | "expired"
  | "conflict"
  | "committed";
type MemoryLineageTargetKind = "entry" | "learning";

export interface FrozenMemoryRevisionSource {
  recordRef: string;
  revisionRef: string;
  contentDigest: string;
  scope: MemoryLifecycleScope;
}

interface MemoryLineageProposalTarget {
  kind: MemoryLineageTargetKind;
  recordRef: string;
  scope: MemoryLifecycleScope;
  risk: MemoryRisk;
  content: unknown;
  evidenceRefs: string[];
}

interface MemoryLineageProposalDiff {
  before: Array<{ recordRef: string; revisionRef: string; contentDigest: string }>;
  after: { recordRef: string; contentDigest: string };
}

export interface MemoryLineageProposal {
  schema: typeof MEMORY_LINEAGE_PROPOSAL_SCHEMA;
  proposalId: string;
  operation: MemoryLineageProposalOperation;
  workspaceId: string;
  status: MemoryLineageProposalStatus;
  sources: FrozenMemoryRevisionSource[];
  target: MemoryLineageProposalTarget;
  expectedRevision: number;
  idempotencyKey: string;
  proposalDigest: string;
  previewRef: string;
  diff: MemoryLineageProposalDiff;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  committedAt: string | null;
  conflictStatus: string | null;
  transactionId: string | null;
}

export interface CreateMemoryLineageProposalInput {
  operation: MemoryLineageProposalOperation;
  workspaceId: string;
  sources: readonly FrozenMemoryRevisionSource[];
  target: Omit<MemoryLineageProposalTarget, "evidenceRefs"> & { evidenceRefs?: readonly string[] };
  expectedRevision: number;
  previewRef: string;
  createdAt?: string;
  expiresAt: string;
}

export interface MemorySemanticReviewSuggestion {
  kind: "review_suggestion";
  queryDigest: string;
  candidateRefs: string[];
  reason: string;
}

interface MemoryLineageProposalSnapshot {
  version: 1;
  proposals: MemoryLineageProposal[];
}

class MemoryLineageProposalFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`invalid memory lineage proposal store: ${filePath}: ${message}`);
    this.name = "MemoryLineageProposalFormatError";
    this.filePath = filePath;
  }
}

export class MemoryLineageProposalStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async list(): Promise<MemoryLineageProposal[]> {
    return (await this.load()).proposals;
  }

  async get(proposalId: string): Promise<MemoryLineageProposal> {
    const proposal = (await this.load()).proposals.find((item) => item.proposalId === proposalId);
    if (!proposal) throw new Error(`memory lineage proposal not found: ${proposalId}`);
    return proposal;
  }

  async create(input: CreateMemoryLineageProposalInput): Promise<MemoryLineageProposal> {
    return withFileMutationLock(this.lockPath, async () => {
      const snapshot = await this.load();
      const proposal = createMemoryLineageProposal(input);
      const exact = snapshot.proposals.find(
        (candidate) => candidate.idempotencyKey === proposal.idempotencyKey,
      );
      if (exact) return exact;
      snapshot.proposals.push(proposal);
      await this.save(snapshot);
      return proposal;
    });
  }

  async transition(
    proposalId: string,
    status: Exclude<MemoryLineageProposalStatus, "pending" | "committing">,
    options: {
      expectedStatus: MemoryLineageProposalStatus;
      now?: string;
      conflictStatus?: string | null;
    },
  ): Promise<MemoryLineageProposal> {
    return withFileMutationLock(this.lockPath, async () => {
      const snapshot = await this.load();
      const index = snapshot.proposals.findIndex((proposal) => proposal.proposalId === proposalId);
      if (index < 0) throw new Error(`memory lineage proposal not found: ${proposalId}`);
      const current = snapshot.proposals[index];
      if (!current) throw new Error(`memory lineage proposal not found: ${proposalId}`);
      if (current.status !== options.expectedStatus) {
        if (current.status === status) return current;
        throw new Error(
          `memory lineage proposal status conflict: expected ${options.expectedStatus}, received ${current.status}`,
        );
      }
      assertAllowedTransition(current.status, status);
      const now = options.now ?? new Date().toISOString();
      const updated: MemoryLineageProposal = {
        ...current,
        status,
        updatedAt: now,
        committedAt: status === "committed" ? (current.committedAt ?? now) : current.committedAt,
        conflictStatus: options.conflictStatus ?? current.conflictStatus,
      };
      snapshot.proposals[index] = updated;
      await this.save(snapshot);
      return updated;
    });
  }

  async claimCommit(
    proposalId: string,
    transactionId: string,
    options: { now?: string } = {},
  ): Promise<MemoryLineageProposal> {
    const normalizedTransactionId = normalizeRef(transactionId, "transactionId");
    return withFileMutationLock(this.lockPath, async () => {
      const snapshot = await this.load();
      const index = snapshot.proposals.findIndex((proposal) => proposal.proposalId === proposalId);
      if (index < 0) throw new Error(`memory lineage proposal not found: ${proposalId}`);
      const current = snapshot.proposals[index];
      if (!current) throw new Error(`memory lineage proposal not found: ${proposalId}`);
      if (
        (current.status === "committing" || current.status === "committed") &&
        current.transactionId === normalizedTransactionId
      ) {
        return current;
      }
      if (current.status !== "approved") {
        throw new Error(`memory lineage proposal is not approved: ${current.status}`);
      }
      const updated: MemoryLineageProposal = {
        ...current,
        status: "committing",
        transactionId: normalizedTransactionId,
        updatedAt: options.now ?? new Date().toISOString(),
      };
      snapshot.proposals[index] = updated;
      await this.save(snapshot);
      return updated;
    });
  }

  private async load(): Promise<MemoryLineageProposalSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, proposals: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new MemoryLineageProposalFormatError(
        this.filePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return validateMemoryLineageProposalSnapshot(parsed, this.filePath);
  }

  private async save(snapshot: MemoryLineageProposalSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonFileAtomic(this.filePath, snapshot);
  }
}

export function defaultMemoryLineageProposalStore(
  cwd: string,
  ctx?: SparkStateRootContext,
): MemoryLineageProposalStore {
  return new MemoryLineageProposalStore(
    sparkWorkspaceStatePath(cwd, ["memory", "lineage-proposals.json"], ctx),
  );
}

function createMemoryLineageProposal(
  input: CreateMemoryLineageProposalInput,
): MemoryLineageProposal {
  const operation = normalizeOperation(input.operation);
  const workspaceId = normalizeRef(input.workspaceId, "workspaceId");
  const sources = normalizeSources(input.sources);
  if (sources.length === 0) throw new Error("memory lineage proposal requires a source revision");
  if (operation === "propose_update" && sources.length !== 1) {
    throw new Error("memory update proposal requires exactly one source revision");
  }
  if (operation !== "propose_update" && sources.length < 2) {
    throw new Error("memory merge/supersede proposal requires at least two source revisions");
  }
  const target = normalizeTarget(input.target);
  const expectedRevision = normalizeRevision(input.expectedRevision);
  const previewRef = normalizeArtifactRef(input.previewRef);
  const createdAt = normalizeTimestamp(input.createdAt ?? new Date().toISOString(), "createdAt");
  const expiresAt = normalizeTimestamp(input.expiresAt, "expiresAt");
  if (expiresAt <= createdAt)
    throw new Error("memory lineage proposal expiry must follow creation");
  const frozen = {
    operation,
    workspaceId,
    sources,
    target,
    expectedRevision,
    previewRef,
  };
  const idempotencyKey = memoryContentDigest(frozen);
  const proposalDigest = memoryContentDigest({
    schema: MEMORY_LINEAGE_PROPOSAL_SCHEMA,
    ...frozen,
    idempotencyKey,
    expiresAt,
  });
  return {
    schema: MEMORY_LINEAGE_PROPOSAL_SCHEMA,
    proposalId: `memory-proposal:${proposalDigest.slice(0, 32)}`,
    operation,
    workspaceId,
    status: "pending",
    sources,
    target,
    expectedRevision,
    idempotencyKey,
    proposalDigest,
    previewRef,
    diff: {
      before: sources.map(({ recordRef, revisionRef, contentDigest }) => ({
        recordRef,
        revisionRef,
        contentDigest,
      })),
      after: { recordRef: target.recordRef, contentDigest: memoryContentDigest(target.content) },
    },
    createdAt,
    expiresAt,
    updatedAt: createdAt,
    committedAt: null,
    conflictStatus: null,
    transactionId: null,
  };
}

export function memoryLineageApprovalContent(proposal: MemoryLineageProposal): unknown {
  validateMemoryLineageProposal(proposal);
  return {
    proposalDigest: proposal.proposalDigest,
    operation: proposal.operation,
    workspaceId: proposal.workspaceId,
    sources: proposal.sources,
    target: proposal.target,
    expectedRevision: proposal.expectedRevision,
    previewRef: proposal.previewRef,
  };
}

export function assertMemoryLineageAuthorizationBound(
  proposal: MemoryLineageProposal,
  authorization: MemoryMutationAuthorization,
): void {
  validateMemoryLineageProposal(proposal);
  const operation = lineageApprovalOperation(proposal.operation);
  const approvalProposal = authorization.proposal;
  const proof = authorization.proof;
  if (
    approvalProposal.proposalId !== proposal.proposalId ||
    approvalProposal.workspaceId !== proposal.workspaceId ||
    approvalProposal.operation !== operation ||
    approvalProposal.scope !== proposal.target.scope ||
    approvalProposal.recordRef !== proposal.target.recordRef ||
    approvalProposal.expectedRevision !== proposal.expectedRevision ||
    approvalProposal.expiresAt !== proposal.expiresAt ||
    approvalProposal.contentDigest !==
      memoryContentDigest(memoryLineageApprovalContent(proposal)) ||
    proof.proposalId !== approvalProposal.proposalId ||
    proof.proposalDigest !== approvalProposal.proposalDigest ||
    proof.operation !== approvalProposal.operation ||
    proof.scope !== approvalProposal.scope ||
    proof.recordRef !== approvalProposal.recordRef ||
    proof.expectedRevision !== approvalProposal.expectedRevision ||
    proof.expiresAt !== approvalProposal.expiresAt
  ) {
    throw new Error(
      "canonical Ask approval is not bound to this memory lineage proposal and artifact",
    );
  }
}

export function assertMemoryLineageProposalCommittable(
  proposal: MemoryLineageProposal,
  currentSources: readonly FrozenMemoryRevisionSource[],
  now = new Date().toISOString(),
): void {
  validateMemoryLineageProposal(proposal);
  if (
    proposal.status !== "approved" &&
    proposal.status !== "committing" &&
    proposal.status !== "committed"
  ) {
    throw new Error(`memory lineage proposal is not approved: ${proposal.status}`);
  }
  if (proposal.expiresAt <= now) throw new Error("memory lineage proposal has expired");
  if (
    memoryContentDigest(normalizeSources(currentSources)) !== memoryContentDigest(proposal.sources)
  ) {
    throw new Error("memory lineage proposal source revisions changed before commit");
  }
}

export function suggestSemanticMemoryReview(input: {
  query: unknown;
  candidates: readonly { recordRef: string; score: number }[];
  threshold?: number;
}): MemorySemanticReviewSuggestion | undefined {
  const threshold = input.threshold ?? 0.75;
  const candidateRefs = input.candidates.flatMap((candidate) =>
    Number.isFinite(candidate.score) && candidate.score >= threshold
      ? [normalizeRef(candidate.recordRef, "candidate recordRef")]
      : [],
  );
  if (candidateRefs.length === 0) return undefined;
  return {
    kind: "review_suggestion",
    queryDigest: memoryContentDigest(input.query),
    candidateRefs: [...new Set(candidateRefs)].sort((left, right) => left.localeCompare(right)),
    reason: "Semantically similar memory requires explicit review; no mutation was performed.",
  };
}

export interface MemoryLineageProposalApprovalPayload {
  mode: "approval";
  previewRef: string;
  proposalId: string;
  proposalDigest: string;
  expectedRevision: number;
  expiresAt: string;
  risk: MemoryRisk;
  prompt: string;
}

export function memoryLineageProposalArtifactContentRef(
  proposal: MemoryLineageProposal,
): Record<string, unknown> {
  validateMemoryLineageProposal(proposal);
  return {
    memoryProposal: {
      schema: proposal.schema,
      proposalId: proposal.proposalId,
      workspaceId: proposal.workspaceId,
      operation: proposal.operation,
      status: proposal.status,
      diff: proposal.diff,
      lineage: {
        sources: proposal.sources,
        targetRecordRef: proposal.target.recordRef,
      },
      evidenceRefs: proposal.target.evidenceRefs,
      risk: proposal.target.risk,
      expectedRevision: proposal.expectedRevision,
      proposalDigest: proposal.proposalDigest,
      previewRef: proposal.previewRef,
      conflictStatus: proposal.conflictStatus,
      expiresAt: proposal.expiresAt,
    },
  };
}

export function memoryLineageProposalApprovalPayload(
  proposal: MemoryLineageProposal,
): MemoryLineageProposalApprovalPayload {
  validateMemoryLineageProposal(proposal);
  return {
    mode: "approval",
    previewRef: proposal.previewRef,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    expectedRevision: proposal.expectedRevision,
    expiresAt: proposal.expiresAt,
    risk: proposal.target.risk,
    prompt: `Approve immutable memory ${proposal.operation.replace("propose_", "")} proposal ${proposal.proposalId}?`,
  };
}

function validateMemoryLineageProposal(value: unknown): asserts value is MemoryLineageProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory lineage proposal must be an object");
  }
  const proposal = value as Partial<MemoryLineageProposal>;
  if (proposal.schema !== MEMORY_LINEAGE_PROPOSAL_SCHEMA) {
    throw new Error(`memory lineage proposal schema must be ${MEMORY_LINEAGE_PROPOSAL_SCHEMA}`);
  }
  const normalizedOperation = normalizeOperation(proposal.operation);
  const normalizedWorkspaceId = normalizeRef(proposal.workspaceId, "workspaceId");
  const normalizedSources = normalizeSources(proposal.sources ?? []);
  const normalizedTarget = normalizeTarget(proposal.target as MemoryLineageProposalTarget);
  const normalizedExpectedRevision = normalizeRevision(proposal.expectedRevision);
  const normalizedArtifactRef = normalizeArtifactRef(proposal.previewRef);
  const normalizedCreatedAt = normalizeTimestamp(proposal.createdAt, "createdAt");
  const normalizedExpiresAt = normalizeTimestamp(proposal.expiresAt, "expiresAt");
  normalizeTimestamp(proposal.updatedAt, "updatedAt");
  normalizeRef(proposal.proposalId, "proposalId");
  assertDigest(proposal.idempotencyKey, "idempotencyKey");
  assertDigest(proposal.proposalDigest, "proposalDigest");
  if (
    ![
      "pending",
      "approved",
      "committing",
      "rejected",
      "cancelled",
      "expired",
      "conflict",
      "committed",
    ].includes(String(proposal.status))
  ) {
    throw new Error("memory lineage proposal status is invalid");
  }
  if (proposal.transactionId !== null && proposal.transactionId !== undefined) {
    normalizeRef(proposal.transactionId, "transactionId");
  }
  if (
    (proposal.status === "committing" || proposal.status === "committed") &&
    !proposal.transactionId
  ) {
    throw new Error("committing memory lineage proposal requires a transaction id");
  }
  const canonical = createMemoryLineageProposal({
    operation: normalizedOperation,
    workspaceId: normalizedWorkspaceId,
    sources: normalizedSources,
    target: normalizedTarget,
    expectedRevision: normalizedExpectedRevision,
    previewRef: normalizedArtifactRef,
    createdAt: normalizedCreatedAt,
    expiresAt: normalizedExpiresAt,
  });
  if (
    proposal.idempotencyKey !== canonical.idempotencyKey ||
    proposal.proposalDigest !== canonical.proposalDigest ||
    proposal.proposalId !== canonical.proposalId ||
    memoryContentDigest(proposal.diff) !== memoryContentDigest(canonical.diff)
  ) {
    throw new Error("memory lineage proposal derived identity does not match frozen content");
  }
}

function validateMemoryLineageProposalSnapshot(
  value: unknown,
  filePath: string,
): MemoryLineageProposalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryLineageProposalFormatError(filePath, "root must be an object");
  }
  const snapshot = value as Partial<MemoryLineageProposalSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.proposals)) {
    throw new MemoryLineageProposalFormatError(filePath, "expected version 1 proposals array");
  }
  try {
    for (const proposal of snapshot.proposals) validateMemoryLineageProposal(proposal);
  } catch (error) {
    throw new MemoryLineageProposalFormatError(
      filePath,
      error instanceof Error ? error.message : String(error),
    );
  }
  return snapshot as MemoryLineageProposalSnapshot;
}

function assertAllowedTransition(
  current: MemoryLineageProposalStatus,
  next: MemoryLineageProposalStatus,
): void {
  const allowed: Record<MemoryLineageProposalStatus, readonly MemoryLineageProposalStatus[]> = {
    pending: ["approved", "rejected", "cancelled", "expired"],
    approved: ["cancelled", "expired", "conflict"],
    committing: ["committed", "conflict", "expired"],
    rejected: [],
    cancelled: [],
    expired: [],
    conflict: [],
    committed: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`memory lineage proposal transition ${current} -> ${next} is not allowed`);
  }
}

function normalizeArtifactRef(value: unknown): string {
  const previewRef = normalizeRef(value, "previewRef");
  if (!previewRef.startsWith("artifact:")) {
    throw new Error("memory lineage proposal approval requires exactly one artifact ref");
  }
  return previewRef;
}

function normalizeSources(
  values: readonly FrozenMemoryRevisionSource[],
): FrozenMemoryRevisionSource[] {
  return values
    .map((source) => ({
      recordRef: normalizeRef(source.recordRef, "source recordRef"),
      revisionRef: normalizeRef(source.revisionRef, "source revisionRef"),
      contentDigest: assertDigest(source.contentDigest, "source contentDigest"),
      scope: normalizeScope(source.scope),
    }))
    .sort(
      (left, right) =>
        left.recordRef.localeCompare(right.recordRef) ||
        left.revisionRef.localeCompare(right.revisionRef),
    );
}

function normalizeTarget(
  target: Omit<MemoryLineageProposalTarget, "evidenceRefs"> & {
    evidenceRefs?: readonly string[];
  },
): MemoryLineageProposalTarget {
  if (!target || typeof target !== "object") throw new Error("memory proposal target is required");
  if (target.kind !== "entry" && target.kind !== "learning") {
    throw new Error("memory proposal target kind must be entry or learning");
  }
  if (!target.content || typeof target.content !== "object" || Array.isArray(target.content)) {
    throw new Error("memory proposal target content must be an object");
  }
  return {
    kind: target.kind,
    recordRef: normalizeRef(target.recordRef, "target recordRef"),
    scope: normalizeScope(target.scope),
    risk: normalizeRisk(target.risk),
    content: structuredClone(target.content),
    evidenceRefs: [
      ...new Set((target.evidenceRefs ?? []).map((ref) => normalizeRef(ref, "evidenceRef"))),
    ].sort((left, right) => left.localeCompare(right)),
  };
}

function lineageApprovalOperation(
  operation: MemoryLineageProposalOperation,
): "update" | "merge" | "supersede" {
  if (operation === "propose_update") return "update";
  if (operation === "propose_merge") return "merge";
  return "supersede";
}

function normalizeOperation(value: unknown): MemoryLineageProposalOperation {
  if (value !== "propose_update" && value !== "propose_merge" && value !== "propose_supersede") {
    throw new Error("memory lineage proposal operation is invalid");
  }
  return value;
}

function normalizeScope(value: unknown): MemoryLifecycleScope {
  if (!["user", "workspace", "repo", "project", "agent"].includes(String(value))) {
    throw new Error("memory lineage proposal scope is invalid");
  }
  return value as MemoryLifecycleScope;
}

function normalizeRisk(value: unknown): MemoryRisk {
  if (value !== "normal" && value !== "behavior_changing" && value !== "sensitive") {
    throw new Error("memory lineage proposal risk is invalid");
  }
  return value;
}

function normalizeRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error("memory lineage proposal expectedRevision must be a positive integer");
  }
  return Number(value);
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`memory lineage proposal ${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /\s/u.test(value)) {
    throw new Error(`memory lineage proposal ${field} must be a non-empty ref`);
  }
  return value.trim();
}

function assertDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[\da-f]{64}$/u.test(value)) {
    throw new Error(`memory lineage proposal ${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}
