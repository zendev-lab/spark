import { readFile, rm } from "node:fs/promises";

import { writeJsonFileAtomic } from "@zendev-lab/spark-platform-node/json-files";
import {
  parseSparkMemoryApprovalAuthorization,
  type SparkMemoryApprovalProof,
  type SparkMemoryProposal,
} from "@zendev-lab/spark-protocol";

import { memoryContentDigest, type MemoryLifecycleEnvelope } from "./lifecycle.ts";
import type { MemoryApprovalVerifier } from "./approval.ts";

type MemoryMutationJournalState = "prepared" | "persisted";

export interface MemoryMutationJournalRecord {
  version: 1;
  state: MemoryMutationJournalState;
  operation: string;
  recordRef: string;
  transactionId: string;
  proposalDigest: string;
  contentDigest: string;
  /** Optional immutable record content digest when approval content is a transaction bundle. */
  targetContentDigest?: string;
  content: unknown;
  workspaceId: string;
  scope: MemoryLifecycleEnvelope["scope"];
  expectedRevision: number;
  proposalId: string;
  proposal: SparkMemoryProposal;
  proof: SparkMemoryApprovalProof;
}

class MemoryMutationRecoveryError extends Error {
  constructor(message: string) {
    super(`memory mutation recovery required: ${message}`);
    this.name = "MemoryMutationRecoveryError";
  }
}

export function assertMemoryMutationJournalTarget(
  lifecycle: Pick<MemoryLifecycleEnvelope, "recordRef" | "revision" | "revisionHistory">,
  content: unknown,
  journal: MemoryMutationJournalRecord,
): boolean {
  if (lifecycle.recordRef !== journal.recordRef) {
    throw new MemoryMutationRecoveryError(
      `target record does not match journal record ${journal.recordRef}`,
    );
  }
  const bindingRevisions = lifecycle.revisionHistory.filter(
    (revision) =>
      revision.transactionId === journal.transactionId ||
      revision.proofRef === journal.proof.proofRef,
  );
  if (bindingRevisions.length === 0) {
    if (lifecycle.revision.version !== journal.expectedRevision) {
      throw new MemoryMutationRecoveryError(
        `target ${journal.recordRef} has revision ${lifecycle.revision.version}, expected journal revision ${journal.expectedRevision}`,
      );
    }
    return false;
  }
  if (
    bindingRevisions.some(
      (revision) =>
        revision.transactionId !== journal.transactionId ||
        revision.proofRef !== journal.proof.proofRef,
    )
  ) {
    throw new MemoryMutationRecoveryError(
      `target ${journal.recordRef} has a partial or cross-revision transaction/proof binding for journal recovery`,
    );
  }
  if (!isMemoryMutationJournalTarget(lifecycle, content, journal)) {
    throw new MemoryMutationRecoveryError(
      `target ${journal.recordRef} contains the journal transaction or proof with mismatched content or bindings`,
    );
  }
  return true;
}

function isMemoryMutationJournalTarget(
  lifecycle: Pick<MemoryLifecycleEnvelope, "recordRef" | "revision" | "revisionHistory">,
  content: unknown,
  journal: MemoryMutationJournalRecord,
): boolean {
  return (
    lifecycle.recordRef === journal.recordRef &&
    lifecycle.revisionHistory.some(
      (revision) =>
        revision.transactionId === journal.transactionId &&
        revision.proposalDigest === journal.proposalDigest &&
        revision.proofRef === journal.proof.proofRef &&
        (journal.targetContentDigest ?? journal.contentDigest) === memoryContentDigest(content),
    )
  );
}

export async function recoverMemoryMutationJournal(
  journalPath: string,
  verifier: MemoryApprovalVerifier | undefined,
  targetMatches: (journal: MemoryMutationJournalRecord) => Promise<boolean>,
): Promise<void> {
  const journal = await readJournal(journalPath);
  if (!journal) return;
  const persisted = await targetMatches(journal);
  if (!persisted && journal.state === "persisted") {
    throw new MemoryMutationRecoveryError(
      `journal ${journalPath} is marked persisted but target ${journal.recordRef} is missing or mismatched`,
    );
  }
  if (!persisted) {
    // Keep a prepared journal for the exact transaction retry; deleting it would
    // discard the only durable binding after a crash before target persistence.
    return;
  }
  if (!verifier) {
    throw new MemoryMutationRecoveryError(
      `target ${journal.recordRef} is persisted but no approval verifier is available`,
    );
  }
  try {
    await verifier.verify({
      workspaceId: journal.workspaceId,
      scope: journal.scope,
      recordRef: journal.recordRef,
      operation: journal.proposal.operation,
      expectedRevision: journal.expectedRevision,
      content: journal.content,
      proposalId: journal.proposalId,
      transactionId: journal.transactionId,
      proposal: journal.proposal,
      proof: journal.proof,
    });
    if (!(await verifier.commit(journal.proof, journal.transactionId))) {
      throw new Error("proof commit returned false");
    }
  } catch (error) {
    throw new MemoryMutationRecoveryError(
      `target ${journal.recordRef} is persisted but its approval proof could not be committed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await rm(journalPath, { force: true });
}

export async function prepareMemoryMutationJournal(
  journalPath: string,
  input: Omit<MemoryMutationJournalRecord, "version" | "state">,
): Promise<MemoryMutationJournalRecord> {
  const existing = await readJournal(journalPath);
  const prepared: MemoryMutationJournalRecord = { version: 1, state: "prepared", ...input };
  if (existing) {
    if (!sameJournalBinding(existing, prepared)) {
      throw new MemoryMutationRecoveryError(`journal ${journalPath} is bound to another mutation`);
    }
    return existing;
  }
  await writeJsonFileAtomic(journalPath, prepared);
  return prepared;
}

export async function markMemoryMutationPersisted(
  journalPath: string,
  journal: MemoryMutationJournalRecord,
): Promise<void> {
  await writeJsonFileAtomic(journalPath, { ...journal, state: "persisted" });
}

export async function clearMemoryMutationJournal(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true });
}

export function memoryMutationJournalInput(input: {
  operation: string;
  recordRef: string;
  transactionId: string;
  proposalDigest: string;
  content: unknown;
  targetContent?: unknown;
  workspaceId: string;
  scope: MemoryLifecycleEnvelope["scope"];
  expectedRevision: number;
  proposalId: string;
  proposal: SparkMemoryProposal;
  proof: SparkMemoryApprovalProof;
}): Omit<MemoryMutationJournalRecord, "version" | "state"> {
  return {
    operation: input.operation,
    recordRef: input.recordRef,
    transactionId: input.transactionId,
    proposalDigest: input.proposalDigest,
    contentDigest: memoryContentDigest(input.content),
    ...(input.targetContent === undefined
      ? {}
      : { targetContentDigest: memoryContentDigest(input.targetContent) }),
    content: input.content,
    workspaceId: input.workspaceId,
    scope: input.scope,
    expectedRevision: input.expectedRevision,
    proposalId: input.proposalId,
    proposal: input.proposal,
    proof: input.proof,
  };
}

async function readJournal(journalPath: string): Promise<MemoryMutationJournalRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryMutationRecoveryError(`invalid journal ${journalPath}`);
  }
  const journal = value as Partial<MemoryMutationJournalRecord>;
  if (
    journal.version !== 1 ||
    (journal.state !== "prepared" && journal.state !== "persisted") ||
    typeof journal.operation !== "string" ||
    typeof journal.recordRef !== "string" ||
    !/^transaction:[^\s]+$/u.test(journal.transactionId ?? "") ||
    !/^[a-f\d]{64}$/u.test(journal.proposalDigest ?? "") ||
    !/^[a-f\d]{64}$/u.test(journal.contentDigest ?? "") ||
    (journal.targetContentDigest !== undefined &&
      !/^[a-f\d]{64}$/u.test(journal.targetContentDigest)) ||
    typeof journal.workspaceId !== "string" ||
    typeof journal.scope !== "string" ||
    !Number.isInteger(journal.expectedRevision) ||
    typeof journal.proposalId !== "string" ||
    !("content" in journal)
  ) {
    throw new MemoryMutationRecoveryError(`invalid journal ${journalPath}`);
  }
  try {
    const authorization = parseSparkMemoryApprovalAuthorization({
      proposal: journal.proposal,
      proof: journal.proof,
    });
    const proposal = authorization.proposal;
    const proof = authorization.proof;
    const contentDigest = memoryContentDigest(journal.content);
    if (
      journal.operation !== proposal.operation ||
      journal.operation !== proof.operation ||
      journal.recordRef !== proposal.recordRef ||
      journal.recordRef !== proof.recordRef ||
      journal.workspaceId !== proposal.workspaceId ||
      journal.workspaceId !== proof.workspaceId ||
      journal.scope !== proposal.scope ||
      journal.scope !== proof.scope ||
      journal.expectedRevision !== proposal.expectedRevision ||
      journal.expectedRevision !== proof.expectedRevision ||
      journal.proposalId !== proposal.proposalId ||
      journal.proposalId !== proof.proposalId ||
      journal.proposalDigest !== proposal.proposalDigest ||
      journal.proposalDigest !== proof.proposalDigest ||
      journal.contentDigest !== proposal.contentDigest ||
      journal.contentDigest !== contentDigest
    ) {
      throw new Error("journal bindings are inconsistent");
    }
    return { ...journal, proposal, proof } as MemoryMutationJournalRecord;
  } catch (error) {
    throw new MemoryMutationRecoveryError(
      `invalid journal ${journalPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sameJournalBinding(
  left: MemoryMutationJournalRecord,
  right: MemoryMutationJournalRecord,
): boolean {
  return journalBindingDigest(left) === journalBindingDigest(right);
}

function journalBindingDigest(journal: MemoryMutationJournalRecord): string {
  return memoryContentDigest({
    operation: journal.operation,
    recordRef: journal.recordRef,
    transactionId: journal.transactionId,
    proposalDigest: journal.proposalDigest,
    contentDigest: journal.contentDigest,
    targetContentDigest: journal.targetContentDigest ?? null,
    content: journal.content,
    workspaceId: journal.workspaceId,
    scope: journal.scope,
    expectedRevision: journal.expectedRevision,
    proposalId: journal.proposalId,
    proposal: journal.proposal,
    proof: journal.proof,
  });
}
