import {
  sparkTurnSubmitResultSchema,
  sparkSessionSendRequestSchema,
  type SparkSessionMailMessage,
  type SparkSessionSendRequest,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import type { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkDaemonSessionControlOptions } from "./session-control.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";

/**
 * Maximum number of request mails that may wait in one target session's
 * durable queue. The queue is drained after each current invocation, so this
 * only bounds backlog between drains.
 */
export const MAX_PENDING_SESSION_REQUEST_QUEUE = 3;

export interface SessionMailTurnSubmitDependencies {
  control: SparkDaemonSessionControlOptions;
  mailStore: Pick<SparkSessionMailStore, "recordRequestAdmission">;
}

export interface SessionMailTurnSubmission {
  submitted: SparkTurnSubmitResult;
  message: SparkSessionMailMessage;
}

/**
 * Submit one request mail as a turn on the target session and record the
 * accepted admission. Idempotent on `session.mail:<messageId>`: a replay or a
 * drained duplicate returns the existing invocation receipt.
 */
export async function submitSessionMailTurn(
  deps: SessionMailTurnSubmitDependencies,
  params: SparkSessionSendRequest,
  message: SparkSessionMailMessage,
): Promise<SessionMailTurnSubmission> {
  const idempotencyKey = `session.mail:${message.id}`;
  const submitted = sparkTurnSubmitResultSchema.parse(
    (
      await executeSparkDaemonSessionControl(deps.control, {
        kind: "turn.submit.request",
        scope: "any",
        sessionId: params.toSessionId,
        idempotencyKey,
        payload: {
          sessionId: params.toSessionId,
          prompt: params.body,
          idempotencyKey,
          ...(params.originBinding ? { originBinding: params.originBinding } : {}),
          messageMetadata: {
            origin: {
              kind: "session",
              sessionId: params.fromSessionId,
              surface: params.origin.surface,
              host: params.origin.host,
            },
            sessionMail: {
              messageId: message.id,
              kind: message.kind,
              intent: message.intent,
              correlationId: message.correlationId,
              fromSessionId: message.fromSessionId,
              toSessionId: message.toSessionId,
              wake: params.wake,
              ...(Object.keys(params.payload).length > 0 ? { requestPayload: params.payload } : {}),
              ...(params.parentInvocationId
                ? { parentInvocationId: params.parentInvocationId }
                : {}),
            },
          },
        },
      })
    ).result,
  );
  const admitted = await deps.mailStore.recordRequestAdmission(
    params.toSessionId,
    message.id,
    submitted,
  );
  return { submitted, message: admitted };
}

/** Rebuild the original send request from a persisted mail so a queued request drains with the same envelope. */
export function sessionSendRequestFromMessage(
  message: SparkSessionMailMessage,
): SparkSessionSendRequest {
  const execution = message.requestExecution;
  return sparkSessionSendRequestSchema.parse({
    toSessionId: message.toSessionId,
    fromSessionId: message.fromSessionId,
    kind: message.kind,
    intent: message.intent,
    payload: message.payload,
    correlationId: message.correlationId,
    idempotencyKey: message.idempotencyKey ?? `session.mail:${message.id}`,
    subject: message.subject,
    body: message.body,
    origin: execution?.origin ?? { surface: "local", host: "daemon" },
    notifyOnCompletion: execution?.notifyOnCompletion ?? false,
    ...(execution?.parentInvocationId ? { parentInvocationId: execution.parentInvocationId } : {}),
    ...(message.originBinding ? { originBinding: message.originBinding } : {}),
  });
}
