import { DatabaseSync } from "node:sqlite";
import { parseSparkAssignment } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import type { SparkDaemonSessionRunTask } from "../core/types.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import {
  channelInboundInvocationIdempotencyKey,
  channelInboundMessageIdempotencyKey,
  submitChannelInboundInvocation,
} from "./admission.ts";
import type { ChannelIngressAssignment } from "./ingress.ts";

function assignment(input?: {
  account?: string;
  externalKey?: string;
  messageId?: string;
  sessionId?: string;
}): ChannelIngressAssignment {
  const sessionId = input?.sessionId ?? "sess_channel_a";
  const messageId = input?.messageId ?? "message-1";
  const externalKey = input?.externalKey ?? "qqbot:c2c:user-1";
  const parsed = parseSparkAssignment({
    goal: "hello",
    target: { sessionId },
    source: {
      kind: "channel",
      channel: "qqbot",
      ...(messageId ? { externalRef: messageId } : {}),
    },
  });
  return {
    sessionId,
    goal: parsed.goal,
    assignment: parsed,
    source: {
      kind: "channel",
      channel: "qqbot",
      ...(messageId ? { externalRef: messageId } : {}),
    },
    externalKey,
    ...(input?.account === "" ? {} : { adapterAccountIdentity: input?.account ?? "qqbot:app-1" }),
    channelReply: {
      adapter: "qqbot",
      adapterId: "qq-main",
      externalKey,
      recipient: "c2c:user-1",
    },
    channelContext: { externalKey, ...(messageId ? { messageId } : {}) },
  };
}

describe("daemon Channel inbound admission", () => {
  it("keys a platform message by account, conversation, and message identity", () => {
    const first = assignment();
    const replay = assignment({ sessionId: "sess_drifted" });
    const otherAccount = assignment({ account: "qqbot:app-2" });
    const otherConversation = assignment({ externalKey: "qqbot:c2c:user-2" });

    expect(channelInboundInvocationIdempotencyKey(first)).toBe(
      channelInboundInvocationIdempotencyKey(replay),
    );
    expect(channelInboundInvocationIdempotencyKey(otherAccount)).not.toBe(
      channelInboundInvocationIdempotencyKey(first),
    );
    expect(channelInboundInvocationIdempotencyKey(otherConversation)).not.toBe(
      channelInboundInvocationIdempotencyKey(first),
    );
  });

  it("fails closed when a durable provider account identity is absent", () => {
    expect(channelInboundInvocationIdempotencyKey(assignment({ account: "" }))).toBeUndefined();
    expect(() =>
      channelInboundMessageIdempotencyKey({
        adapter: "qqbot",
        adapterId: "qq-main",
        externalKey: "qqbot:c2c:user-1",
        messageId: "message-1",
      }),
    ).toThrow(/adapterAccountIdentity/u);
  });

  it("returns the original invocation when a replay projection has drifted", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const inbound = assignment();
      const original: SparkDaemonSessionRunTask = {
        type: "session.run",
        sessionId: inbound.sessionId,
        prompt: inbound.goal,
        cwd: "/daemon/channels/sessions/sess_channel_a/workspace",
        assignment: inbound.assignment,
        channelReply: {
          ...inbound.channelReply,
          adapterAccountIdentity: inbound.adapterAccountIdentity,
        },
        channelContext: inbound.channelContext,
      };
      const first = submitChannelInboundInvocation(store, inbound, original);
      const replay = submitChannelInboundInvocation(store, inbound, {
        ...original,
        cwd: "/daemon/channels/sessions/sess_channel_a/workspace-after-restart",
        model: "provider/new-default",
      });

      expect(replay.invocationId).toBe(first.invocationId);
      expect(replay.task).toEqual(original);
      expect(replay.workspaceBindingId).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("keeps messages without platform ids intentionally non-idempotent", () => {
    expect(channelInboundInvocationIdempotencyKey(assignment({ messageId: "" }))).toBeUndefined();
  });
});
