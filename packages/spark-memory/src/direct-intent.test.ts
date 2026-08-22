import { describe, expect, it } from "vitest";

import { createSparkMemoryDirectIntentTurnAuthority } from "./direct-intent.ts";

const input = {
  surface: "tui" as const,
  workspaceId: "/workspace/direct-intent",
  sessionId: "session:direct-intent",
  turnId: "turn:direct-intent",
  messageId: "message:direct-intent",
  prompt: "remember: preserve the exact user command",
};

const feedbackInput = {
  ...input,
  prompt: "memory feedback positive memory:ranked",
};

describe("memory direct-intent authority", () => {
  it("verifies only the exact current receipt from its private signing key", async () => {
    const authority = createSparkMemoryDirectIntentTurnAuthority();
    const receipt = await authority.issue(input);
    expect(receipt).toBeDefined();
    expect(await authority.verifyCurrent(receipt)).toBe(true);

    for (const mutation of [
      { turnId: "turn:other" },
      { messageId: "message:other" },
      { workspaceId: "/workspace/other" },
      { sessionId: "session:other" },
      { contentDigest: "a".repeat(64) },
      { nonce: "other-nonce" },
      { expiresAt: "2099-01-01T00:00:00.000Z" },
      { signature: "forged" },
    ]) {
      expect(await authority.verifyCurrent({ ...receipt, ...mutation })).toBe(false);
    }
  });

  it("rejects receipts from another authority and after process-local state is cleared", async () => {
    const trusted = createSparkMemoryDirectIntentTurnAuthority();
    const foreign = createSparkMemoryDirectIntentTurnAuthority();
    const trustedReceipt = await trusted.issue(input);
    const foreignReceipt = await foreign.issue(input);
    expect(await trusted.verifyCurrent(foreignReceipt)).toBe(false);
    expect(await trusted.verifyCurrent(trustedReceipt)).toBe(true);

    trusted.clear();
    expect(await trusted.verifyCurrent(trustedReceipt)).toBe(false);
    const restarted = createSparkMemoryDirectIntentTurnAuthority();
    expect(await restarted.verifyCurrent(trustedReceipt)).toBe(false);
  });

  it("classifies five invalid current-turn feedback receipts with stable codes and zero writes", async () => {
    const cases = [
      {
        name: "stale-message",
        mutate: (receipt: object) => ({ ...receipt, messageId: "message:stale" }),
        code: "MEMORY_FEEDBACK_STALE_MESSAGE",
      },
      {
        name: "cross-turn",
        mutate: (receipt: object) => ({ ...receipt, turnId: "turn:other" }),
        code: "MEMORY_FEEDBACK_CROSS_TURN",
      },
      {
        name: "proposal-drift",
        mutate: (receipt: object) => ({ ...receipt, memoryRef: "memory:drift" }),
        code: "MEMORY_FEEDBACK_PROPOSAL_DRIFT",
      },
    ] as const;
    const writerCalls: string[] = [];
    for (const vector of cases) {
      const authority = createSparkMemoryDirectIntentTurnAuthority();
      const receipt = await authority.issueFeedback(feedbackInput);
      const verified = await authority.verifyCurrentFeedback(vector.mutate(receipt!));
      if (verified.ok) writerCalls.push(vector.name);
      expect(verified).toEqual({ ok: false, code: vector.code });
    }
    const missing = createSparkMemoryDirectIntentTurnAuthority();
    expect(await missing.verifyCurrentFeedback(undefined)).toEqual({
      ok: false,
      code: "MEMORY_FEEDBACK_AMBIGUOUS",
    });
    const replay = createSparkMemoryDirectIntentTurnAuthority();
    const receipt = await replay.issueFeedback(feedbackInput);
    expect((await replay.verifyCurrentFeedback(receipt)).ok).toBe(true);
    const replayed = await replay.verifyCurrentFeedback(receipt);
    if (replayed.ok) writerCalls.push("replay");
    expect(replayed).toEqual({ ok: false, code: "MEMORY_FEEDBACK_REPLAYED" });
    expect(writerCalls).toEqual([]);
  });
});
