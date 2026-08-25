import { createHash } from "node:crypto";
import type { IncomingMessage } from "@zendev-lab/dsh-channel-transports";
import type { SparkDaemonSessionRunTask } from "../core/types.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "../store/invocations.ts";
import type { ChannelIngressAssignment } from "./ingress.ts";

const CHANNEL_INBOUND_IDEMPOTENCY_VERSION = "v2";
const LEGACY_CHANNEL_INBOUND_IDEMPOTENCY_VERSION = "v1";

/**
 * Derive a stable daemon admission key without embedding platform identifiers in the key.
 *
 * Platform message ids are only authoritative within their provider-account
 * and conversation scope, so account, conversation, and message id all
 * participate in the digest. Messages without a platform id deliberately
 * retain the historical non-idempotent admission path.
 */
export function channelInboundInvocationIdempotencyKey(
  assignment: Pick<
    ChannelIngressAssignment,
    "channelReply" | "externalKey" | "source" | "channelContext" | "adapterAccountIdentity"
  >,
): string | undefined {
  const messageId =
    assignment.source.externalRef?.trim() || assignment.channelContext?.messageId?.trim();
  if (!messageId) return undefined;

  if (!assignment.adapterAccountIdentity?.trim()) {
    return undefined;
  }
  return channelInboundMessageIdempotencyKey({
    adapter: assignment.source.channel,
    adapterId: assignment.channelReply.adapterId,
    adapterAccountIdentity: assignment.adapterAccountIdentity,
    externalKey: assignment.externalKey,
    messageId,
  });
}

export function channelInboundMessageIdempotencyKey(
  message: Pick<
    IncomingMessage,
    "adapter" | "adapterId" | "adapterAccountIdentity" | "externalKey" | "messageId"
  >,
): string | undefined {
  const messageId = message.messageId?.trim();
  if (!messageId) return undefined;
  const adapterAccountIdentity = message.adapterAccountIdentity?.trim();
  const externalKey = message.externalKey.trim();
  if (!adapterAccountIdentity || !externalKey) {
    throw new Error("channel inbound idempotency requires adapterAccountIdentity and externalKey");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        CHANNEL_INBOUND_IDEMPOTENCY_VERSION,
        adapterAccountIdentity,
        externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel.inbound:${CHANNEL_INBOUND_IDEMPOTENCY_VERSION}:${digest}`;
}

/** Upgrade-only alias for durable rows written before account-scoped keys. */
export function legacyChannelInboundMessageIdempotencyKey(
  workspaceId: string,
  message: Pick<IncomingMessage, "adapter" | "externalKey" | "messageId">,
): string | undefined {
  const messageId = message.messageId?.trim();
  if (!messageId) return undefined;
  const normalizedWorkspaceId = workspaceId.trim();
  const adapterId = message.adapter.trim();
  const externalKey = message.externalKey.trim();
  if (!normalizedWorkspaceId || !adapterId || !externalKey) {
    throw new Error("channel inbound idempotency requires workspaceId, adapterId, and externalKey");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        LEGACY_CHANNEL_INBOUND_IDEMPOTENCY_VERSION,
        normalizedWorkspaceId,
        adapterId,
        externalKey,
        messageId,
      ]),
    )
    .digest("hex");
  return `channel.inbound:${LEGACY_CHANNEL_INBOUND_IDEMPOTENCY_VERSION}:${digest}`;
}

/**
 * Locate the account-scoped admission. Upgrade replay protection for v1 keys
 * happens at the earlier durable inbound-receipt boundary, where the persisted
 * adapter instance can be inspected without reconstructing a retired
 * Workspace id.
 */
export function findChannelInboundInvocation(
  store: SparkInvocationStore,
  assignment: ChannelIngressAssignment,
): SparkInvocationRecord | undefined {
  const idempotencyKey = channelInboundInvocationIdempotencyKey(assignment);
  if (!idempotencyKey) return undefined;
  return store.findByIdempotencyKey(idempotencyKey);
}

/**
 * The single durable admission boundary used by daemon channel runtimes.
 * SparkInvocationStore's unique idempotency index fences overlapping daemon
 * processes; a replay returns the original invocation record.
 *
 * Channel Sessions are already daemon-owned; no Workspace route participates
 * in admission or idempotency.
 */
export function submitChannelInboundInvocation(
  store: SparkInvocationStore,
  assignment: ChannelIngressAssignment,
  task: SparkDaemonSessionRunTask,
): SparkInvocationRecord {
  const idempotencyKey = channelInboundInvocationIdempotencyKey(assignment);
  // Platform identity is authoritative for a replay. Return before rebuilding
  // admission from mutable session/model state, which may have changed while a
  // second daemon was starting.
  if (idempotencyKey) {
    const existing = findChannelInboundInvocation(store, assignment);
    if (existing) return existing;
  }

  try {
    return store.submit({
      sessionId: task.sessionId,
      prompt: task.prompt,
      task,
      sourceKind: "channel",
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    // Two SQLite connections may both observe absence before the UNIQUE insert.
    // A cryptographically scoped platform identity wins over task/config drift.
    const raced = idempotencyKey ? findChannelInboundInvocation(store, assignment) : undefined;
    if (raced) return raced;
    throw error;
  }
}
