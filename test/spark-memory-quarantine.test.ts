import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, test, vi } from "vitest";

import {
  createMemoryApprovalVerifier,
  createMemoryProposal,
  defaultSparkMemoryStore,
  type MemoryMutationAuthorization,
} from "@zendev-lab/spark-memory";
import { createLegacyMemoryFixturePermit } from "@zendev-lab/spark-memory/legacy-fixture";
import {
  applyMemoryPurgePlan,
  applyMemoryRestorePlan,
  createMemoryPurgePlan,
  createMemoryQuarantineManifest,
  createMemoryQuarantineProposal,
  createMemoryRestorePlan,
  MemoryQuarantineError,
  parseMemoryQuarantineManifest,
  parseMemoryQuarantineProposal,
  parseMemoryPurgeTombstone,
  verifyMemoryQuarantineManifest,
  type MemoryPurgeExecutionState,
  type MemoryPurgeTargetCompletion,
  type MemoryPurgeTargetReceipt,
  type MemoryPurgePlan,
  type MemoryQuarantineManifest,
  type MemoryQuarantineProposal,
  type MemoryQuarantineTarget,
} from "@zendev-lab/spark-memory/quarantine";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spark-memory-quarantine-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureManifest(
  options: {
    reverseRefs?: string[];
    createdAt?: string;
    expiresAt?: string;
  } = {},
): Promise<{ root: string; manifest: MemoryQuarantineManifest; sourceHash: string }> {
  const root = await temporaryRoot();
  const createdAt = options.createdAt ?? "2026-08-01T00:00:00.000Z";
  const expiresAt = options.expiresAt ?? "2026-08-31T00:00:00.000Z";
  const files = [
    { source: "memory/memory.json", body: "memory-body", targetKind: "content" as const },
    {
      source: "memory/revisions/revision-1.json",
      body: "revision-body",
      targetKind: "revision" as const,
    },
  ];
  for (const file of files) {
    const path = join(root, file.source);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.body);
  }
  const manifest = await createMemoryQuarantineManifest({
    quarantineId: "quarantine:test",
    rootDir: root,
    createdAt,
    expiresAt,
    items: files.map((file) => ({
      source: file.source,
      destination: `memory/quarantine/test/files/${file.source}`,
      reasonCode: "test",
      reverseRefs: options.reverseRefs ?? [],
      purgeAfter: expiresAt,
      targetKind: file.targetKind,
      fileVersion: "version:1",
    })),
  });
  for (const item of manifest.items) {
    const destination = join(root, item.destination);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, item.source), destination);
  }
  return {
    root,
    manifest,
    sourceHash: sha256(await readFile(join(root, "memory/memory.json"))),
  };
}

function createAuthorization(
  proposal: MemoryQuarantineProposal,
  now: string,
): {
  authorization: MemoryMutationAuthorization;
  verifier: ReturnType<typeof createMemoryApprovalVerifier>;
} {
  const proof = {
    schema: "spark.memory.approval-proof/v1" as const,
    proofRef: `proof:${proposal.proposalId}`,
    workspaceId: proposal.workspaceId,
    recordRef: proposal.recordRef,
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    proposalDigest: proposal.proposalDigest,
    scope: proposal.scope,
    expectedRevision: proposal.expectedRevision,
    issuedAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    nonce: `nonce:${proposal.proposalId}`,
    answerDigest: "a".repeat(64),
  };
  return {
    authorization: {
      proposal,
      proof,
      transactionId: `transaction:${proposal.proposalId}`,
    },
    verifier: createMemoryApprovalVerifier({ authenticateProof: () => true, now: () => now }),
  };
}

function purgeProposal(plan: MemoryPurgePlan, expiresAt = "2026-09-02T00:00:00.000Z") {
  return createMemoryQuarantineProposal({
    proposalId: plan.proposalId,
    operation: "purge",
    workspaceId: plan.workspaceId,
    recordRef: "memory:test",
    scope: "workspace",
    expectedRevision: 2,
    manifestDigest: plan.manifestDigest,
    planDigest: plan.planDigest,
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt,
  });
}

function createStoreAuthorization(
  proposal: ReturnType<typeof createMemoryProposal>,
  now: string,
): {
  authorization: MemoryMutationAuthorization;
  verifier: ReturnType<typeof createMemoryApprovalVerifier>;
} {
  const proof = {
    schema: "spark.memory.approval-proof/v1" as const,
    proofRef: `proof:${proposal.proposalId}`,
    workspaceId: proposal.workspaceId,
    recordRef: proposal.recordRef,
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    proposalDigest: proposal.proposalDigest,
    scope: proposal.scope,
    expectedRevision: proposal.expectedRevision,
    issuedAt: now,
    expiresAt: proposal.expiresAt,
    nonce: `nonce:${proposal.proposalId}`,
    answerDigest: "c".repeat(64),
  };
  return {
    authorization: { proposal, proof, transactionId: `transaction:${proposal.proposalId}` },
    verifier: createMemoryApprovalVerifier({ authenticateProof: () => true, now: () => now }),
  };
}

const verifiedPlanTargets = {
  verifySource: () => true,
  verifyReachability: () => true,
};

function targetCompletion(
  target: MemoryQuarantineTarget,
  receipt: MemoryPurgeTargetReceipt,
  state: MemoryPurgeTargetCompletion["state"] = "completed",
): MemoryPurgeTargetCompletion {
  return {
    state,
    receiptId: receipt.receiptId,
    targetId: target.id,
    planDigest: receipt.planDigest,
    expectedSha256: target.sha256,
    expectedBytes: target.bytes,
    expectedFileVersion: target.fileVersion,
  };
}

function safePurgeExecution(
  proposal: MemoryQuarantineProposal,
  execute: (target: MemoryQuarantineTarget) => void | Promise<void>,
) {
  return {
    proposal,
    inspectTarget: () => ({ state: "not_started" as const }),
    executeTarget: async (target: MemoryQuarantineTarget, receipt: MemoryPurgeTargetReceipt) => {
      await execute(target);
      return targetCompletion(target, receipt);
    },
    persistState: () => {},
    verifySource: () => true,
    verifyReachability: () => true,
  };
}

test("quarantine and restore lifecycle revisions require exact canonical approval and hide quarantined entries by default", async () => {
  const root = await temporaryRoot();
  const seedStore = defaultSparkMemoryStore(root, "workspace", undefined, {
    legacyFixturePermit: createLegacyMemoryFixturePermit(),
  });
  const entry = await seedStore.remember({
    id: "memory:quarantine-lifecycle",
    scope: "workspace",
    category: "preference",
    text: "Keep lifecycle mutations explicit.",
    reason: "Lifecycle fixture.",
  });
  const expiresAt = "2099-02-01T00:00:00.000Z";
  const purgeAfter = "2099-03-01T00:00:00.000Z";
  const quarantineContent = {
    category: entry.category,
    text: entry.text,
    reason: entry.reason,
    evidenceRefs: entry.evidenceRefs,
    tags: entry.tags,
    status: "quarantined",
    forgottenReason: "approved quarantine",
    expiresAt,
    purgeAfter,
  };
  const quarantineProposal = createMemoryProposal({
    operation: "quarantine",
    workspaceId: "workspace:test",
    recordRef: entry.id,
    scope: "workspace",
    expectedRevision: entry.lifecycle.revision.version,
    content: quarantineContent,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const quarantineApproval = createStoreAuthorization(
    quarantineProposal,
    "2026-08-04T01:00:00.000Z",
  );
  const store = defaultSparkMemoryStore(root, "workspace", undefined, {
    verifier: quarantineApproval.verifier,
    workspaceId: "workspace:test",
  });
  const sourceBefore = await readFile(store.filePath);
  await assert.rejects(
    store.quarantine(entry.id, undefined as unknown as MemoryMutationAuthorization, {
      expiresAt,
      purgeAfter,
    }),
    /MEMORY_APPROVAL_REQUIRED|MEMORY_CANONICAL_ASK_REQUIRED/u,
  );
  assert.equal(sha256(await readFile(store.filePath)), sha256(sourceBefore));

  const quarantined = await store.quarantine(entry.id, quarantineApproval.authorization, {
    expiresAt,
    purgeAfter,
    reason: "approved quarantine",
  });
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.lifecycle.state, "quarantined");
  assert.equal(quarantined.lifecycle.expiry.expiresAt, expiresAt);
  assert.equal(quarantined.lifecycle.expiry.purgeAfter, purgeAfter);
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.list({ includeQuarantined: true }))[0]?.id, entry.id);
  assert.equal((await store.status()).quarantined, 1);

  const staleProposal = createMemoryProposal({
    operation: "restore",
    workspaceId: "workspace:test",
    recordRef: entry.id,
    scope: "workspace",
    expectedRevision: 99,
    content: {
      ...quarantineContent,
      status: "active",
      forgottenReason: null,
      expiresAt: null,
      purgeAfter: null,
    },
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const staleApproval = createStoreAuthorization(staleProposal, "2026-08-04T03:00:00.000Z");
  const staleStore = defaultSparkMemoryStore(root, "workspace", undefined, {
    verifier: staleApproval.verifier,
    workspaceId: "workspace:test",
  });
  const quarantinedHash = sha256(await readFile(store.filePath));
  await assert.rejects(
    staleStore.restoreQuarantined(entry.id, staleApproval.authorization),
    /MEMORY_REVISION_CONFLICT/u,
  );
  assert.equal(sha256(await readFile(store.filePath)), quarantinedHash);

  const restoreContent = {
    category: quarantined.category,
    text: quarantined.text,
    reason: quarantined.reason,
    evidenceRefs: quarantined.evidenceRefs,
    tags: quarantined.tags,
    status: "active",
    forgottenReason: null,
    expiresAt: null,
    purgeAfter: null,
  };
  const restoreProposal = createMemoryProposal({
    operation: "restore",
    workspaceId: "workspace:test",
    recordRef: entry.id,
    scope: "workspace",
    expectedRevision: quarantined.lifecycle.revision.version,
    content: restoreContent,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const restoreApproval = createStoreAuthorization(restoreProposal, "2026-08-04T05:00:00.000Z");
  const restoreStore = defaultSparkMemoryStore(root, "workspace", undefined, {
    verifier: restoreApproval.verifier,
    workspaceId: "workspace:test",
  });
  const restored = await restoreStore.restoreQuarantined(entry.id, restoreApproval.authorization);
  assert.equal(restored.status, "active");
  assert.equal(restored.lifecycle.state, "promoted");
  assert.equal(restored.lifecycle.expiry.expiresAt, null);
  assert.equal(restored.lifecycle.expiry.purgeAfter, null);
  assert.equal(restored.lifecycle.revision.version, quarantined.lifecycle.revision.version + 1);
  assert.equal((await restoreStore.status()).quarantined, 0);
  await assert.rejects(readFile(`${store.filePath}.mutation-journal.json`));
});

test("quarantine manifest is digest-bound, reversible, and visibility time does not execute purge", async () => {
  const { root, manifest, sourceHash } = await fixtureManifest();
  const parsed = parseMemoryQuarantineManifest(manifest);
  assert.equal(parsed.planDigest, manifest.planDigest);
  const source = await verifyMemoryQuarantineManifest(parsed, root);
  const quarantined = await verifyMemoryQuarantineManifest(parsed, root, { useDestination: true });
  assert.deepEqual(source, {
    quarantineId: "quarantine:test",
    manifestDigest: manifest.planDigest,
    files: 2,
    bytes: 24,
    verified: 2,
    mismatches: [],
  });
  assert.deepEqual(quarantined, source);

  const executor = vi.fn();
  await assert.rejects(
    createMemoryPurgePlan({
      manifest,
      proposalId: "proposal:purge",
      workspaceId: "workspace:test",
      now: "2026-08-30T23:59:59.999Z",
      ...verifiedPlanTargets,
    }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError && error.code === "MEMORY_QUARANTINE_EXPIRED",
  );
  const plan = await createMemoryPurgePlan({
    manifest,
    proposalId: "proposal:purge",
    workspaceId: "workspace:test",
    now: "2026-08-31T00:00:00.000Z",
    ...verifiedPlanTargets,
  });
  assert.equal(executor.mock.calls.length, 0);
  assert.equal(sha256(await readFile(join(root, "memory/memory.json"))), sourceHash);
  assert.equal(plan.targets.length, 2);
});

test("legacy 134-file audit manifest remains readable with its original plan digest", async () => {
  const root = await temporaryRoot();
  const source = join(root, "memory.json");
  const destination = join(root, "quarantine/audit/files/memory.json");
  await writeFile(source, "legacy");
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
  const item = {
    source: "memory.json",
    destination: "quarantine/audit/files/memory.json",
    reasonCode: "legacy",
    bytes: 6,
    sha256: sha256("legacy"),
  };
  const core = {
    schemaVersion: 1,
    quarantineId: "legacy-audit",
    createdAt: "2026-07-29T12:11:35.000Z",
    expiresAt: "2026-08-28T12:11:35.000Z",
    policy: {
      physicalPurgeRequiresApproval: true,
      restoreBefore: "2026-08-28T12:11:35.000Z",
      naviaGraceDays: 30,
    },
    items: [item],
  };
  const legacy = {
    ...core,
    planDigest: sha256(JSON.stringify(core)),
    status: "quarantined",
    appliedAt: "2026-07-29T12:14:13.524Z",
  };
  const parsed = parseMemoryQuarantineManifest(legacy);
  assert.throws(
    () =>
      parseMemoryQuarantineManifest({
        ...legacy,
        items: [{ ...item, reverseRefs: ["evidence:tampered"] }],
      }),
    /MEMORY_QUARANTINE_MANIFEST_TAMPERED/u,
  );
  assert.equal(parsed.items[0]?.purgeAfter, legacy.expiresAt);
  assert.deepEqual(parsed.items[0]?.reverseRefs, []);
  assert.deepEqual(await verifyMemoryQuarantineManifest(parsed, root, { useDestination: true }), {
    quarantineId: "legacy-audit",
    manifestDigest: legacy.planDigest,
    files: 1,
    bytes: 6,
    verified: 1,
    mismatches: [],
  });
});

test("missing, stale, drifted, reverse-referenced, and reachable purge attempts never call the destructive executor", async () => {
  const { manifest } = await fixtureManifest();
  const executor = vi.fn();
  const plan = await createMemoryPurgePlan({
    manifest,
    proposalId: "proposal:purge-table",
    workspaceId: "workspace:test",
    now: "2026-09-01T00:00:00.000Z",
    ...verifiedPlanTargets,
  });
  const proposal = purgeProposal(plan);
  const current = createAuthorization(proposal, "2026-09-01T12:00:00.000Z");
  assert.throws(
    () => parseMemoryQuarantineProposal({ ...proposal, manifestDigest: "d".repeat(64) }),
    /quarantine proposal digest mismatch/u,
  );

  await assert.rejects(
    applyMemoryPurgePlan(plan, undefined, safePurgeExecution(proposal, executor)),
    (error: unknown) =>
      error instanceof MemoryQuarantineError && error.code === "MEMORY_CANONICAL_ASK_REQUIRED",
  );

  const stale = createAuthorization(proposal, "2026-09-03T00:00:00.000Z");
  await assert.rejects(
    applyMemoryPurgePlan(plan, stale.authorization, {
      ...safePurgeExecution(proposal, executor),
      verifier: stale.verifier,
      now: "2026-09-03T00:00:00.000Z",
    }),
    /MEMORY_APPROVAL_EXPIRED/u,
  );

  await assert.rejects(
    applyMemoryPurgePlan({ ...plan, manifestDigest: "b".repeat(64) }, current.authorization, {
      ...safePurgeExecution(proposal, executor),
      verifier: current.verifier,
      now: "2026-09-01T12:00:00.000Z",
    }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError &&
      error.code === "MEMORY_QUARANTINE_MANIFEST_TAMPERED",
  );

  const crossWorkspaceAuthorization = {
    ...current.authorization,
    proof: { ...current.authorization.proof, workspaceId: "workspace:other" },
  };
  await assert.rejects(
    applyMemoryPurgePlan(plan, crossWorkspaceAuthorization, {
      ...safePurgeExecution(proposal, executor),
      verifier: current.verifier,
      now: "2026-09-01T12:00:00.000Z",
    }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError &&
      error.code === "MEMORY_QUARANTINE_PROPOSAL_MISMATCH",
  );

  const conflicted = await applyMemoryPurgePlan(plan, current.authorization, {
    ...safePurgeExecution(proposal, executor),
    verifier: current.verifier,
    inspectTarget: () => ({ state: "conflict", reason: "generation mismatch" }),
    omitProposalIdFromTombstone: true,
    now: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(conflicted.tombstone?.status, "purge_incomplete");
  assert.equal(conflicted.tombstone?.proposalId, null);
  assert.equal(
    conflicted.targetReceipts.every((receipt) => receipt.status === "failed"),
    true,
  );

  const referenced = await fixtureManifest({ reverseRefs: ["evidence:reachable"] });
  await assert.rejects(
    createMemoryPurgePlan({
      manifest: referenced.manifest,
      proposalId: "proposal:referenced",
      workspaceId: "workspace:test",
      now: "2026-09-01T00:00:00.000Z",
      ...verifiedPlanTargets,
    }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError &&
      error.code === "MEMORY_QUARANTINE_REVERSE_REFERENCE",
  );

  await assert.rejects(
    createMemoryPurgePlan({
      manifest,
      proposalId: "proposal:reachable",
      workspaceId: "workspace:test",
      now: "2026-09-01T00:00:00.000Z",
      verifySource: () => true,
      verifyReachability: () => false,
    }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError && error.code === "MEMORY_QUARANTINE_REACHABILITY",
  );
  assert.equal(executor.mock.calls.length, 0);
});

test("staged purge persists receipts, leaves purge_incomplete on failure, and retries only the failed target", async () => {
  const { manifest } = await fixtureManifest();
  const plan = await createMemoryPurgePlan({
    manifest,
    proposalId: "proposal:staged",
    workspaceId: "workspace:test",
    now: "2026-09-01T00:00:00.000Z",
    ...verifiedPlanTargets,
  });
  const proposal = purgeProposal(plan);
  const { authorization, verifier } = createAuthorization(proposal, "2026-09-01T12:00:00.000Z");
  const calls = new Map<string, number>();
  const persisted: unknown[] = [];
  let failRevision = true;
  const executeTarget = vi.fn(
    async (target: MemoryQuarantineTarget, receipt: MemoryPurgeTargetReceipt) => {
      calls.set(target.id, (calls.get(target.id) ?? 0) + 1);
      if (target.kind === "revision" && failRevision) {
        throw new Error("injected revision failure");
      }
      return targetCompletion(target, receipt);
    },
  );

  const first = await applyMemoryPurgePlan(plan, authorization, {
    proposal,
    verifier,
    inspectTarget: () => ({ state: "not_started" }),
    executeTarget,
    persistState: (state) => {
      persisted.push(structuredClone(state));
    },
    verifySource: () => true,
    verifyReachability: () => true,
    now: "2026-09-01T12:00:00.000Z",
  });
  assert.equal(first.tombstone?.status, "purge_incomplete");
  assert.equal(first.tombstone?.remainingTargets.length, 1);
  assert.equal(first.targetReceipts.filter((receipt) => receipt.status === "completed").length, 1);
  const firstPending = persisted[0] as { targetReceipts: Array<{ status: string }> };
  assert.equal(firstPending.targetReceipts[0]?.status, "pending");
  assert.equal(first.targetReceipts[0]?.planDigest, plan.planDigest);
  assert.equal(first.targetReceipts[0]?.manifestDigest, plan.manifestDigest);

  failRevision = false;
  const second = await applyMemoryPurgePlan(plan, authorization, {
    proposal,
    verifier,
    inspectTarget: () => ({ state: "not_started" }),
    state: first,
    executeTarget,
    persistState: (state) => {
      persisted.push(structuredClone(state));
    },
    verifySource: () => true,
    verifyReachability: () => true,
    now: "2026-09-01T13:00:00.000Z",
  });
  const contentTarget = plan.targets.find((target) => target.kind === "content")!;
  const revisionTarget = plan.targets.find((target) => target.kind === "revision")!;
  assert.equal(calls.get(contentTarget.id), 1);
  assert.equal(calls.get(revisionTarget.id), 2);
  assert.equal(second.tombstone?.status, "complete");
  assert.deepEqual(second.tombstone?.remainingTargets, []);
  assert.equal(
    second.targetReceipts.every((receipt) => receipt.status === "completed"),
    true,
  );
  assert.ok(persisted.length >= 5);
  assert.deepEqual(parseMemoryPurgeTombstone(second.tombstone), second.tombstone);
  assert.throws(
    () => parseMemoryPurgeTombstone({ ...second.tombstone, text: "must not survive purge" }),
    /invalid purge receipts/u,
  );
  assert.throws(
    () =>
      parseMemoryPurgeTombstone({
        ...second.tombstone,
        status: "complete",
        targetReceipts: [{ ...second.targetReceipts[0], status: "failed" }],
        remainingTargets: [second.targetReceipts[0]!.targetId],
      }),
    /complete tombstone requires/u,
  );
});

test("a crash after destructive execution resumes from its persisted pending receipt with the same receipt identity", async () => {
  const { manifest } = await fixtureManifest();
  const plan = await createMemoryPurgePlan({
    manifest,
    proposalId: "proposal:crash-resume",
    workspaceId: "workspace:test",
    now: "2026-09-01T00:00:00.000Z",
    ...verifiedPlanTargets,
  });
  const proposal = purgeProposal(plan);
  const { authorization, verifier } = createAuthorization(proposal, "2026-09-01T12:00:00.000Z");
  let durableState: MemoryPurgeExecutionState | undefined;
  let injectCrash = true;
  const calls = new Map<string, number>();
  const completionMarkers = new Map<string, MemoryPurgeTargetCompletion>();
  const executeTarget = async (
    target: MemoryQuarantineTarget,
    receipt: MemoryPurgeTargetReceipt,
  ) => {
    calls.set(target.id, (calls.get(target.id) ?? 0) + 1);
    const completion = targetCompletion(target, receipt);
    completionMarkers.set(target.id, completion);
    return completion;
  };
  await assert.rejects(
    applyMemoryPurgePlan(plan, authorization, {
      proposal,
      verifier,
      inspectTarget: () => ({ state: "not_started" }),
      executeTarget,
      verifySource: () => true,
      verifyReachability: () => true,
      persistState: (state) => {
        if (state.targetReceipts.some((receipt) => receipt.status === "completed") && injectCrash) {
          injectCrash = false;
          throw new Error("injected receipt persistence crash");
        }
        durableState = structuredClone(state);
      },
      now: "2026-09-01T12:00:00.000Z",
    }),
    /injected receipt persistence crash/u,
  );
  assert.equal(durableState?.targetReceipts[0]?.status, "pending");
  const pendingReceiptId = durableState?.targetReceipts[0]?.receiptId;

  const resumed = await applyMemoryPurgePlan(plan, authorization, {
    proposal,
    verifier,
    state: durableState,
    inspectTarget: (target) => {
      const completion = completionMarkers.get(target.id);
      return completion ? { ...completion, state: "already_completed" } : { state: "not_started" };
    },
    executeTarget,
    verifySource: () => true,
    verifyReachability: () => true,
    persistState: (state) => {
      durableState = structuredClone(state);
    },
    now: "2026-09-01T13:00:00.000Z",
  });
  assert.equal(resumed.targetReceipts[0]?.receiptId, pendingReceiptId);
  assert.equal(resumed.tombstone?.status, "complete");
  assert.equal(calls.get(plan.targets[0]!.id), 1);
  assert.equal(calls.get(plan.targets[1]!.id), 1);
});

test("restore plan is reversible only inside the window and with its exact canonical approval", async () => {
  const { root, manifest } = await fixtureManifest();
  const proposalId = "proposal:restore";
  const plan = createMemoryRestorePlan({
    manifest,
    proposalId,
    workspaceId: "workspace:test",
    now: "2026-08-15T00:00:00.000Z",
  });
  const proposal = createMemoryQuarantineProposal({
    proposalId,
    operation: "restore",
    workspaceId: "workspace:test",
    recordRef: "memory:test",
    scope: "workspace",
    expectedRevision: 2,
    manifestDigest: manifest.planDigest,
    planDigest: plan.planDigest,
    createdAt: "2026-08-15T00:00:00.000Z",
    expiresAt: "2026-08-16T00:00:00.000Z",
  });
  const { authorization, verifier } = createAuthorization(proposal, "2026-08-15T12:00:00.000Z");
  const restored: string[] = [];
  const result = await applyMemoryRestorePlan(plan, authorization, {
    proposal,
    verifier,
    verifyDestination: async (item) => {
      const content = await readFile(join(root, item.destination));
      return content.byteLength === item.bytes && sha256(content) === item.sha256;
    },
    executeItem: async (item) => {
      restored.push(item.source);
      await cp(join(root, item.destination), join(root, item.source));
    },
    now: "2026-08-15T12:00:00.000Z",
  });
  assert.equal(result.restored, 2);
  assert.deepEqual(restored.sort(), manifest.items.map((item) => item.source).sort());

  assert.throws(
    () =>
      createMemoryRestorePlan({
        manifest,
        proposalId: "proposal:late",
        workspaceId: "workspace:test",
        now: manifest.expiresAt,
      }),
    (error: unknown) =>
      error instanceof MemoryQuarantineError && error.code === "MEMORY_QUARANTINE_EXPIRED",
  );
});

const productionAuditManifest =
  "/Users/zhanrongrui/workspace/zrr1999/spark/.spark/memory/quarantine/20260729T121135Z-approved-memory-audit/manifest.json";

test.skipIf(!existsSync(productionAuditManifest))(
  "validates the isolated copy of the approved 134-file quarantine without mutating it",
  async () => {
    const productionRaw = await readFile(productionAuditManifest, "utf8");
    const isolatedMemoryRoot = join(await temporaryRoot(), ".spark", "memory");
    const isolatedQuarantineDir = join(
      isolatedMemoryRoot,
      "quarantine",
      "20260729T121135Z-approved-memory-audit",
    );
    await mkdir(dirname(isolatedQuarantineDir), { recursive: true });
    await cp(dirname(productionAuditManifest), isolatedQuarantineDir, { recursive: true });
    const isolatedManifest = join(isolatedQuarantineDir, "manifest.json");
    const raw = await readFile(isolatedManifest, "utf8");
    const manifest = parseMemoryQuarantineManifest(JSON.parse(raw));
    assert.equal(
      manifest.planDigest,
      "c537fd58421d5345618ddb63cc2b89de007e80b4b39f4793e411e1924854f04b",
    );
    assert.equal(manifest.items.length, 134);
    assert.equal(manifest.expiresAt, "2026-08-28T12:11:35.000Z");
    const result = await verifyMemoryQuarantineManifest(manifest, isolatedMemoryRoot, {
      useDestination: true,
    });
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.verified, 134);
    assert.equal(result.bytes, 941_121);
    const restorePlan = createMemoryRestorePlan({
      manifest,
      proposalId: "proposal:legacy-restore-rehearsal",
      workspaceId: "workspace:isolated",
      now: "2026-08-15T00:00:00.000Z",
    });
    assert.equal(restorePlan.items.length, 134);
    assert.equal(sha256(await readFile(isolatedManifest, "utf8")), sha256(productionRaw));
    assert.equal(sha256(await readFile(productionAuditManifest, "utf8")), sha256(productionRaw));
  },
);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
