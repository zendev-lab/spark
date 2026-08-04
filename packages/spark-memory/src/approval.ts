import { createHash, randomUUID } from "node:crypto";
import {
  parseSparkMemoryApprovalProof,
  parseSparkMemoryProposal,
  type SparkMemoryApprovalProof,
  type SparkMemoryProposal,
  type SparkMemoryMutationOperation,
} from "@zendev-lab/spark-protocol";

import {
  memoryContentDigest,
  type MemoryLifecycleEnvelope,
  type MemoryRevision,
} from "./lifecycle.ts";

export interface MemoryApprovalTransactionContext {
  workspaceId: string;
  scope: MemoryLifecycleEnvelope["scope"];
  recordRef: string;
  operation: SparkMemoryMutationOperation;
  expectedRevision: number;
  content: unknown;
  proposalId?: string;
  transactionId?: string;
  now?: string;
}

export interface MemoryApprovalVerificationRequest extends MemoryApprovalTransactionContext {
  proposal: SparkMemoryProposal;
  proof: SparkMemoryApprovalProof;
}

export interface MemoryApprovalVerificationResult {
  proofRef: string;
  proposalDigest: string;
  transactionId: string;
  approvalStatus: "verified";
  reservationStatus: "reserved" | "committed";
}

export interface MemoryApprovalVerifier {
  verify(
    request: MemoryApprovalVerificationRequest,
  ): Promise<MemoryApprovalVerificationResult> | MemoryApprovalVerificationResult;
  commit(proof: SparkMemoryApprovalProof, transactionId: string): Promise<boolean> | boolean;
}

export interface MemoryMutationAuthorization {
  proposal: SparkMemoryProposal;
  proof: SparkMemoryApprovalProof;
  transactionId: string;
}

export interface MemoryAuthorizedCommitInput {
  verifier?: MemoryApprovalVerifier;
  authorization?: MemoryMutationAuthorization;
  lifecycle: MemoryLifecycleEnvelope;
  operation: SparkMemoryMutationOperation;
  workspaceId: string;
  scope: MemoryLifecycleEnvelope["scope"];
  recordRef: string;
  content: unknown;
  now?: string;
}

export interface MemoryAuthorizedCreationInput extends Omit<
  MemoryAuthorizedCommitInput,
  "lifecycle"
> {
  lifecycle: MemoryLifecycleEnvelope;
}

export interface MemoryAuthorizedCommitResult {
  lifecycle: MemoryLifecycleEnvelope;
  idempotent: boolean;
  finalize: () => Promise<void>;
}

export interface MemoryRevisionCommitInput {
  transactionId: string;
  proposalDigest: string;
  proofRef: string;
  now: string;
  content: unknown;
  predecessorRefs: readonly string[];
  expectedRevision: number;
}

export interface MemoryRevisionCommitResult {
  revision: MemoryRevision;
  idempotent: boolean;
}

export class MemoryApprovalError extends Error {
  readonly code:
    | "MEMORY_APPROVAL_REQUIRED"
    | "MEMORY_CANONICAL_ASK_REQUIRED"
    | "MEMORY_APPROVAL_INVALID"
    | "MEMORY_APPROVAL_EXPIRED"
    | "MEMORY_APPROVAL_REPLAYED"
    | "MEMORY_APPROVAL_SCOPE_MISMATCH"
    | "MEMORY_APPROVAL_PROPOSAL_MISMATCH"
    | "MEMORY_REVISION_CONFLICT";

  constructor(code: MemoryApprovalError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "MemoryApprovalError";
    this.code = code;
  }
}

export function createMemoryProposal(input: {
  proposalId?: string;
  operation: SparkMemoryMutationOperation;
  workspaceId: string;
  scope: MemoryLifecycleEnvelope["scope"];
  recordRef: string;
  expectedRevision: number;
  content: unknown;
  expiresAt: string;
}): SparkMemoryProposal {
  const proposalPayload: Omit<SparkMemoryProposal, "proposalDigest"> = {
    schema: "spark.memory.proposal/v1",
    proposalId: input.proposalId ?? `proposal:${randomUUID()}`,
    operation: input.operation,
    workspaceId: input.workspaceId,
    scope: input.scope,
    recordRef: input.recordRef,
    expectedRevision: input.expectedRevision,
    contentDigest: memoryContentDigest(input.content),
    expiresAt: input.expiresAt,
  };
  return parseSparkMemoryProposal({
    ...proposalPayload,
    proposalDigest: digestProposal(proposalPayload),
  });
}

export function digestProposal(proposal: Omit<SparkMemoryProposal, "proposalDigest">): string {
  return createHash("sha256").update(canonicalJson(proposal)).digest("hex");
}

export function createMemoryApprovalVerifier(options: {
  authenticateProof: (proof: SparkMemoryApprovalProof) => Promise<boolean> | boolean;
  reserveProof?: (
    proof: SparkMemoryApprovalProof,
    transactionId: string,
    allowCreate: boolean,
  ) => Promise<"reserved" | "committed" | false> | "reserved" | "committed" | false;
  commitProof?: (
    proof: SparkMemoryApprovalProof,
    transactionId: string,
  ) => Promise<boolean> | boolean;
  now?: () => string;
}): MemoryApprovalVerifier {
  if ((options.reserveProof === undefined) !== (options.commitProof === undefined)) {
    throw new Error("memory approval verifier requires both reserveProof and commitProof");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const bindings = new Map<
    string,
    { transactionId: string; proofDigest: string; committed: boolean }
  >();
  const transactions = new Map<string, { proofRef: string; proofDigest: string }>();
  return {
    async verify(request) {
      const { proposal: parsedProposal, proof: parsedProof } = parseApprovalInputs(request);
      const transactionId = request.transactionId ?? `transaction:${randomUUID()}`;
      const current = now();
      let authentic: boolean;
      try {
        authentic = await options.authenticateProof(parsedProof);
      } catch (error) {
        throw new MemoryApprovalError(
          "MEMORY_APPROVAL_INVALID",
          `approval proof authentication failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!authentic) {
        throw new MemoryApprovalError("MEMORY_APPROVAL_INVALID", "approval proof is not authentic");
      }
      assertProposalRequestBindings(request, parsedProposal, parsedProof);
      const expired = isApprovalExpired(parsedProposal, parsedProof, current);
      const proofDigest = memoryContentDigest(parsedProof);
      const prior = bindings.get(parsedProof.proofRef);
      if (
        prior !== undefined &&
        (prior.transactionId !== transactionId || prior.proofDigest !== proofDigest)
      ) {
        throw new MemoryApprovalError(
          "MEMORY_APPROVAL_REPLAYED",
          "approval proof has already been reserved for another binding",
        );
      }
      const transactionBinding = transactions.get(transactionId);
      if (
        transactionBinding !== undefined &&
        (transactionBinding.proofRef !== parsedProof.proofRef ||
          transactionBinding.proofDigest !== proofDigest)
      ) {
        throw new MemoryApprovalError(
          "MEMORY_APPROVAL_REPLAYED",
          "transaction id has already been reserved for another proof",
        );
      }
      let reservationStatus: "reserved" | "committed" = prior?.committed ? "committed" : "reserved";
      if (options.reserveProof) {
        let reservation: "reserved" | "committed" | false;
        try {
          reservation = await options.reserveProof(parsedProof, transactionId, !expired);
        } catch (error) {
          throw new MemoryApprovalError(
            "MEMORY_APPROVAL_INVALID",
            `approval proof reservation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!reservation) {
          if (expired) assertApprovalNotExpired(parsedProposal, parsedProof, current);
          throw new MemoryApprovalError(
            "MEMORY_APPROVAL_REPLAYED",
            "approval proof was rejected as already reserved",
          );
        }
        reservationStatus = reservation;
      } else if (expired && prior === undefined) {
        assertApprovalNotExpired(parsedProposal, parsedProof, current);
      }
      bindings.set(parsedProof.proofRef, {
        transactionId,
        proofDigest,
        committed: reservationStatus === "committed",
      });
      transactions.set(transactionId, { proofRef: parsedProof.proofRef, proofDigest });
      return {
        proofRef: parsedProof.proofRef,
        proposalDigest: parsedProposal.proposalDigest,
        transactionId,
        approvalStatus: "verified",
        reservationStatus,
      };
    },
    async commit(proof, transactionId) {
      const parsedProof = parseSparkMemoryApprovalProof(proof);
      const proofDigest = memoryContentDigest(parsedProof);
      const prior = bindings.get(parsedProof.proofRef);
      if (
        prior !== undefined &&
        (prior.transactionId !== transactionId || prior.proofDigest !== proofDigest)
      ) {
        return false;
      }
      if (!prior) return false;
      if (options.commitProof) {
        let committed: boolean;
        try {
          committed = await options.commitProof(parsedProof, transactionId);
        } catch (error) {
          throw new MemoryApprovalError(
            "MEMORY_APPROVAL_INVALID",
            `approval proof commit failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!committed) return false;
      } else if (options.reserveProof) {
        return false;
      }
      bindings.set(parsedProof.proofRef, {
        transactionId,
        proofDigest,
        committed: true,
      });
      transactions.set(transactionId, { proofRef: parsedProof.proofRef, proofDigest });
      return true;
    },
  };
}

export async function commitAuthorizedMemoryCreation(
  input: MemoryAuthorizedCreationInput,
): Promise<MemoryAuthorizedCommitResult> {
  const authorization = requireAuthorization(input.verifier, input.authorization);
  if (authorization.proposal.expectedRevision !== 0) {
    throw new MemoryApprovalError(
      "MEMORY_REVISION_CONFLICT",
      `new memory requires expected revision 0, received ${authorization.proposal.expectedRevision}`,
    );
  }
  const verified = await input.verifier!.verify({
    workspaceId: input.workspaceId,
    scope: input.scope,
    recordRef: input.recordRef,
    operation: input.operation,
    expectedRevision: 0,
    content: input.content,
    proposalId: authorization.proposal.proposalId,
    transactionId: authorization.transactionId,
    proposal: authorization.proposal,
    proof: authorization.proof,
  });
  assertCommittedApprovalHasRevision(input.lifecycle, verified);
  const now = input.now ?? new Date().toISOString();
  const revision: MemoryRevision = {
    version: 1,
    revisionRef: `${input.recordRef}:revision:1`,
    contentDigest: memoryContentDigest(input.content),
    createdAt: now,
    predecessorRefs: [],
    transactionId: verified.transactionId,
    proposalDigest: verified.proposalDigest,
    proofRef: verified.proofRef,
  };
  return {
    idempotent: false,
    lifecycle: approvedLifecycle(input.lifecycle, revision, verified, now),
    finalize: () => finalizeMemoryApproval(input.verifier!, authorization),
  };
}

export async function commitAuthorizedMemoryMutation(
  input: MemoryAuthorizedCommitInput,
): Promise<MemoryAuthorizedCommitResult> {
  const authorization = requireAuthorization(input.verifier, input.authorization);
  const priorProof = input.lifecycle.revisionHistory.find(
    (revision) => revision.proofRef === authorization.proof.proofRef,
  );
  if (priorProof && priorProof.transactionId !== authorization.transactionId) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_REPLAYED",
      "approval proof is already bound to another transaction",
    );
  }
  const prior = input.lifecycle.revisionHistory.find(
    (revision) => revision.transactionId === authorization.transactionId,
  );
  if (prior) {
    if (
      prior.proposalDigest !== authorization.proposal.proposalDigest ||
      prior.proofRef !== authorization.proof.proofRef
    ) {
      throw new MemoryApprovalError(
        "MEMORY_APPROVAL_REPLAYED",
        "transaction id is already bound to another proposal or proof",
      );
    }
    const verifiedRetry = await input.verifier!.verify({
      workspaceId: input.workspaceId,
      scope: input.scope,
      recordRef: input.recordRef,
      operation: input.operation,
      expectedRevision: authorization.proposal.expectedRevision,
      content: input.content,
      proposalId: authorization.proposal.proposalId,
      transactionId: authorization.transactionId,
      proposal: authorization.proposal,
      proof: authorization.proof,
    });
    assertCommittedApprovalHasRevision(input.lifecycle, verifiedRetry);
    return {
      lifecycle: input.lifecycle,
      idempotent: true,
      finalize: () => finalizeMemoryApproval(input.verifier!, authorization),
    };
  }
  const expectedRevision = authorization.proposal.expectedRevision;
  if (expectedRevision !== input.lifecycle.revision.version) {
    throw new MemoryApprovalError(
      "MEMORY_REVISION_CONFLICT",
      `expected revision ${expectedRevision}, current revision is ${input.lifecycle.revision.version}`,
    );
  }
  const verified = await input.verifier!.verify({
    workspaceId: input.workspaceId,
    scope: input.scope,
    recordRef: input.recordRef,
    operation: input.operation,
    expectedRevision,
    content: input.content,
    proposalId: authorization.proposal.proposalId,
    transactionId: authorization.transactionId,
    proposal: authorization.proposal,
    proof: authorization.proof,
  });
  assertCommittedApprovalHasRevision(input.lifecycle, verified);
  const now = input.now ?? new Date().toISOString();
  const revision = appendMemoryRevision(input.lifecycle, {
    transactionId: verified.transactionId,
    proposalDigest: verified.proposalDigest,
    proofRef: verified.proofRef,
    now,
    content: input.content,
    predecessorRefs: [input.lifecycle.revision.revisionRef],
    expectedRevision,
  }).revision;
  return {
    idempotent: false,
    lifecycle: approvedLifecycle(input.lifecycle, revision, verified, now),
    finalize: () => finalizeMemoryApproval(input.verifier!, authorization),
  };
}

function assertCommittedApprovalHasRevision(
  lifecycle: MemoryLifecycleEnvelope,
  verified: MemoryApprovalVerificationResult,
): void {
  if (verified.reservationStatus !== "committed") return;
  const persisted = lifecycle.revisionHistory.some(
    (revision) =>
      revision.transactionId === verified.transactionId &&
      revision.proposalDigest === verified.proposalDigest &&
      revision.proofRef === verified.proofRef,
  );
  if (!persisted) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_REPLAYED",
      "committed approval proof has no matching immutable memory revision",
    );
  }
}

async function finalizeMemoryApproval(
  verifier: MemoryApprovalVerifier,
  authorization: MemoryMutationAuthorization,
): Promise<void> {
  let committed: boolean;
  try {
    committed = await verifier.commit(authorization.proof, authorization.transactionId);
  } catch (error) {
    if (error instanceof MemoryApprovalError) throw error;
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_INVALID",
      `approval proof commit failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!committed) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_REPLAYED",
      "approval proof could not be committed for this transaction",
    );
  }
}

export function appendUnapprovedMemoryRevision(
  current: MemoryLifecycleEnvelope,
  input: {
    operation: "reject";
    content: unknown;
    now: string;
    expectedRevision: number;
  },
): MemoryLifecycleEnvelope {
  if (input.expectedRevision !== current.revision.version) {
    throw new MemoryApprovalError(
      "MEMORY_REVISION_CONFLICT",
      `expected revision ${input.expectedRevision}, current revision is ${current.revision.version}`,
    );
  }
  const revision: MemoryRevision = {
    version: current.revision.version + 1,
    revisionRef: `${current.revision.revisionRef.split(":revision:")[0]}:revision:${current.revision.version + 1}`,
    contentDigest: memoryContentDigest(input.content),
    createdAt: input.now,
    predecessorRefs: [current.revision.revisionRef],
    transactionId: `system:${input.operation}:${randomUUID()}`,
    proposalDigest: null,
    proofRef: null,
  };
  return {
    ...current,
    revision,
    revisionHistory: [...current.revisionHistory, revision],
    lineage: {
      ...current.lineage,
      predecessors: uniqueStrings([...current.lineage.predecessors, current.revision.revisionRef]),
    },
  };
}

export function appendMemoryRevision(
  current: MemoryLifecycleEnvelope,
  input: MemoryRevisionCommitInput,
): MemoryRevisionCommitResult {
  const currentRevision = current.revision.version;
  if (input.expectedRevision !== currentRevision) {
    throw new MemoryApprovalError(
      "MEMORY_REVISION_CONFLICT",
      `expected revision ${input.expectedRevision}, current revision is ${currentRevision}`,
    );
  }
  const revision: MemoryRevision = {
    version: currentRevision + 1,
    revisionRef: `${current.revision.revisionRef.split(":revision:")[0]}:revision:${currentRevision + 1}`,
    contentDigest: memoryContentDigest(input.content),
    createdAt: input.now,
    predecessorRefs: [...input.predecessorRefs],
    transactionId: input.transactionId,
    proposalDigest: input.proposalDigest,
    proofRef: input.proofRef,
  };
  return { revision, idempotent: false };
}

function parseApprovalInputs(request: MemoryApprovalVerificationRequest): {
  proposal: SparkMemoryProposal;
  proof: SparkMemoryApprovalProof;
} {
  try {
    return {
      proposal: parseSparkMemoryProposal(request.proposal),
      proof: parseSparkMemoryApprovalProof(request.proof),
    };
  } catch (error) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_INVALID",
      `approval proposal or proof schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireAuthorization(
  verifier: MemoryApprovalVerifier | undefined,
  authorization: MemoryMutationAuthorization | undefined,
): MemoryMutationAuthorization {
  if (!verifier || !authorization) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_REQUIRED",
      "durable memory mutation requires a host approval verifier and proof",
    );
  }
  return authorization;
}

function assertProposalRequestBindings(
  request: MemoryApprovalVerificationRequest,
  proposal: SparkMemoryProposal,
  proof: SparkMemoryApprovalProof,
): void {
  if (!request.proposalId || request.proposalId !== proposal.proposalId) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      "proposal id is not bound to the request",
    );
  }
  if (request.workspaceId !== proposal.workspaceId || request.workspaceId !== proof.workspaceId) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_SCOPE_MISMATCH",
      "workspace binding does not match",
    );
  }
  if (request.scope !== proposal.scope || request.scope !== proof.scope) {
    throw new MemoryApprovalError("MEMORY_APPROVAL_SCOPE_MISMATCH", "scope binding does not match");
  }
  if (request.operation !== proposal.operation || request.operation !== proof.operation) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      "operation binding does not match",
    );
  }
  if (
    request.recordRef !== proposal.recordRef ||
    proof.recordRef !== proposal.recordRef ||
    proof.proposalId !== proposal.proposalId
  ) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      "record or proposal binding does not match",
    );
  }
  if (
    request.expectedRevision !== proposal.expectedRevision ||
    request.expectedRevision !== proof.expectedRevision
  ) {
    throw new MemoryApprovalError(
      "MEMORY_REVISION_CONFLICT",
      "expected revision binding does not match",
    );
  }
  if (proposal.contentDigest !== memoryContentDigest(request.content)) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      "content digest does not match proposal",
    );
  }
  const { proposalDigest: _proposalDigest, ...proposalPayload } = proposal;
  if (
    proof.proposalDigest !== proposal.proposalDigest ||
    proposal.proposalDigest !== digestProposal(proposalPayload)
  ) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      "proposal digest is invalid",
    );
  }
}

function isApprovalExpired(
  proposal: SparkMemoryProposal,
  proof: SparkMemoryApprovalProof,
  now: string,
): boolean {
  assertVerifierClock(now);
  return (
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    !Number.isFinite(Date.parse(proposal.expiresAt)) ||
    Date.parse(proof.expiresAt) <= Date.parse(now) ||
    Date.parse(proposal.expiresAt) <= Date.parse(now)
  );
}

function assertVerifierClock(now: string): void {
  if (!Number.isFinite(Date.parse(now))) {
    throw new MemoryApprovalError("MEMORY_APPROVAL_INVALID", "verifier clock is invalid");
  }
}

function assertApprovalNotExpired(
  proposal: SparkMemoryProposal,
  proof: SparkMemoryApprovalProof,
  now: string,
): void {
  if (isApprovalExpired(proposal, proof, now)) {
    throw new MemoryApprovalError(
      "MEMORY_APPROVAL_EXPIRED",
      "approval proof or proposal has expired",
    );
  }
}

function approvedLifecycle(
  current: MemoryLifecycleEnvelope,
  revision: MemoryRevision,
  verified: MemoryApprovalVerificationResult,
  now: string,
): MemoryLifecycleEnvelope {
  const predecessorRefs =
    revision.version === 1
      ? current.lineage.predecessors
      : uniqueStrings([...current.lineage.predecessors, current.revision.revisionRef]);
  return {
    ...current,
    revision,
    revisionHistory: revision.version === 1 ? [revision] : [...current.revisionHistory, revision],
    lineage: { ...current.lineage, predecessors: predecessorRefs },
    approval: {
      status: "verified",
      proofRef: verified.proofRef,
      proposalDigest: verified.proposalDigest,
      approvedAt: now,
      actorKind: "user",
    },
    provenance: { ...current.provenance, legacyUnverified: false },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("memory approval digest value must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`memory approval digest value is not JSON-compatible: ${typeof value}`);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
