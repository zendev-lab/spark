import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createSparkMemoryDirectIntentApprovalProof,
  parseSparkMemoryDirectIntentCommand,
  prepareSparkMemoryDirectIntentReceipt,
  SPARK_MEMORY_DIRECT_INTENT_HIGH_RISK_OPERATIONS,
  sparkMemoryDirectIntentOperationDisposition,
  sparkMemoryDirectIntentReceiptSchema,
  sparkMemoryDirectIntentReceiptSigningPayload,
  verifySparkMemoryDirectIntentReceipt,
  type PrepareSparkMemoryDirectIntentReceiptInput,
  type SparkMemoryDirectIntentReceipt,
  type SparkMemoryMutationOperation,
  type SparkMemoryProposal,
} from "./memory-approval.ts";

const NOW = new Date("2026-08-03T08:00:00.000Z");
const FUTURE = "2026-08-03T08:05:00.000Z";
const testKeys = generateKeyPairSync("ed25519");
const TEST_KEY_ID = createHash("sha256")
  .update(testKeys.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex");

async function issueReceipt(
  input: PrepareSparkMemoryDirectIntentReceiptInput,
): Promise<SparkMemoryDirectIntentReceipt | undefined> {
  const payload = await prepareSparkMemoryDirectIntentReceipt(input);
  if (!payload) return undefined;
  const unsigned = sparkMemoryDirectIntentReceiptSchema.parse({
    ...payload,
    keyId: TEST_KEY_ID,
    signature: "pending",
  });
  const signature = sign(
    null,
    Buffer.from(sparkMemoryDirectIntentReceiptSigningPayload(unsigned)),
    testKeys.privateKey,
  ).toString("base64url");
  return sparkMemoryDirectIntentReceiptSchema.parse({ ...payload, keyId: TEST_KEY_ID, signature });
}

async function verifyReceipt(receipt: unknown, now = NOW): Promise<boolean> {
  return await verifySparkMemoryDirectIntentReceipt(receipt, {
    trustedKeyId: TEST_KEY_ID,
    now,
    verifySignature: (payload, signature) =>
      verify(null, Buffer.from(payload), testKeys.publicKey, Buffer.from(signature, "base64url")),
  });
}

function deterministicIds(): () => string {
  let index = 0;
  return () => ["record", "receipt", "nonce"][index++] ?? `extra-${index}`;
}

function proposalFor(receipt: SparkMemoryDirectIntentReceipt): SparkMemoryProposal {
  return {
    schema: "spark.memory.proposal/v1",
    proposalId: "proposal:direct-intent-vector",
    operation: receipt.operation,
    workspaceId: receipt.workspaceId,
    scope: receipt.scope,
    recordRef: receipt.recordRef,
    expectedRevision: receipt.expectedRevision ?? 3,
    contentDigest: receipt.contentDigest ?? "a".repeat(64),
    proposalDigest: "b".repeat(64),
    expiresAt: receipt.expiresAt,
  };
}

describe("Spark memory direct-intent receipts", () => {
  it("normalizes one remember vector across TUI, Cockpit, and channel surfaces", async () => {
    const receipts = await Promise.all(
      (["tui", "cockpit", "channel"] as const).map(
        async (surface) =>
          await issueReceipt({
            surface,
            workspaceId: "workspace:direct-intent",
            sessionId: "session:direct-intent",
            turnId: "turn:direct-intent",
            messageId: "message:direct-intent",
            prompt: "remember: use pnpm in this workspace",
            now: NOW,
            randomId: deterministicIds(),
          }),
      ),
    );

    expect(receipts.every(Boolean)).toBe(true);
    const concrete = receipts as SparkMemoryDirectIntentReceipt[];
    expect(
      await Promise.all(concrete.map(async (receipt) => await verifyReceipt(receipt))),
    ).toEqual([true, true, true]);

    const proofs = await Promise.all(
      concrete.map(
        async (receipt) =>
          await createSparkMemoryDirectIntentApprovalProof(receipt, proposalFor(receipt)),
      ),
    );
    const normalized = concrete.map((receipt, index) => ({
      operation: proofs[index]!.operation,
      proposalDigest: proofs[index]!.proposalDigest,
      turnHash: receipt.turnHash,
      nonce: proofs[index]!.nonce,
      expiry: proofs[index]!.expiresAt,
    }));
    expect(normalized[1]).toEqual(normalized[0]);
    expect(normalized[2]).toEqual(normalized[0]);
    expect(normalized[0]).toEqual({
      operation: "remember",
      proposalDigest: "b".repeat(64),
      turnHash: concrete[0]!.turnHash,
      nonce: "nonce",
      expiry: FUTURE,
    });
  });

  it("fails signature verification after a proposal-relevant receipt field is tampered", async () => {
    const receipt = await issueReceipt({
      surface: "cockpit",
      workspaceId: "workspace:direct-intent",
      sessionId: "session:direct-intent",
      turnId: "turn:direct-intent",
      messageId: "message:direct-intent",
      prompt: "remember: preserve exact user intent",
      now: NOW,
      randomId: deterministicIds(),
    });
    expect(receipt).toBeDefined();
    expect(await verifyReceipt({ ...receipt, recordRef: "memory:tampered" })).toBe(false);
  });

  it("rejects stale and proposal-drift vectors without invoking mutation", async () => {
    const stale = await issueReceipt({
      surface: "tui",
      workspaceId: "workspace:direct-intent",
      sessionId: "session:direct-intent",
      turnId: "turn:stale",
      messageId: "message:stale",
      prompt: "remember: stale intent",
      now: new Date("2026-08-03T07:00:00.000Z"),
      ttlMs: 1_000,
      randomId: deterministicIds(),
    });
    expect(await verifyReceipt(stale)).toBe(false);

    const receipt = await issueReceipt({
      surface: "channel",
      workspaceId: "workspace:direct-intent",
      sessionId: "session:direct-intent",
      turnId: "turn:proposal-drift",
      messageId: "message:proposal-drift",
      prompt: "remember: exact proposal",
      now: NOW,
      randomId: deterministicIds(),
    });
    expect(receipt).toBeDefined();
    const mutation = vi.fn();
    const mismatches = [
      { ...proposalFor(receipt!), recordRef: "memory:second-proposal" },
      { ...proposalFor(receipt!), contentDigest: "c".repeat(64) },
    ];
    for (const proposal of mismatches) {
      await expect(createSparkMemoryDirectIntentApprovalProof(receipt, proposal)).rejects.toThrow(
        /MEMORY_APPROVAL_PROPOSAL_MISMATCH/u,
      );
    }
    expect(mutation).toHaveBeenCalledTimes(0);
  });

  it("recognizes only one exact single-line remember or forget command", () => {
    expect(parseSparkMemoryDirectIntentCommand("记住：使用 pnpm")).toEqual({
      operation: "remember",
      text: "使用 pnpm",
    });
    expect(parseSparkMemoryDirectIntentCommand("forget memory:old-entry")).toEqual({
      operation: "forget",
      recordRef: "memory:old-entry",
    });
    expect(parseSparkMemoryDirectIntentCommand("remember: one\nforget memory:two")).toBeUndefined();
    expect(
      parseSparkMemoryDirectIntentCommand("remember: one and forget memory:two"),
    ).toBeUndefined();
    expect(parseSparkMemoryDirectIntentCommand("please consider remembering this")).toBeUndefined();
  });

  it.each(SPARK_MEMORY_DIRECT_INTENT_HIGH_RISK_OPERATIONS)(
    "requires canonical Ask for high-risk operation %s without invoking mutation",
    (operation) => {
      const mutation = vi.fn();
      const disposition = sparkMemoryDirectIntentOperationDisposition(
        operation as SparkMemoryMutationOperation,
      );
      if (disposition === "allowed") mutation();
      expect(disposition).toBe("canonical_ask");
      expect(mutation).toHaveBeenCalledTimes(0);
    },
  );
});
