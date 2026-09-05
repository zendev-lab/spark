import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ToolConfig } from "@zendev-lab/spark-invocation";
import sparkMemoryExtension from "./extension.ts";

import { EvidenceStore } from "@zendev-lab/spark-artifacts";
import type {
  SparkMemoryApprovalProof,
  SparkMemoryMutationOperation,
} from "@zendev-lab/spark-protocol";
import {
  createFileMemoryApprovalProofCommitter,
  createFileMemoryApprovalProofReserver,
  createMemoryApprovalVerifier,
  createMemoryProposal,
  defaultSparkMemoryStore,
  LearningStore,
  MemoryApprovalError,
  RecallStore,
  type LearningEvidenceStore,
  type MemoryMutationAuthorization,
  type SparkMemoryStore,
} from "./index.ts";

const NOW = "2026-07-30T12:00:00.000Z";
const FUTURE = "2026-07-30T13:00:00.000Z";
const WORKSPACE = "workspace:test";

const rememberedContent = {
  category: "preference" as const,
  text: "Use pnpm for this Spark workspace.",
  reason: "The user explicitly approved this durable preference.",
  tags: ["package-manager"],
};

function activeEntryContent() {
  return {
    ...rememberedContent,
    evidenceRefs: [] as string[],
    status: "active" as const,
    forgottenReason: null,
  };
}

function verifier() {
  return createMemoryApprovalVerifier({
    now: () => NOW,
    authenticateProof: (proof) => proof.nonce.startsWith("auth:"),
  });
}

function authorization(input: {
  recordRef: string;
  operation?: SparkMemoryMutationOperation;
  expectedRevision?: number;
  content?: unknown;
  workspaceId?: string;
  expiresAt?: string;
  proposalId?: string;
  proofRef?: string;
  transactionId?: string;
  nonce?: string;
}): MemoryMutationAuthorization {
  const operation = input.operation ?? "remember";
  const proposal = createMemoryProposal({
    proposalId: input.proposalId,
    operation,
    workspaceId: input.workspaceId ?? WORKSPACE,
    scope: "workspace",
    recordRef: input.recordRef,
    expectedRevision: input.expectedRevision ?? 0,
    content: input.content ?? activeEntryContent(),
    expiresAt: input.expiresAt ?? FUTURE,
  });
  const proof: SparkMemoryApprovalProof = {
    schema: "spark.memory.approval-proof/v1",
    proofRef: input.proofRef ?? `evidence:${proposal.proposalId}`,
    workspaceId: proposal.workspaceId,
    recordRef: proposal.recordRef,
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    proposalDigest: proposal.proposalDigest,
    scope: proposal.scope,
    expectedRevision: proposal.expectedRevision,
    issuedAt: NOW,
    expiresAt: proposal.expiresAt,
    nonce: input.nonce ?? `auth:${proposal.proposalId}`,
    answerDigest: "a".repeat(64),
  };
  return {
    proposal,
    proof,
    transactionId: input.transactionId ?? `transaction:${proposal.proposalId}`,
  };
}

async function remember(
  store: SparkMemoryStore,
  recordRef: string,
  approval?: MemoryMutationAuthorization,
) {
  return store.remember({
    id: recordRef,
    scope: "workspace",
    ...rememberedContent,
    authorization: approval,
  });
}

function durableVerifier(ledgerPath: string, current = NOW) {
  return createMemoryApprovalVerifier({
    now: () => current,
    authenticateProof: (proof) => proof.nonce.startsWith("auth:"),
    reserveProof: createFileMemoryApprovalProofReserver(ledgerPath, { now: () => NOW }),
    commitProof: createFileMemoryApprovalProofCommitter(ledgerPath, { now: () => NOW }),
  });
}

async function readApprovalLedger(ledgerPath: string) {
  return JSON.parse(await readFile(ledgerPath, "utf8")) as {
    version: 2;
    consumptions: Array<{
      proofRef: string;
      transactionId: string;
      proofDigest: string;
      status: "reserved" | "committed";
      reservedAt: string;
      committedAt?: string;
    }>;
  };
}

function verificationRequest(
  approval: MemoryMutationAuthorization,
  content: unknown = activeEntryContent(),
) {
  return {
    workspaceId: WORKSPACE,
    scope: "workspace" as const,
    recordRef: approval.proposal.recordRef,
    operation: approval.proposal.operation,
    expectedRevision: approval.proposal.expectedRevision,
    content,
    proposalId: approval.proposal.proposalId,
    transactionId: approval.transactionId,
    proposal: approval.proposal,
    proof: approval.proof,
  };
}

function forgottenContent(reason: string) {
  return {
    ...activeEntryContent(),
    status: "forgotten",
    forgottenReason: reason,
  };
}

async function snapshotHash(filePath: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    bytes = Buffer.from("<missing>");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertRejectedWithoutMutation(
  filePath: string,
  expectedCode: MemoryApprovalError["code"],
  operation: () => Promise<unknown>,
) {
  const before = await snapshotHash(filePath);
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof MemoryApprovalError);
    assert.equal(error.code, expectedCode);
    return true;
  });
  assert.equal(await snapshotHash(filePath), before);
}

test("canonical memory tool fails closed without a host verifier and preserves snapshot bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-tool-approval-"));
  const filePath = join(dir, "memory.json");
  try {
    const tools = new Map<string, ToolConfig>();
    sparkMemoryExtension(
      {
        registerTool(config) {
          tools.set(config.name, config);
        },
        getAllTools() {
          return [];
        },
      },
      { storePaths: { workspace: filePath } },
    );
    const tool = tools.get("memory");
    assert.ok(tool);
    await assertRejectedWithoutMutation(filePath, "MEMORY_APPROVAL_REQUIRED", async () =>
      tool.execute(
        "memory-tool-missing-approval",
        {
          action: "remember",
          scope: "workspace",
          category: rememberedContent.category,
          text: rememberedContent.text,
          reason: rememberedContent.reason,
          tags: rememberedContent.tags,
        },
        new AbortController().signal,
        () => {},
        { cwd: dir },
      ),
    );
    await assertRejectedWithoutMutation(filePath, "MEMORY_APPROVAL_INVALID", async () =>
      tool.execute(
        "memory-tool-malformed-approval",
        {
          action: "remember",
          scope: "workspace",
          category: rememberedContent.category,
          text: rememberedContent.text,
          reason: rememberedContent.reason,
          tags: rememberedContent.tags,
          proposal: {},
          approvalProof: {},
          transactionId: "transaction:malformed-tool-approval",
        },
        new AbortController().signal,
        () => {},
        { cwd: dir },
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("candidate rejection is approval-free, revisioned, and limited to candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-candidate-rejection-"));
  const recallPath = join(dir, "recall.json");
  const learningRoot = join(dir, "learnings");
  try {
    const recall = new RecallStore(recallPath);
    const recallCandidate = await recall.record({
      scope: "workspace",
      text: "Review before promotion.",
      reason: "Candidate-only lifecycle check.",
    });
    const rejectedRecall = await recall.reject(recallCandidate.id, "Not durable.");
    assert.equal(rejectedRecall.lifecycle.revision.version, 2);
    assert.equal(rejectedRecall.lifecycle.revisionHistory.length, 2);
    assert.match(rejectedRecall.lifecycle.revision.transactionId ?? "", /^system:reject:/u);
    await assert.rejects(
      () => recall.reject(recallCandidate.id, "Reject twice."),
      /only candidate/,
    );
    await assert.rejects(
      () => recall.restoreMany([recallCandidate.id]),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );
    await assert.rejects(
      () => recall.purgeRejected([recallCandidate.id]),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );

    const learnings = new LearningStore({
      evidenceStore: new EvidenceStore({ rootDir: learningRoot }),
      mutationLockPath: join(learningRoot, ".mutation.lock"),
    });
    const learningCandidate = await learnings.record({
      id: "learning-rejection-revision",
      title: "Revision candidate",
      statement: "Candidate rejection must remain auditable.",
      status: "candidate",
    });
    const exactCandidateRetry = await learnings.record({
      id: "learning-rejection-revision",
      title: "Revision candidate",
      statement: "Candidate rejection must remain auditable.",
      status: "candidate",
    });
    assert.equal(exactCandidateRetry.body.lifecycle.revision.version, 1);
    await assert.rejects(
      () =>
        learnings.record({
          id: "learning-rejection-revision",
          title: "Revision candidate",
          statement: "Divergent candidate content.",
          status: "candidate",
        }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_REVISION_CONFLICT");
        return true;
      },
    );
    const rejectedLearning = await learnings.rejectCandidate(
      learningCandidate.ref,
      "Not generally applicable.",
    );
    assert.equal(rejectedLearning.body.lifecycle.revision.version, 2);
    assert.equal(rejectedLearning.body.lifecycle.revisionHistory.length, 2);
    assert.match(rejectedLearning.body.lifecycle.revision.transactionId ?? "", /^system:reject:/u);
    const restoreCandidate = structuredClone(rejectedLearning.body);
    restoreCandidate.status = "candidate";
    restoreCandidate.rejectedReason = null;
    restoreCandidate.rejectedAt = null;
    restoreCandidate.lifecycle.state = "candidate";
    await assert.rejects(
      () => learnings.restore(restoreCandidate),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );
    await assert.rejects(
      () => learnings.rejectCandidate(learningCandidate.ref, "Reject twice."),
      /only candidate/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable proof reservation survives verifier restart and rejects cross-record replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-consumption-"));
  const ledgerPath = join(dir, "approval-consumptions.json");
  try {
    const first = authorization({
      recordRef: "memory:ledger-first",
      proposalId: "proposal:ledger-first",
      proofRef: "evidence:ledger-proof",
      transactionId: "transaction:ledger-first",
    });
    const initialVerifier = durableVerifier(ledgerPath);
    await initialVerifier.verify(verificationRequest(first));
    let ledger = await readApprovalLedger(ledgerPath);
    assert.equal(ledger.version, 2);
    assert.equal(ledger.consumptions[0]?.status, "reserved");
    assert.equal(ledger.consumptions[0]?.reservedAt, NOW);
    assert.equal(ledger.consumptions[0]?.committedAt, undefined);

    const restartedVerifier = durableVerifier(ledgerPath);
    const restartedResult = await restartedVerifier.verify(verificationRequest(first));
    assert.equal(restartedResult.transactionId, first.transactionId);

    const crossRecord = authorization({
      recordRef: "memory:ledger-other-record",
      proposalId: "proposal:ledger-other-record",
      proofRef: first.proof.proofRef,
      transactionId: "transaction:ledger-other-record",
    });
    await assert.rejects(
      async () => await durableVerifier(ledgerPath).verify(verificationRequest(crossRecord)),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REPLAYED");
        return true;
      },
    );

    const reusedTransaction = authorization({
      recordRef: "memory:ledger-reused-transaction",
      proposalId: "proposal:ledger-reused-transaction",
      proofRef: "evidence:ledger-other-proof",
      transactionId: first.transactionId,
    });
    await assert.rejects(
      async () => await durableVerifier(ledgerPath).verify(verificationRequest(reusedTransaction)),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REPLAYED");
        return true;
      },
    );

    assert.equal(await restartedVerifier.commit(first.proof, first.transactionId), true);
    const finalVerifier = durableVerifier(ledgerPath);
    await finalVerifier.verify(verificationRequest(first));
    assert.equal(await finalVerifier.commit(first.proof, first.transactionId), true);
    ledger = await readApprovalLedger(ledgerPath);
    assert.equal(ledger.consumptions.length, 1);
    assert.equal(ledger.consumptions[0]?.proofRef, first.proof.proofRef);
    assert.equal(ledger.consumptions[0]?.transactionId, first.transactionId);
    assert.match(ledger.consumptions[0]?.proofDigest ?? "", /^[\da-f]{64}$/u);
    assert.equal(ledger.consumptions[0]?.status, "committed");
    assert.equal(ledger.consumptions[0]?.committedAt, NOW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an exact reserved transaction can recover after expiry but cannot reserve an expired proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-expiry-recovery-"));
  const ledgerPath = join(dir, "approval-consumptions.json");
  const expiredNow = "2026-07-30T14:00:00.000Z";
  try {
    const reserved = authorization({
      recordRef: "memory:expiry-recovery",
      proposalId: "proposal:expiry-recovery",
      proofRef: "evidence:expiry-recovery",
      transactionId: "transaction:expiry-recovery",
    });
    await durableVerifier(ledgerPath).verify(verificationRequest(reserved));
    const restarted = durableVerifier(ledgerPath, expiredNow);
    await restarted.verify(verificationRequest(reserved));
    assert.equal(await restarted.commit(reserved.proof, reserved.transactionId), true);

    const neverReserved = authorization({
      recordRef: "memory:expired-new",
      proposalId: "proposal:expired-new",
      proofRef: "evidence:expired-new",
      transactionId: "transaction:expired-new",
    });
    await assert.rejects(
      async () =>
        await durableVerifier(ledgerPath, expiredNow).verify(verificationRequest(neverReserved)),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_EXPIRED");
        return true;
      },
    );
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a committed proof cannot recreate a missing durable memory revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-committed-proof-resurrection-"));
  const filePath = join(dir, "memory.json");
  const ledgerPath = join(dir, "approval-consumptions.json");
  const recordRef = "memory:committed-proof-resurrection";
  const approval = authorization({
    recordRef,
    proposalId: "proposal:committed-proof-resurrection",
    proofRef: "evidence:committed-proof-resurrection",
    transactionId: "transaction:committed-proof-resurrection",
  });
  try {
    const initialVerifier = durableVerifier(ledgerPath);
    await initialVerifier.verify(verificationRequest(approval));
    assert.equal(await initialVerifier.commit(approval.proof, approval.transactionId), true);
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions[0]?.status, "committed");

    const store = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      { verifier: durableVerifier(ledgerPath), workspaceId: WORKSPACE },
    );
    await assertRejectedWithoutMutation(filePath, "MEMORY_APPROVAL_REPLAYED", async () =>
      remember(store, recordRef, approval),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reserved proof retries after snapshot write failure without duplicate revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-reserved-write-retry-"));
  const filePath = join(dir, "memory.json");
  const ledgerPath = join(dir, "approval-consumptions.json");
  const recordRef = "memory:reserved-write-retry";
  const approval = authorization({
    recordRef,
    proposalId: "proposal:reserved-write-retry",
    proofRef: "evidence:reserved-write-retry",
    transactionId: "transaction:reserved-write-retry",
  });
  try {
    const failingStore = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      { verifier: durableVerifier(ledgerPath), workspaceId: WORKSPACE },
    );
    (failingStore as unknown as { saveSnapshot(): Promise<void> }).saveSnapshot = async () => {
      throw new Error("injected snapshot write failure");
    };
    await assert.rejects(() => remember(failingStore, recordRef, approval), /injected snapshot/);
    assert.equal(
      await snapshotHash(filePath),
      createHash("sha256").update("<missing>").digest("hex"),
    );
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions[0]?.status, "reserved");

    const restartedStore = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      { verifier: durableVerifier(ledgerPath), workspaceId: WORKSPACE },
    );
    const stored = await remember(restartedStore, recordRef, approval);
    assert.equal(stored.lifecycle.revisionHistory.length, 1);
    assert.equal(stored.lifecycle.revision.transactionId, approval.transactionId);
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions[0]?.status, "committed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted mutation recovers after ledger commit failure without duplicate revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-post-write-ledger-retry-"));
  const filePath = join(dir, "memory.json");
  const ledgerPath = join(dir, "approval-consumptions.json");
  const recordRef = "memory:post-write-ledger-retry";
  const approval = authorization({
    recordRef,
    proposalId: "proposal:post-write-ledger-retry",
    proofRef: "evidence:post-write-ledger-retry",
    transactionId: "transaction:post-write-ledger-retry",
  });
  try {
    const reserveProof = createFileMemoryApprovalProofReserver(ledgerPath, { now: () => NOW });
    const durableCommit = createFileMemoryApprovalProofCommitter(ledgerPath, { now: () => NOW });
    let failCommit = true;
    const failingVerifier = createMemoryApprovalVerifier({
      now: () => NOW,
      authenticateProof: (proof) => proof.nonce.startsWith("auth:"),
      reserveProof,
      commitProof: async (proof, transactionId) => {
        if (failCommit) {
          failCommit = false;
          throw new Error("injected ledger commit failure");
        }
        return durableCommit(proof, transactionId);
      },
    });
    const firstStore = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      { verifier: failingVerifier, workspaceId: WORKSPACE },
    );
    await assert.rejects(
      () => remember(firstStore, recordRef, approval),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_INVALID");
        return true;
      },
    );
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions[0]?.status, "reserved");
    const journalPath = `${filePath}.mutation-journal.json`;
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      state: string;
      transactionId: string;
      contentDigest: string;
    };
    assert.equal(journal.state, "persisted");
    assert.equal(journal.transactionId, approval.transactionId);
    const journalPayload = JSON.parse(await readFile(journalPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      journalPath,
      JSON.stringify({
        ...journalPayload,
        proposal: {
          ...(journalPayload.proposal as Record<string, unknown>),
          contentDigest: "0".repeat(64),
        },
      }),
      "utf8",
    );
    await assert.rejects(
      () => remember(firstStore, recordRef, approval),
      /memory mutation recovery required: invalid journal/u,
    );
    await writeFile(journalPath, JSON.stringify(journalPayload), "utf8");

    const restartedStore = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      { verifier: durableVerifier(ledgerPath), workspaceId: WORKSPACE },
    );
    const retried = await remember(restartedStore, recordRef, approval);
    assert.equal(retried.lifecycle.revisionHistory.length, 1);
    assert.equal(retried.lifecycle.revision.transactionId, approval.transactionId);
    assert.equal((await readApprovalLedger(ledgerPath)).consumptions[0]?.status, "committed");
    await assert.rejects(readFile(journalPath, "utf8"), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall and learning writes keep proofs reserved until their persistence succeeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-store-write-recovery-"));
  const recallPath = join(dir, "recall.json");
  const recallLedger = join(dir, "recall-approvals.json");
  const learningRoot = join(dir, "learnings");
  const learningLedger = join(dir, "learning-approvals.json");
  try {
    const recall = new RecallStore(recallPath, {
      verifier: durableVerifier(recallLedger),
      workspaceId: WORKSPACE,
    });
    const recallCandidate = await recall.record({
      scope: "workspace",
      text: "Keep compaction candidate-only.",
      reason: "Await explicit promotion.",
    });
    const promotedTo = "memory:store-write-recovery";
    const recallContent = {
      text: recallCandidate.text,
      reason: recallCandidate.reason,
      evidenceRefs: recallCandidate.evidenceRefs,
      kind: "explicit",
      sourceSessionId: null,
      status: "promoted",
      promotedTo,
      rejectedReason: null,
    };
    const recallApproval = authorization({
      recordRef: recallCandidate.id,
      operation: "promote",
      expectedRevision: 1,
      content: recallContent,
      proposalId: "proposal:recall-write-recovery",
      proofRef: "evidence:recall-write-recovery",
      transactionId: "transaction:recall-write-recovery",
    });
    (recall as unknown as { saveSnapshot(): Promise<void> }).saveSnapshot = async () => {
      throw new Error("injected recall snapshot failure");
    };
    await assert.rejects(
      () => recall.promote(recallCandidate.id, promotedTo, recallApproval),
      /injected recall snapshot failure/,
    );
    const unchangedRecall = (await new RecallStore(recallPath).list())[0]!;
    assert.equal(unchangedRecall.status, "candidate");
    assert.equal(unchangedRecall.lifecycle.revisionHistory.length, 1);
    assert.equal((await readApprovalLedger(recallLedger)).consumptions[0]?.status, "reserved");
    const recallJournalPath = `${recallPath}.mutation-journal.json`;
    assert.equal(
      (JSON.parse(await readFile(recallJournalPath, "utf8")) as { state: string }).state,
      "prepared",
    );

    const restartedRecall = new RecallStore(recallPath, {
      verifier: durableVerifier(recallLedger),
      workspaceId: WORKSPACE,
    });
    const promoted = await restartedRecall.promote(recallCandidate.id, promotedTo, recallApproval);
    assert.equal((await readApprovalLedger(recallLedger)).consumptions[0]?.status, "committed");
    await assert.rejects(readFile(recallJournalPath, "utf8"), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });

    const durableEvidence = new EvidenceStore({ rootDir: learningRoot });
    let failLearningWrite = false;
    const failingEvidence: LearningEvidenceStore = {
      put: async (input) => {
        if (failLearningWrite) throw new Error("injected learning evidence failure");
        return durableEvidence.put(input);
      },
      get: (ref) => durableEvidence.get(ref),
      tryGet: (ref) => durableEvidence.tryGet(ref),
      list: (filter) => durableEvidence.list(filter),
      listWithDiagnostics: (filter) => durableEvidence.listWithDiagnostics(filter),
    };
    const learning = new LearningStore({
      evidenceStore: failingEvidence,
      verifier: durableVerifier(learningLedger),
      workspaceId: WORKSPACE,
      mutationLockPath: join(learningRoot, ".mutation.lock"),
    });
    const learningCandidate = await learning.record({
      id: "learning-store-write-recovery",
      title: "Candidate-only compaction",
      statement: "Automated compaction creates candidates only.",
      category: "decision",
      status: "candidate",
    });
    const learningContent = {
      title: learningCandidate.body.title,
      statement: learningCandidate.body.statement,
      category: learningCandidate.body.category,
      applicability: learningCandidate.body.applicability,
      nonApplicability: learningCandidate.body.nonApplicability,
      rationale: learningCandidate.body.rationale,
      evidenceRefs: learningCandidate.body.evidenceRefs,
      sourcePaths: learningCandidate.body.sourcePaths,
      sourceHash: learningCandidate.body.sourceHash,
      sourceContent: learningCandidate.body.sourceContent,
      dependsOn: learningCandidate.body.dependsOn,
      supersedes: learningCandidate.body.supersedes,
      contradictedBy: learningCandidate.body.contradictedBy,
      tags: learningCandidate.body.tags,
      confidence: learningCandidate.body.confidence,
      status: "active",
      staleReason: null,
      rejectedReason: null,
      supersededBy: learningCandidate.body.supersededBy,
    };
    const learningApproval = authorization({
      recordRef: learningCandidate.body.id,
      operation: "promote",
      expectedRevision: 1,
      content: learningContent,
      proposalId: "proposal:learning-write-recovery",
      proofRef: "evidence:learning-write-recovery",
      transactionId: "transaction:learning-write-recovery",
    });
    failLearningWrite = true;
    await assert.rejects(
      () => learning.activate(learningCandidate.body.id, learningApproval),
      /injected learning evidence failure/,
    );
    const unchangedLearning = await learning.get(learningCandidate.ref);
    assert.equal(unchangedLearning.body.status, "candidate");
    assert.equal(unchangedLearning.body.lifecycle.revisionHistory.length, 1);
    assert.equal((await readApprovalLedger(learningLedger)).consumptions[0]?.status, "reserved");
    const learningJournalPath = `${join(learningRoot, ".mutation.lock")}.mutation-journal.json`;
    assert.equal(
      (JSON.parse(await readFile(learningJournalPath, "utf8")) as { state: string }).state,
      "prepared",
    );

    const restartedLearning = new LearningStore({
      evidenceStore: durableEvidence,
      verifier: durableVerifier(learningLedger),
      workspaceId: WORKSPACE,
      mutationLockPath: join(learningRoot, ".mutation.lock"),
    });
    const activated = await restartedLearning.activate(learningCandidate.body.id, learningApproval);
    assert.equal((await readApprovalLedger(learningLedger)).consumptions[0]?.status, "committed");
    await assert.rejects(readFile(learningJournalPath, "utf8"), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid approval proofs fail closed with stable codes and unchanged snapshots", async () => {
  const cases: Array<{
    name: string;
    code: MemoryApprovalError["code"];
    mutate?: (approval: MemoryMutationAuthorization) => MemoryMutationAuthorization;
    approval?: false;
    text?: string;
  }> = [
    { name: "missing", code: "MEMORY_APPROVAL_REQUIRED", approval: false },
    {
      name: "unauthenticated",
      code: "MEMORY_APPROVAL_INVALID",
      mutate: (value) => ({ ...value, proof: { ...value.proof, nonce: "forged" } }),
    },
    {
      name: "tampered content",
      code: "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      text: "Tampered text not covered by the proposal.",
    },
    {
      name: "expired",
      code: "MEMORY_APPROVAL_EXPIRED",
      mutate: (value) => {
        const expiresAt = "2026-07-30T11:00:00.000Z";
        const proposal = createMemoryProposal({
          proposalId: value.proposal.proposalId,
          operation: value.proposal.operation,
          workspaceId: value.proposal.workspaceId,
          scope: value.proposal.scope,
          recordRef: value.proposal.recordRef,
          expectedRevision: value.proposal.expectedRevision,
          content: activeEntryContent(),
          expiresAt,
        });
        return {
          ...value,
          proposal,
          proof: {
            ...value.proof,
            proposalDigest: proposal.proposalDigest,
            expiresAt,
          },
        };
      },
    },
    {
      name: "cross workspace",
      code: "MEMORY_APPROVAL_SCOPE_MISMATCH",
      mutate: (value) => ({
        ...value,
        proposal: { ...value.proposal, workspaceId: "workspace:other" },
        proof: { ...value.proof, workspaceId: "workspace:other" },
      }),
    },
    {
      name: "cross proposal",
      code: "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
      mutate: (value) => ({
        ...value,
        proof: { ...value.proof, proposalId: "proposal:other" },
      }),
    },
  ];

  for (const entry of cases) {
    const dir = await mkdtemp(
      join(tmpdir(), `spark-memory-approval-${entry.name.replaceAll(" ", "-")}-`),
    );
    const filePath = join(dir, "memory.json");
    try {
      const store = defaultSparkMemoryStore(
        dir,
        "workspace",
        { workspace: filePath },
        {
          verifier: verifier(),
          workspaceId: WORKSPACE,
        },
      );
      const recordRef = `memory:${entry.name.replaceAll(" ", "-")}`;
      const base = authorization({ recordRef, proposalId: `proposal:${entry.name}` });
      const approval = entry.approval === false ? undefined : (entry.mutate?.(base) ?? base);
      await assertRejectedWithoutMutation(filePath, entry.code, async () =>
        store.remember({
          id: recordRef,
          scope: "workspace",
          category: "preference",
          text: entry.text ?? rememberedContent.text,
          reason: rememberedContent.reason,
          tags: rememberedContent.tags,
          authorization: approval,
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("approval replay and stale revisions fail without changing the committed snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-replay-"));
  const filePath = join(dir, "memory.json");
  try {
    const approvalVerifier = verifier();
    const store = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      {
        verifier: approvalVerifier,
        workspaceId: WORKSPACE,
      },
    );
    const recordRef = "memory:replay";
    const creation = authorization({ recordRef, proposalId: "proposal:create" });
    await remember(store, recordRef, creation);

    const reason = "No longer applicable.";
    const replay = authorization({
      recordRef,
      operation: "forget",
      expectedRevision: 1,
      content: forgottenContent(reason),
      proposalId: "proposal:replay",
      proofRef: creation.proof.proofRef,
      transactionId: "transaction:replay",
    });
    await assertRejectedWithoutMutation(filePath, "MEMORY_APPROVAL_REPLAYED", async () =>
      store.forget(recordRef, reason, replay),
    );

    const stale = authorization({
      recordRef,
      operation: "forget",
      expectedRevision: 0,
      content: forgottenContent(reason),
      proposalId: "proposal:stale",
    });
    await assertRejectedWithoutMutation(filePath, "MEMORY_REVISION_CONFLICT", async () =>
      store.forget(recordRef, reason, stale),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent CAS has one winner and idempotent retry keeps one immutable revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-cas-"));
  const filePath = join(dir, "memory.json");
  try {
    const store = defaultSparkMemoryStore(
      dir,
      "workspace",
      { workspace: filePath },
      {
        verifier: verifier(),
        workspaceId: WORKSPACE,
      },
    );
    const recordRef = "memory:cas";
    await remember(
      store,
      recordRef,
      authorization({ recordRef, proposalId: "proposal:cas-create" }),
    );

    const reason = "The approved preference was withdrawn.";
    const first = authorization({
      recordRef,
      operation: "forget",
      expectedRevision: 1,
      content: forgottenContent(reason),
      proposalId: "proposal:cas-first",
      transactionId: "transaction:cas-first",
    });
    const second = authorization({
      recordRef,
      operation: "forget",
      expectedRevision: 1,
      content: forgottenContent(reason),
      proposalId: "proposal:cas-second",
      transactionId: "transaction:cas-second",
    });
    const concurrent = await Promise.allSettled([
      store.forget(recordRef, reason, first),
      store.forget(recordRef, reason, second),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof MemoryApprovalError);
    assert.equal(rejected.reason.code, "MEMORY_REVISION_CONFLICT");

    const committed = (await store.list({ includeForgotten: true }))[0]!;
    assert.equal(committed.lifecycle.revision.version, 2);
    assert.equal(committed.lifecycle.revisionHistory.length, 2);
    const winner = concurrent[0]?.status === "fulfilled" ? first : second;
    const revisionRef = committed.lifecycle.revision.revisionRef;

    const retried = await store.forget(recordRef, reason, winner);
    assert.equal(retried.lifecycle.revision.revisionRef, revisionRef);
    assert.equal(retried.lifecycle.revisionHistory.length, 2);
    assert.equal(retried.lifecycle.revision.version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recall promotion requires approval and serializes concurrent revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-recall-"));
  const filePath = join(dir, "recall.json");
  try {
    const store = new RecallStore(filePath, {
      verifier: verifier(),
      workspaceId: WORKSPACE,
    });
    const candidate = await store.record({
      scope: "workspace",
      text: "Keep automated compaction candidate-only.",
      reason: "Candidate awaiting explicit promotion.",
    });
    const promotedTo = "memory:canonical-compaction-policy";
    const content = {
      text: candidate.text,
      reason: candidate.reason,
      evidenceRefs: candidate.evidenceRefs,
      kind: "explicit",
      sourceSessionId: candidate.sourceSessionId ?? null,
      status: "promoted",
      promotedTo,
      rejectedReason: null,
    };
    await assertRejectedWithoutMutation(filePath, "MEMORY_APPROVAL_REQUIRED", async () =>
      store.promote(candidate.id, promotedTo),
    );

    const first = authorization({
      recordRef: candidate.id,
      operation: "promote",
      expectedRevision: 1,
      content,
      proposalId: "proposal:recall-first",
      transactionId: "transaction:recall-first",
    });
    const second = authorization({
      recordRef: candidate.id,
      operation: "promote",
      expectedRevision: 1,
      content,
      proposalId: "proposal:recall-second",
      transactionId: "transaction:recall-second",
    });
    const concurrent = await Promise.allSettled([
      store.promote(candidate.id, promotedTo, first),
      store.promote(candidate.id, promotedTo, second),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof MemoryApprovalError);
    assert.equal(rejected.reason.code, "MEMORY_REVISION_CONFLICT");

    const committed = (await store.list())[0]!;
    assert.equal(committed.lifecycle.revision.version, 2);
    assert.equal(committed.lifecycle.revisionHistory.length, 2);
    const winner = concurrent[0]?.status === "fulfilled" ? first : second;
    const retried = await store.promote(candidate.id, promotedTo, winner);
    assert.equal(retried.lifecycle.revision.revisionRef, committed.lifecycle.revision.revisionRef);
    assert.equal(retried.lifecycle.revisionHistory.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("learning activation requires approval and commits atomically under its store lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-memory-approval-learning-"));
  const artifactRoot = join(dir, "artifacts");
  try {
    const store = new LearningStore({
      evidenceStore: new EvidenceStore({ rootDir: artifactRoot }),
      verifier: verifier(),
      workspaceId: WORKSPACE,
      mutationLockPath: join(artifactRoot, ".mutation.lock"),
    });
    const candidate = await store.record({
      id: "learning-approval-candidate",
      title: "Candidate-only compaction",
      statement: "Automated compaction creates candidates, never active durable memory.",
      category: "decision",
      status: "candidate",
      applicability: "Spark memory compaction.",
      tags: ["memory", "compaction"],
    });
    const content = {
      title: candidate.body.title,
      statement: candidate.body.statement,
      category: candidate.body.category,
      applicability: candidate.body.applicability,
      nonApplicability: candidate.body.nonApplicability,
      rationale: candidate.body.rationale,
      evidenceRefs: candidate.body.evidenceRefs,
      sourcePaths: candidate.body.sourcePaths,
      sourceHash: candidate.body.sourceHash,
      sourceContent: candidate.body.sourceContent,
      dependsOn: candidate.body.dependsOn,
      supersedes: candidate.body.supersedes,
      contradictedBy: candidate.body.contradictedBy,
      tags: candidate.body.tags,
      confidence: candidate.body.confidence,
      status: "active",
      staleReason: null,
      rejectedReason: null,
      supersededBy: candidate.body.supersededBy,
    };
    const before = createHash("sha256").update(JSON.stringify(candidate.body)).digest("hex");
    await assert.rejects(
      () => store.activate(candidate.body.id),
      (error) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );
    const afterMissing = createHash("sha256")
      .update(JSON.stringify((await store.get(candidate.ref)).body))
      .digest("hex");
    assert.equal(afterMissing, before);

    const first = authorization({
      recordRef: candidate.body.id,
      operation: "promote",
      expectedRevision: 1,
      content,
      proposalId: "proposal:learning-first",
      transactionId: "transaction:learning-first",
    });
    const second = authorization({
      recordRef: candidate.body.id,
      operation: "promote",
      expectedRevision: 1,
      content,
      proposalId: "proposal:learning-second",
      transactionId: "transaction:learning-second",
    });
    const concurrent = await Promise.allSettled([
      store.activate(candidate.body.id, first),
      store.activate(candidate.body.id, second),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof MemoryApprovalError);
    assert.equal(rejected.reason.code, "MEMORY_REVISION_CONFLICT");

    const committed = await store.get(candidate.ref);
    assert.equal(committed.body.lifecycle.revision.version, 2);
    assert.equal(committed.body.lifecycle.revisionHistory.length, 2);
    const winner = concurrent[0]?.status === "fulfilled" ? first : second;
    const retried = await store.activate(candidate.body.id, winner);
    assert.equal(
      retried.body.lifecycle.revision.revisionRef,
      committed.body.lifecycle.revision.revisionRef,
    );
    assert.equal(retried.body.lifecycle.revisionHistory.length, 2);
    const activeHash = createHash("sha256").update(JSON.stringify(retried.body)).digest("hex");
    await assert.rejects(
      () =>
        store.record({
          id: candidate.body.id,
          title: candidate.body.title,
          statement: "Unapproved candidate overwrite.",
          status: "candidate",
        }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryApprovalError);
        assert.equal(error.code, "MEMORY_APPROVAL_REQUIRED");
        return true;
      },
    );
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify((await store.get(candidate.ref)).body))
        .digest("hex"),
      activeHash,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
