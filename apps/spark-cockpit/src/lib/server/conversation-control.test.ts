import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelConversationTurnForCockpit,
  submitConversationTurnForCockpit,
  type CockpitConversationCancelClient,
  type CockpitConversationControlClient,
} from "./conversation-control";

const directIntentRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    directIntentRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function snapshotDigest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

describe("Cockpit conversation control", () => {
  it("submits Web messages through the daemon-owned turn surface", async () => {
    const client = {
      submit: vi.fn(async () => ({
        invocationId: "inv_001",
        status: "queued",
        acceptedAt: "2026-07-14T00:00:00.000Z",
      })),
    } satisfies CockpitConversationControlClient;

    await expect(
      submitConversationTurnForCockpit(
        {
          workspaceId: "ws_demo",
          sessionId: "sess_demo",
          prompt: "Continue the same conversation.",
          title: "Continue the same conversation.",
        },
        client,
      ),
    ).resolves.toEqual({ turnId: "inv_001" });

    expect(client.submit).toHaveBeenCalledWith({
      sessionId: "sess_demo",
      prompt: "Continue the same conversation.",
      assignment: {
        goal: "Continue the same conversation.",
        title: "Continue the same conversation.",
        target: { sessionId: "sess_demo", workspaceId: "ws_demo" },
        constraints: [],
        evidence: [],
        source: { kind: "cockpit" },
      },
      messageMetadata: {
        origin: { kind: "user", host: "web", surface: "local" },
      },
    });
  });

  it("attaches a signed one-turn receipt for one exact direct memory command", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_001",
      status: "queued",
      acceptedAt: "2026-08-03T08:00:00.000Z",
    });

    await submitConversationTurnForCockpit(
      {
        workspaceId: "ws_direct_intent",
        sessionId: "sess_direct_intent",
        prompt: "remember: keep Cockpit intent exact",
        title: "Remember preference",
        submissionId: "submission-direct-intent",
      },
      { submit },
    );

    const metadata = submit.mock.calls[0]?.[0].messageMetadata;
    const receipt = metadata?.memoryDirectIntent;
    expect(receipt).toMatchObject({
      schema: "spark.memory.direct-intent-receipt/v1",
      surface: "cockpit",
      workspaceId: "ws_direct_intent",
      sessionId: "sess_direct_intent",
      turnId: "turn:submission-direct-intent",
      messageId: "message:submission-direct-intent",
      operation: "remember",
      keyId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      signature: expect.any(String),
    });
    expect(JSON.stringify(metadata)).not.toContain("keep Cockpit intent exact");
  });

  it.each([
    "ambiguous",
    "multiple-proposals",
    "stale-message",
    "cross-turn-retry",
    "proposal-drift",
    "message-replay",
  ] as const)("fails closed for Cockpit direct-intent case %s", async (name) => {
    const root = await mkdtemp(join(tmpdir(), `spark-cockpit-direct-${name}-`));
    directIntentRoots.push(root);
    const snapshotPath = join(root, ".spark", "memory", "memory.json");
    await mkdir(join(root, ".spark", "memory"), { recursive: true });
    await writeFile(snapshotPath, '{"entries":[]}\n', "utf8");
    const before = await snapshotDigest(snapshotPath);
    const mutation = vi.fn();
    const authority = createSparkMemoryDirectIntentTurnAuthority();
    const prompt =
      name === "ambiguous"
        ? "remember: one and forget memory:two"
        : name === "multiple-proposals"
          ? "remember: first and remember: second"
          : "remember: keep Cockpit intent exact";
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_001",
      status: "queued",
      acceptedAt: "2026-08-03T08:00:00.000Z",
    });
    const injectedAuthority = {
      ...authority,
      async issue(input: Parameters<typeof authority.issue>[0]) {
        const receipt = await authority.issue(
          name === "stale-message"
            ? { ...input, now: new Date("2000-01-01T00:00:00.000Z"), ttlMs: 1 }
            : input,
        );
        if (!receipt) return undefined;
        if (name === "cross-turn-retry") authority.clear();
        if (name === "message-replay") {
          await authority.issue({
            ...input,
            turnId: `${input.turnId}:successor`,
            messageId: `${input.messageId}:successor`,
            prompt: "remember: successor Cockpit turn",
          });
        }
        return name === "proposal-drift" ? { ...receipt, contentDigest: "a".repeat(64) } : receipt;
      },
    };

    await submitConversationTurnForCockpit(
      {
        workspaceId: root,
        sessionId: "sess_direct_invalid",
        prompt,
        title: "Invalid direct intent",
        submissionId: `submission-${name}`,
      },
      { submit },
      { memoryDirectIntentAuthority: injectedAuthority },
    );

    const receipt = submit.mock.calls[0]?.[0].messageMetadata?.memoryDirectIntent;
    const errorCode = receipt
      ? (await authority.verifyCurrent(receipt))
        ? undefined
        : "MEMORY_APPROVAL_INVALID"
      : "MEMORY_APPROVAL_REQUIRED";
    if (!errorCode) mutation();
    expect(errorCode).toBe(
      name === "ambiguous" || name === "multiple-proposals"
        ? "MEMORY_APPROVAL_REQUIRED"
        : "MEMORY_APPROVAL_INVALID",
    );
    expect(mutation).toHaveBeenCalledTimes(0);
    expect(await snapshotDigest(snapshotPath)).toBe(before);
  });

  it("forwards a browser submission nonce as a stable daemon idempotency key", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_nonce",
      status: "queued",
      acceptedAt: "2026-07-15T00:00:00.000Z",
    });

    await submitConversationTurnForCockpit(
      {
        workspaceId: "ws_demo",
        sessionId: "sess_demo",
        prompt: "Run once",
        title: "Run once",
        submissionId: "submit_018f",
      },
      { submit },
    );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess_demo",
        prompt: "Run once",
        idempotencyKey: expect.stringMatching(/^idem_[a-f0-9]{32}$/),
      }),
    );
  });

  it("forwards attachment bytes while keeping transcript metadata display-safe", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_attachment",
      status: "queued",
      acceptedAt: "2026-07-15T00:00:00.000Z",
    });
    const attachment = {
      kind: "image" as const,
      name: "shot.png",
      mediaType: "image/png",
      size: 3,
      data: "AQID",
    };

    await submitConversationTurnForCockpit(
      {
        sessionId: "sess_demo",
        prompt: "Inspect this image.\n\n[Image: shot.png]",
        title: "Inspect this image.",
        attachments: [attachment],
      },
      { submit },
    );

    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [attachment],
        messageMetadata: {
          origin: { kind: "user", host: "web", surface: "local" },
          attachments: [
            {
              kind: "image",
              name: "shot.png",
              mediaType: "image/png",
              size: 3,
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(submit.mock.calls[0]?.[0].messageMetadata)).not.toContain("AQID");
  });

  it("submits daemon-global messages without inventing a workspace target", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_global",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
    });

    await expect(
      submitConversationTurnForCockpit(
        {
          sessionId: "sess_global",
          prompt: "Inspect daemon health",
          title: "Inspect daemon health",
        },
        { submit },
      ),
    ).resolves.toEqual({ turnId: "inv_global" });

    expect(submit).toHaveBeenCalledWith({
      sessionId: "sess_global",
      prompt: "Inspect daemon health",
      assignment: expect.objectContaining({
        target: { sessionId: "sess_global" },
      }),
      messageMetadata: {
        origin: { kind: "user", host: "web", surface: "local" },
      },
    });
  });

  it("reuses the browser submission identity across repeated action delivery", async () => {
    const submit = vi.fn().mockResolvedValue({
      invocationId: "inv_stable",
      status: "queued",
      acceptedAt: "2026-07-14T00:00:00.000Z",
    });
    const input = {
      sessionId: "sess_stable",
      prompt: "Retry this exact message",
      title: "Retry this exact message",
      submissionId: "browser-submission-1",
    };

    await submitConversationTurnForCockpit(input, { submit });
    await submitConversationTurnForCockpit(input, { submit });

    const firstKey = submit.mock.calls[0]?.[0].idempotencyKey;
    expect(firstKey).toMatch(/^idem_[a-f0-9]{32}$/);
    expect(submit.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
  });

  it("rejects malformed daemon receipts", async () => {
    const client = {
      submit: vi.fn(async () => ({})),
    } satisfies CockpitConversationControlClient;

    await expect(
      submitConversationTurnForCockpit(
        {
          workspaceId: "ws_demo",
          sessionId: "sess_demo",
          prompt: "Hello",
          title: "Hello",
        },
        client,
      ),
    ).rejects.toThrow("invalid conversation turn receipt");
  });

  it("cancels a queued or active daemon turn within its submitted session", async () => {
    const client = {
      cancel: vi.fn(async () => ({
        invocationId: "inv_001",
        status: "running",
        cancelRequested: true,
      })),
    } satisfies CockpitConversationCancelClient;

    await expect(
      cancelConversationTurnForCockpit(
        {
          sessionId: "  sess_001  ",
          turnId: "  inv_001  ",
          reason: "  Stopped from Cockpit.  ",
        },
        client,
      ),
    ).resolves.toEqual({
      turnId: "inv_001",
      status: "running",
      cancelRequested: true,
    });

    expect(client.cancel).toHaveBeenCalledWith({
      sessionId: "sess_001",
      invocationId: "inv_001",
      reason: "Stopped from Cockpit.",
    });
  });

  it("omits an empty cancellation reason", async () => {
    const cancel = vi.fn(async () => ({
      invocationId: "inv_missing",
      status: "cancelled",
      cancelRequested: false,
    }));

    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "inv_missing", reason: "   " },
        { cancel },
      ),
    ).resolves.toEqual({
      turnId: "inv_missing",
      status: "cancelled",
      cancelRequested: false,
    });

    expect(cancel).toHaveBeenCalledWith({
      sessionId: "sess_001",
      invocationId: "inv_missing",
    });
  });

  it.each([
    null,
    {},
    { invocationId: "inv_001", status: "running", cancelRequested: "yes" },
    { invocationId: "not-an-invocation", status: "running", cancelRequested: true },
    { invocationId: "inv_001", status: "unknown", cancelRequested: true },
  ])("rejects malformed daemon cancellation receipts: %j", async (receipt) => {
    await expect(
      cancelConversationTurnForCockpit(
        { sessionId: "sess_001", turnId: "inv_001" },
        { cancel: async () => receipt },
      ),
    ).rejects.toThrow("invalid conversation turn cancellation receipt");
  });

  it("requires both the owning session and turn id before calling the daemon", async () => {
    const cancel = vi.fn();

    await expect(
      cancelConversationTurnForCockpit({ sessionId: "   ", turnId: "inv_001" }, { cancel }),
    ).rejects.toThrow("Select a conversation");
    await expect(
      cancelConversationTurnForCockpit({ sessionId: "sess_001", turnId: "   " }, { cancel }),
    ).rejects.toThrow("Select a queued or active conversation turn");
    expect(cancel).not.toHaveBeenCalled();
  });
});
