import { describe, expect, it } from "vitest";

import { SparkHostRuntime } from "./runtime.ts";
import { createSparkMemoryDirectIntentTurnAuthority } from "./memory-direct-intent.ts";

const input = {
  surface: "tui" as const,
  workspaceId: "/workspace/direct-intent",
  sessionId: "session:direct-intent",
  turnId: "turn:direct-intent",
  messageId: "message:direct-intent",
  prompt: "remember: preserve the exact user command",
};

describe("host-private memory direct-intent authority", () => {
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

  it("exposes only receipt verification to tool context, never signer or private key", async () => {
    const authority = createSparkMemoryDirectIntentTurnAuthority();
    const receipt = await authority.issue(input);
    const host = new SparkHostRuntime({
      cwd: input.workspaceId,
      memoryDirectIntentAuthority: authority,
    });
    host.setSessionId(input.sessionId);
    const context = host.makeContext();

    expect(context.memoryDirectIntent).toEqual(receipt);
    expect(await context.verifyMemoryDirectIntent?.(receipt)).toBe(true);
    expect("memoryDirectIntentAuthority" in context).toBe(false);
    expect("issueMemoryDirectIntent" in context).toBe(false);
    expect("signMemoryDirectIntent" in context).toBe(false);
    expect("memoryDirectIntentPrivateKey" in context).toBe(false);
    expect("memoryDirectIntentReceiptWriter" in context).toBe(false);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("receiptWriter");
    expect(serialized).not.toContain("signMemoryDirectIntent");
  });
});
