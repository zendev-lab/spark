import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { EvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  createMemoryApprovalVerifier,
  createMemoryProposal,
  defaultSparkMemoryStore,
  LearningStore,
  type LearningRecord,
  type MemoryMutationAuthorization,
  type SparkMemoryEntry,
} from "@zendev-lab/spark-memory";
import { createLegacyMemoryFixturePermit } from "@zendev-lab/spark-memory/legacy-fixture";
import {
  registerSparkMemoryTool,
  type SparkMemoryExtensionApi,
} from "@zendev-lab/spark-memory/extension";
import {
  MemoryLineageProposalStore,
  memoryLineageProposalApprovalPayload,
  memoryLineageProposalArtifactContentRef,
  memoryLineageApprovalContent,
  suggestSemanticMemoryReview,
  type FrozenMemoryRevisionSource,
  type MemoryLineageProposal,
} from "@zendev-lab/spark-memory/proposals";
import type { SparkMemoryApprovalProof } from "@zendev-lab/spark-protocol";

const NOW = "2026-08-03T12:00:00.000Z";
const FUTURE = "2099-08-03T13:00:00.000Z";
const WORKSPACE = "workspace:lineage";

const entryContent = (text: string) => ({
  category: "insight" as const,
  text,
  reason: "Approved lineage test fixture.",
  evidenceRefs: [] as string[],
  tags: ["lineage"],
  status: "active" as const,
  forgottenReason: null,
});

function source(entry: SparkMemoryEntry): FrozenMemoryRevisionSource {
  return {
    recordRef: entry.id,
    revisionRef: entry.lifecycle.revision.revisionRef,
    contentDigest: entry.lifecycle.revision.contentDigest,
    scope: entry.lifecycle.scope,
  };
}

function verifier(now = NOW) {
  return createMemoryApprovalVerifier({
    now: () => now,
    authenticateProof: (proof) => proof.nonce.startsWith("auth:"),
  });
}

function authorization(
  proposal: MemoryLineageProposal,
  options: {
    content?: unknown;
    expectedRevision?: number;
    suffix?: string;
    workspaceId?: string;
  } = {},
): MemoryMutationAuthorization {
  const operation =
    proposal.operation === "propose_update"
      ? "update"
      : proposal.operation === "propose_merge"
        ? "merge"
        : "supersede";
  const approvalProposal = createMemoryProposal({
    proposalId: proposal.proposalId,
    operation,
    workspaceId: options.workspaceId ?? WORKSPACE,
    scope: proposal.target.scope,
    recordRef: proposal.target.recordRef,
    expectedRevision: options.expectedRevision ?? proposal.expectedRevision,
    content: options.content ?? memoryLineageApprovalContent(proposal),
    expiresAt: proposal.expiresAt,
  });
  const suffix = options.suffix ?? proposal.proposalDigest.slice(0, 12);
  const proof: SparkMemoryApprovalProof = {
    schema: "spark.memory.approval-proof/v1",
    proofRef: `evidence:lineage-${suffix}`,
    workspaceId: approvalProposal.workspaceId,
    recordRef: approvalProposal.recordRef,
    proposalId: approvalProposal.proposalId,
    operation: approvalProposal.operation,
    proposalDigest: approvalProposal.proposalDigest,
    scope: approvalProposal.scope,
    expectedRevision: approvalProposal.expectedRevision,
    issuedAt: NOW,
    expiresAt: approvalProposal.expiresAt,
    nonce: `auth:${suffix}`,
    answerDigest: "a".repeat(64),
  };
  return {
    proposal: approvalProposal,
    proof,
    transactionId: `transaction:lineage-${suffix}`,
  };
}

function learningProposalContent(record: LearningRecord, statement: string) {
  return {
    title: record.title,
    statement,
    category: record.category,
    status: "active" as const,
    applicability: record.applicability,
    nonApplicability: record.nonApplicability,
    rationale: record.rationale,
    evidenceRefs: record.evidenceRefs,
    sourcePaths: record.sourcePaths,
    sourceHash: record.sourceHash,
    sourceContent: record.sourceContent,
    dependsOn: record.dependsOn,
    supersedes: record.supersedes,
    supersededBy: record.supersededBy,
    contradictedBy: record.contradictedBy,
    tags: record.tags,
    confidence: record.confidence,
    staleReason: null,
    rejectedReason: null,
  };
}

function learningSource(record: LearningRecord): FrozenMemoryRevisionSource {
  return {
    recordRef: record.id,
    revisionRef: record.lifecycle.revision.revisionRef,
    contentDigest: record.lifecycle.revision.contentDigest,
    scope: record.lifecycle.scope,
  };
}

async function snapshotHash(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function setupLineageStore() {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-lineage-"));
  const memoryPath = join(root, ".spark", "memory", "memory.json");
  const proposalPath = join(root, ".spark", "memory", "lineage-proposals.json");
  const proposalStore = new MemoryLineageProposalStore(proposalPath);
  const fixtures = defaultSparkMemoryStore(root, "workspace", undefined, {
    workspaceId: WORKSPACE,
    legacyFixturePermit: createLegacyMemoryFixturePermit(),
    proposalStore,
  });
  const primary = await fixtures.remember({
    id: "memory:lineage-primary",
    scope: "workspace",
    category: "insight",
    text: "Primary memory before merge.",
    reason: "Approved lineage test fixture.",
    tags: ["lineage"],
  });
  const secondary = await fixtures.remember({
    id: "memory:lineage-secondary",
    scope: "workspace",
    category: "insight",
    text: "Secondary memory before merge.",
    reason: "Approved lineage test fixture.",
    tags: ["lineage"],
  });
  const store = defaultSparkMemoryStore(root, "workspace", undefined, {
    workspaceId: WORKSPACE,
    verifier: verifier(),
    proposalStore,
  });
  return { root, memoryPath, proposalStore, primary, secondary, store };
}

async function createMergeProposal(
  proposalStore: MemoryLineageProposalStore,
  primary: SparkMemoryEntry,
  secondary: SparkMemoryEntry,
  options: {
    createdAt?: string;
    expiresAt?: string;
    expectedRevision?: number;
    sources?: FrozenMemoryRevisionSource[];
  } = {},
) {
  return proposalStore.create({
    operation: "propose_merge",
    workspaceId: WORKSPACE,
    previewRef: "artifact:lineage-review",
    sources: options.sources ?? [source(secondary), source(primary)],
    target: {
      kind: "entry",
      recordRef: primary.id,
      scope: "workspace",
      risk: "normal",
      content: entryContent("Merged primary and secondary memory."),
      evidenceRefs: ["evidence:lineage-review"],
    },
    expectedRevision: options.expectedRevision ?? primary.lifecycle.revision.version,
    createdAt: options.createdAt ?? NOW,
    expiresAt: options.expiresAt ?? FUTURE,
  });
}

test("proposal identity validation rejects frozen-content tampering and terminal rewrites", async () => {
  const setup = await setupLineageStore();
  try {
    const proposal = await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary);
    await setup.proposalStore.transition(proposal.proposalId, "cancelled", {
      expectedStatus: "pending",
      now: NOW,
    });
    await assert.rejects(
      setup.proposalStore.transition(proposal.proposalId, "approved", {
        expectedStatus: "pending",
        now: NOW,
      }),
      /status conflict/u,
    );

    const parsed = JSON.parse(await readFile(setup.proposalStore.filePath, "utf8")) as {
      proposals: Array<{ target: { content: { text: string } } }>;
    };
    parsed.proposals[0]!.target.content.text = "Tampered while retaining stale digests.";
    await writeFile(setup.proposalStore.filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await assert.rejects(setup.proposalStore.get(proposal.proposalId), /derived identity/u);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("one proposal claim admits only one concurrent authorization transaction", async () => {
  const setup = await setupLineageStore();
  try {
    const proposal = await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary);
    await setup.proposalStore.transition(proposal.proposalId, "approved", {
      expectedStatus: "pending",
      now: NOW,
    });
    const results = await Promise.allSettled([
      setup.store.applyLineageProposal(
        proposal.proposalId,
        authorization(proposal, { suffix: "concurrent-claim-a" }),
      ),
      setup.store.applyLineageProposal(
        proposal.proposalId,
        authorization(proposal, { suffix: "concurrent-claim-b" }),
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await setup.store.get(setup.primary.id)).lifecycle.revisionHistory.length, 2);
    assert.equal((await setup.proposalStore.get(proposal.proposalId)).status, "committed");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("memory tool prepares an artifact-linked proposal without mutating durable memory", async () => {
  const setup = await setupLineageStore();
  try {
    let tool: Parameters<SparkMemoryExtensionApi["registerTool"]>[0] | undefined;
    registerSparkMemoryTool({
      getAllTools: () => [],
      registerTool(config) {
        tool = config;
      },
    });
    assert.ok(tool);
    const beforeHash = await snapshotHash(setup.memoryPath);
    const output = await tool.execute(
      "tool:lineage-proposal",
      {
        action: "propose_update",
        kind: "entry",
        previewRef: "artifact:lineage-tool-review",
        lineageProposal: {
          sources: [source(setup.primary)],
          target: {
            kind: "entry",
            recordRef: setup.primary.id,
            scope: "workspace",
            risk: "normal",
            content: entryContent("Tool-created update proposal."),
            evidenceRefs: ["evidence:tool-review"],
          },
          expectedRevision: setup.primary.lifecycle.revision.version,
          createdAt: NOW,
          expiresAt: FUTURE,
        },
      },
      undefined as never,
      undefined as never,
      { cwd: setup.root } as never,
    );
    const details = output.details as {
      proposal: MemoryLineageProposal;
      approval: { previewRef: string; proposalDigest: string };
      mutationPerformed: boolean;
    };
    assert.equal(details.proposal.operation, "propose_update");
    assert.equal(details.proposal.status, "pending");
    assert.equal(details.approval.previewRef, "artifact:lineage-tool-review");
    assert.equal(details.approval.proposalDigest, details.proposal.proposalDigest);
    assert.equal(details.mutationPerformed, false);
    assert.equal(await snapshotHash(setup.memoryPath), beforeHash);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("lineage proposal store deduplicates exact proposals and semantic suggestions never mutate", async () => {
  const setup = await setupLineageStore();
  try {
    const before = await snapshotHash(setup.memoryPath);
    const first = await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary);
    for (let index = 0; index < 25; index += 1) {
      const duplicate = await createMergeProposal(
        setup.proposalStore,
        setup.primary,
        setup.secondary,
      );
      assert.equal(duplicate.proposalId, first.proposalId);
      assert.equal(duplicate.proposalDigest, first.proposalDigest);
    }
    assert.equal((await setup.proposalStore.list()).length, 1);
    const previewRef = memoryLineageProposalArtifactContentRef(first);
    assert.equal(
      (previewRef.memoryProposal as { proposalDigest: string }).proposalDigest,
      first.proposalDigest,
    );
    assert.deepEqual(memoryLineageProposalApprovalPayload(first), {
      mode: "approval",
      previewRef: "artifact:lineage-review",
      proposalId: first.proposalId,
      proposalDigest: first.proposalDigest,
      expectedRevision: first.expectedRevision,
      expiresAt: first.expiresAt,
      risk: first.target.risk,
      prompt: `Approve immutable memory merge proposal ${first.proposalId}?`,
    });
    await assert.rejects(
      setup.proposalStore.create({
        operation: "propose_update",
        workspaceId: WORKSPACE,
        previewRef: ["artifact:first", "artifact:second"] as unknown as string,
        sources: [source(setup.primary)],
        target: {
          kind: "entry",
          recordRef: setup.primary.id,
          scope: "workspace",
          risk: "normal",
          content: entryContent("Ambiguous artifact must fail."),
        },
        expectedRevision: 1,
        expiresAt: FUTURE,
      }),
      /previewRef/u,
    );
    const suggestion = suggestSemanticMemoryReview({
      query: { text: "primary memory, almost the same" },
      candidates: [{ recordRef: setup.primary.id, score: 0.91 }],
    });
    assert.deepEqual(suggestion, {
      kind: "review_suggestion",
      queryDigest: suggestion?.queryDigest,
      candidateRefs: [setup.primary.id],
      reason: "Semantically similar memory requires explicit review; no mutation was performed.",
    });
    assert.equal("mutate" in (suggestion ?? {}), false);
    assert.equal("commit" in (suggestion ?? {}), false);
    assert.equal(await snapshotHash(setup.memoryPath), before);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("approved merge commits one atomic snapshot with current pointer and bidirectional lineage", async () => {
  const setup = await setupLineageStore();
  try {
    const proposal = await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary);
    await setup.proposalStore.transition(proposal.proposalId, "approved", {
      expectedStatus: "pending",
      now: NOW,
    });
    const approval = authorization(proposal);
    const committed = await setup.store.applyLineageProposal(proposal.proposalId, approval);

    assert.equal(committed.lifecycle.revision.version, 2);
    assert.deepEqual(
      new Set(committed.lifecycle.revision.predecessorRefs),
      new Set([
        setup.primary.lifecycle.revision.revisionRef,
        setup.secondary.lifecycle.revision.revisionRef,
      ]),
    );
    assert.deepEqual(committed.lifecycle.lineage.mergedFrom, [setup.secondary.id]);
    assert.equal(committed.lifecycle.revision.transactionId, approval.transactionId);
    assert.equal(committed.lifecycle.revision.proposalDigest, approval.proposal.proposalDigest);
    assert.equal(committed.lifecycle.revision.proofRef, approval.proof.proofRef);

    const mergedSource = await setup.store.get(setup.secondary.id);
    assert.equal(mergedSource.status, "merged");
    assert.equal(mergedSource.lifecycle.state, "merged");
    assert.deepEqual(mergedSource.lifecycle.lineage.mergedInto, [setup.primary.id]);
    assert.deepEqual(mergedSource.lifecycle.lineage.supersededBy, []);
    assert.equal(mergedSource.lifecycle.revision.version, 2);

    const defaultResults = await setup.store.search("memory");
    assert.deepEqual(
      defaultResults.map((result) => result.entry.id),
      [setup.primary.id],
    );
    const oldRevision = await setup.store.getRevision(
      setup.primary.id,
      setup.primary.lifecycle.revision.revisionRef,
    );
    assert.equal(oldRevision.contentDigest, setup.primary.lifecycle.revision.contentDigest);
    const lineage = await setup.store.lineage(setup.primary.id);
    assert.deepEqual(
      lineage.related.map((entry) => entry.id),
      [setup.secondary.id],
    );
    assert.equal((await setup.proposalStore.get(proposal.proposalId)).status, "committed");

    const retry = await setup.store.applyLineageProposal(proposal.proposalId, approval);
    assert.equal(retry.lifecycle.revision.version, 2);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("approved learning merge advances the target and hides merged sources from default retrieval", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-learning-lineage-"));
  try {
    const evidenceStore = new EvidenceStore({
      rootDir: join(root, ".spark", "memory", "learnings"),
    });
    const proposalStore = new MemoryLineageProposalStore(
      join(root, ".spark", "memory", "lineage-proposals.json"),
    );
    const fixtureStore = new LearningStore({
      evidenceStore,
      location: "workspace",
      mutationLockPath: join(root, ".spark", "memory", "learnings", ".mutation.lock"),
      legacyFixturePermit: createLegacyMemoryFixturePermit(),
      proposalStore,
    });
    const primary = await fixtureStore.record({
      id: "learning-lineage-primary",
      title: "Primary learning",
      statement: "Primary statement before merge.",
      status: "active",
      applicability: "Spark memory tests",
      evidenceRefs: ["evidence:primary"],
    });
    const secondary = await fixtureStore.record({
      id: "learning-lineage-secondary",
      title: "Secondary learning",
      statement: "Secondary statement before merge.",
      status: "active",
      applicability: "Spark memory tests",
      evidenceRefs: ["evidence:secondary"],
    });
    const store = new LearningStore({
      evidenceStore,
      location: "workspace",
      mutationLockPath: join(root, ".spark", "memory", "learnings", ".mutation.lock"),
      verifier: verifier(),
      workspaceId: WORKSPACE,
      proposalStore,
    });
    const proposal = await proposalStore.create({
      operation: "propose_merge",
      workspaceId: WORKSPACE,
      previewRef: "artifact:learning-lineage-review",
      sources: [learningSource(secondary.body), learningSource(primary.body)],
      target: {
        kind: "learning",
        recordRef: primary.body.id,
        scope: "workspace",
        risk: "normal",
        content: learningProposalContent(
          primary.body,
          "Merged primary and secondary learning statement.",
        ),
        evidenceRefs: ["evidence:primary", "evidence:secondary"],
      },
      expectedRevision: primary.body.lifecycle.revision.version,
      createdAt: NOW,
      expiresAt: FUTURE,
    });
    await proposalStore.transition(proposal.proposalId, "approved", {
      expectedStatus: "pending",
      now: NOW,
    });
    const approval = authorization(proposal, { suffix: "learning-merge" });
    const committed = await store.applyLineageProposal(proposal.proposalId, approval);

    assert.equal(committed.body.lifecycle.revision.version, 2);
    assert.deepEqual(committed.body.lifecycle.lineage.mergedFrom, [secondary.body.id]);
    assert.equal(committed.body.lifecycle.revision.transactionId, approval.transactionId);
    assert.deepEqual(
      (await store.search({ query: "statement" })).map((result) => result.record.id),
      [primary.body.id],
    );
    const audit = await store.list({ includeInactive: true });
    assert.deepEqual(
      audit.map((record) => record.body.id).sort(),
      [primary.body.id, secondary.body.id].sort(),
    );
    const reverse = await store.lineage(secondary.body.id);
    assert.equal(reverse.record.body.status, "merged");
    assert.equal(reverse.record.body.lifecycle.state, "merged");
    assert.deepEqual(reverse.record.body.lifecycle.lineage.mergedInto, [primary.body.id]);
    assert.deepEqual(reverse.record.body.lifecycle.lineage.supersededBy, []);
    assert.equal(reverse.record.body.lifecycle.revision.version, 2);
    assert.deepEqual(
      reverse.successors.map((record) => record.body.id),
      [primary.body.id],
    );
    assert.equal(
      (await store.getRevision(primary.body.id, primary.body.lifecycle.revision.revisionRef))
        .contentDigest,
      primary.body.lifecycle.revision.contentDigest,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent approved proposal wins CAS and stale proposal leaves the winner unchanged", async () => {
  const setup = await setupLineageStore();
  try {
    const stale = await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary);
    const winner = await setup.proposalStore.create({
      operation: "propose_update",
      workspaceId: WORKSPACE,
      previewRef: "artifact:concurrent-winner",
      sources: [source(setup.primary)],
      target: {
        kind: "entry",
        recordRef: setup.primary.id,
        scope: "workspace",
        risk: "normal",
        content: entryContent("Concurrent winning update."),
        evidenceRefs: ["evidence:concurrent-winner"],
      },
      expectedRevision: setup.primary.lifecycle.revision.version,
      createdAt: NOW,
      expiresAt: FUTURE,
    });
    await setup.proposalStore.transition(winner.proposalId, "approved", {
      expectedStatus: "pending",
      now: NOW,
    });
    await setup.store.applyLineageProposal(
      winner.proposalId,
      authorization(winner, { suffix: "concurrent-winner" }),
    );
    await setup.proposalStore.transition(stale.proposalId, "approved", {
      expectedStatus: "pending",
      now: NOW,
    });
    const beforeHash = await snapshotHash(setup.memoryPath);
    const before = await setup.store.get(setup.primary.id);
    const beforeSearch = (await setup.store.search("Concurrent")).map((result) => result.entry.id);

    await assert.rejects(
      setup.store.applyLineageProposal(
        stale.proposalId,
        authorization(stale, { suffix: "concurrent-stale" }),
      ),
      /source revisions changed|revision/u,
    );
    const after = await setup.store.get(setup.primary.id);
    assert.equal(after.lifecycle.revision.revisionRef, before.lifecycle.revision.revisionRef);
    assert.equal(after.lifecycle.revisionHistory.length, before.lifecycle.revisionHistory.length);
    assert.deepEqual(
      (await setup.store.search("Concurrent")).map((result) => result.entry.id),
      beforeSearch,
    );
    assert.equal(await snapshotHash(setup.memoryPath), beforeHash);
    const conflicted = await setup.proposalStore.get(stale.proposalId);
    assert.equal(conflicted.status, "conflict");
    assert.match(conflicted.conflictStatus ?? "", /source revisions changed|revision/u);
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

for (const caseName of [
  "unapproved",
  "cancelled",
  "rejected",
  "expired",
  "source-drift",
  "digest-mismatch",
  "workspace-mismatch",
  "revision-mismatch",
] as const) {
  test(`lineage proposal ${caseName} fails closed without changing revisions or search`, async () => {
    const setup = await setupLineageStore();
    try {
      const proposal =
        caseName === "expired"
          ? await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary, {
              createdAt: "2000-01-01T00:00:00.000Z",
              expiresAt: "2000-01-01T00:01:00.000Z",
            })
          : caseName === "source-drift"
            ? await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary, {
                sources: [
                  source(setup.primary),
                  { ...source(setup.secondary), contentDigest: "f".repeat(64) },
                ],
              })
            : await createMergeProposal(setup.proposalStore, setup.primary, setup.secondary, {
                ...(caseName === "revision-mismatch" ? { expectedRevision: 2 } : {}),
              });
      if (caseName === "cancelled" || caseName === "rejected") {
        await setup.proposalStore.transition(proposal.proposalId, caseName, {
          expectedStatus: "pending",
          now: NOW,
        });
      } else if (caseName !== "unapproved") {
        await setup.proposalStore.transition(proposal.proposalId, "approved", {
          expectedStatus: "pending",
          now: NOW,
        });
      }
      const approval = authorization(proposal, {
        ...(caseName === "digest-mismatch" ? { content: { drift: true } } : {}),
        ...(caseName === "revision-mismatch" ? { expectedRevision: 2 } : {}),
        ...(caseName === "workspace-mismatch" ? { workspaceId: "workspace:different" } : {}),
        suffix: caseName,
      });
      const beforeHash = await snapshotHash(setup.memoryPath);
      const beforePrimary = await setup.store.get(setup.primary.id);
      const beforeSearch = (await setup.store.search("memory")).map((result) => result.entry.id);
      await assert.rejects(
        setup.store.applyLineageProposal(proposal.proposalId, approval),
        /proposal|approval|revision|expired|source/u,
      );
      const afterPrimary = await setup.store.get(setup.primary.id);
      assert.equal(
        afterPrimary.lifecycle.revisionHistory.length,
        beforePrimary.lifecycle.revisionHistory.length,
      );
      assert.equal(
        afterPrimary.lifecycle.revision.revisionRef,
        beforePrimary.lifecycle.revision.revisionRef,
      );
      assert.deepEqual(
        (await setup.store.search("memory")).map((result) => result.entry.id),
        beforeSearch,
      );
      assert.equal(await snapshotHash(setup.memoryPath), beforeHash);
    } finally {
      await rm(setup.root, { recursive: true, force: true });
    }
  });
}
