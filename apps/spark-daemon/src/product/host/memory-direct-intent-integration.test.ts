import { describe, expect, it } from "vitest";

import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-memory/direct-intent";
import { SparkHostRuntime } from "./runtime.ts";

const input = {
  surface: "tui" as const,
  workspaceId: "/workspace/direct-intent",
  sessionId: "session:direct-intent",
  turnId: "turn:direct-intent",
  messageId: "message:direct-intent",
  prompt: "remember: preserve the exact user command",
};

describe("memory direct-intent host projection", () => {
  it("exposes feedback verification without signer or trusted telemetry writer", async () => {
    const authority = createSparkMemoryDirectIntentTurnAuthority();
    const receipt = await authority.issueFeedback({
      ...input,
      prompt: "memory feedback positive memory:ranked",
    });
    const host = new SparkHostRuntime({
      cwd: input.workspaceId,
      memoryDirectIntentAuthority: authority,
    });
    host.setSessionId(input.sessionId);
    const context = host.makeContext();
    expect(context.memoryFeedback).toEqual(receipt);
    expect((await context.verifyMemoryFeedback?.(receipt))?.ok).toBe(true);
    expect("memoryFeedbackAuthority" in context).toBe(false);
    expect("signMemoryFeedback" in context).toBe(false);
    expect("trustedTelemetryWriter" in context).toBe(false);
    expect("recordTrustedMemoryFeedback" in context).toBe(false);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("trustedTelemetryWriter");
  });

  it("exposes only receipt verification to tool context", async () => {
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
