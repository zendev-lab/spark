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
    Pick<SparkSessionMailStore, "pendingRequestHeads">;
}

export interface SessionMailQueueDrainResult {
  drained: number;
  skippedBusy: number;
}

/**
 * Drain the durable session-request queue: after a target session becomes
 * idle, submit its oldest pending request mail as a turn ("FIFO drain after
 * current"). The store returns one pending request head per session, so at
 * most one request per session is drained per pass and the invocation queue
 * of an idle session never grows ahead of the current work.
 *
 * Restart-safe: pending mails live in the mailbox.json files and each drained
 * turn is idempotent on `session.mail:<messageId>`, so a drain interrupted by
 * a daemon restart resumes without double execution.
 */
export async function drainSessionMailRequestQueue(
  deps: SessionMailQueueDrainDependencies,
  limit = 100,
): Promise<SessionMailQueueDrainResult> {
  const pending = await deps.mailStore.pendingRequestHeads(limit);
  let drained = 0;
  let skippedBusy = 0;
  for (const message of pending) {
    if (deps.invocationStore.listPendingForSession(message.toSessionId).length > 0) {
      skippedBusy += 1;
      continue;
    }
    const params = sessionSendRequestFromMessage(message);
    await submitSessionMailTurn(deps, params, message);
    drained += 1;
  }
  return { drained, skippedBusy };
}
