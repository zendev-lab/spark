import type { SparkSessionMailStore, SparkSessionMailMessage } from "@zendev-lab/spark-session";
import type { SparkDaemonSessionControlOptions } from "./session-control.ts";
import type { SparkInvocationStore } from "./store/invocations.ts";
import {
  sessionSendRequestFromMessage,
  submitSessionMailTurn,
  type SessionMailTurnSubmitDependencies,
} from "./session-mail-execution.ts";

export interface SessionMailQueueDrainDependencies extends SessionMailTurnSubmitDependencies {
  invocationStore: Pick<SparkInvocationStore, "listPendingForSession">;
  mailStore: SessionMailTurnSubmitDependencies["mailStore"] &
    Pick<SparkSessionMailStore, "pendingRequests">;
}

export interface SessionMailQueueDrainResult {
  drained: number;
  skippedBusy: number;
}

/**
 * Drain the durable session-request queue: after a target session becomes
 * idle, submit its oldest pending request mail as a turn ("FIFO drain after
 * current"). At most one request per session is drained per pass so the
 * invocation queue of an idle session never grows ahead of the current work.
 *
 * Restart-safe: pending mails live in the mailbox.json files and each drained
 * turn is idempotent on `session.mail:<messageId>`, so a drain interrupted by
 * a daemon restart resumes without double execution.
 */
export async function drainSessionMailRequestQueue(
  deps: SessionMailQueueDrainDependencies,
  limit = 100,
): Promise<SessionMailQueueDrainResult> {
  const pending = await deps.mailStore.pendingRequests(limit);
  let drained = 0;
  let skippedBusy = 0;
  const drainedSessions = new Set<string>();
  for (const message of pending) {
    if (drainedSessions.has(message.toSessionId)) continue;
    if (deps.invocationStore.listPendingForSession(message.toSessionId).length > 0) {
      skippedBusy += 1;
      continue;
    }
    const params = sessionSendRequestFromMessage(message);
    await submitSessionMailTurn(deps, params, message);
    drainedSessions.add(message.toSessionId);
    drained += 1;
  }
  return { drained, skippedBusy };
}

/** True when the mail is an executable request still waiting in the durable queue. */
export function isPendingSessionRequest(message: SparkSessionMailMessage): boolean {
  return message.kind === "request" && message.requestAdmission?.status === "pending";
}
