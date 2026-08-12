import {
  createSparkMemoryDirectIntentTurnAuthority,
  type SparkMemoryDirectIntentTurnAuthority,
} from "@zendev-lab/spark-host/memory-direct-intent";
import {
  parseSparkAssignment,
  sparkTurnCancelResultSchema,
  sparkTurnSubmitResultSchema,
} from "@zendev-lab/spark-protocol/daemon";
import {
  type SparkAssignment,
  type SparkInvocationStatus,
  type SparkTurnAttachment,
} from "@zendev-lab/spark-protocol/daemon";
import { createHubRuntimeSessionClient } from "./hub-runtime-session-client";
import { conversationTurnIdempotencyKey } from "./conversation-submission";

const hubMemoryDirectIntentAuthority = createSparkMemoryDirectIntentTurnAuthority();

export interface SubmitHubConversationTurnInput {
  workspaceId?: string;
  sessionId: string;
  prompt: string;
  title: string;
  /** Opaque browser-generated nonce reused only when retrying the same submit. */
  submissionId?: string;
  attachments?: SparkTurnAttachment[];
}

export interface SubmittedHubConversationTurn {
  turnId: string;
}

export interface CancelHubConversationTurnInput {
  turnId: string;
  sessionId: string;
  reason?: string;
}

export interface CancelledHubConversationTurn {
  turnId: string;
  status: SparkInvocationStatus;
  cancelRequested: boolean;
}

export interface HubConversationControlClient {
  submit(input: {
    sessionId: string;
    prompt: string;
    assignment: SparkAssignment;
    messageMetadata?: Record<string, unknown>;
    attachments?: SparkTurnAttachment[];
    idempotencyKey?: string;
  }): Promise<unknown>;
}

export interface HubConversationCancelClient {
  cancel(input: { sessionId: string; invocationId: string; reason?: string }): Promise<unknown>;
}

const runtimeConversationControlClient = createHubRuntimeSessionClient();

/**
 * Submit every Hub message through the daemon conversation control plane.
 * Channel ingress and the Web UI therefore append to the same native session
 * transcript instead of executing through separate Web-only task machinery.
 */
export interface SubmitHubConversationTurnOptions {
  /** Server-owned injection seam; never accepted from browser or model input. */
  memoryDirectIntentAuthority?: SparkMemoryDirectIntentTurnAuthority;
}

export async function submitConversationTurnForHub(
  input: SubmitHubConversationTurnInput,
  client: HubConversationControlClient = runtimeConversationControlClient,
  options: SubmitHubConversationTurnOptions = {},
): Promise<SubmittedHubConversationTurn> {
  const assignment = parseSparkAssignment({
    goal: input.prompt,
    title: input.title,
    target: {
      sessionId: input.sessionId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    },
    constraints: [],
    evidence: [],
    source: { kind: "hub" },
  });
  const idempotencyKey = conversationTurnIdempotencyKey(input.sessionId, input.submissionId);
  const directIntentTurnId = input.submissionId ?? globalThis.crypto.randomUUID();
  const memoryDirectIntent = input.workspaceId
    ? await (options.memoryDirectIntentAuthority ?? hubMemoryDirectIntentAuthority).issue({
        surface: "hub",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: `turn:${directIntentTurnId}`,
        messageId: `message:${directIntentTurnId}`,
        prompt: input.prompt,
      })
    : undefined;
  const feedbackReceipt = input.workspaceId
    ? await (options.memoryDirectIntentAuthority ?? hubMemoryDirectIntentAuthority).issueFeedback({
        surface: "hub",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: `turn:${directIntentTurnId}`,
        messageId: `message:${directIntentTurnId}`,
        prompt: input.prompt,
      })
    : undefined;
  const result = await client.submit({
    sessionId: input.sessionId,
    prompt: input.prompt,
    assignment,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    messageMetadata: {
      origin: { kind: "user", host: "web", surface: "local" },
      ...(memoryDirectIntent ? { memoryDirectIntent } : {}),
      ...(feedbackReceipt ? { memoryFeedback: feedbackReceipt } : {}),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map(({ kind, name, mediaType, size }) => ({
              kind,
              name,
              mediaType,
              size,
            })),
          }
        : {}),
    },
  });
  const receipt = sparkTurnSubmitResultSchema.safeParse(result);
  if (!receipt.success)
    throw new Error("Spark daemon returned an invalid conversation turn receipt.");
  return { turnId: receipt.data.invocationId };
}

/** Cancel a queued or active daemon turn after binding it to the selected session. */
export async function cancelConversationTurnForHub(
  input: CancelHubConversationTurnInput,
  client: HubConversationCancelClient = runtimeConversationControlClient,
): Promise<CancelledHubConversationTurn> {
  const turnId = input.turnId.trim();
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Select a conversation before cancelling its turn.");
  if (!turnId) throw new Error("Select a queued or active conversation turn to cancel.");
  const reason = input.reason?.trim();
  const result = await client.cancel({
    sessionId,
    invocationId: turnId,
    ...(reason ? { reason } : {}),
  });
  const receipt = sparkTurnCancelResultSchema.safeParse(result);
  if (!receipt.success) {
    throw new Error("Spark daemon returned an invalid conversation turn cancellation receipt.");
  }
  return {
    turnId,
    status: receipt.data.status,
    cancelRequested: receipt.data.cancelRequested,
  };
}
