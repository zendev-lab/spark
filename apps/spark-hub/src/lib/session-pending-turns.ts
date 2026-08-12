import type { SparkSessionView } from "@zendev-lab/spark-protocol/presentation";

export interface HubPendingTurn {
  commandId: string;
  invocationId: string;
  prompt: string;
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
}

/**
 * Prefer daemon admission truth (`session.pendingTurns`) whenever a real
 * session snapshot is available. Hub's runtime projection is offline-only
 * fallback and must not invent queue rows while the daemon view is live.
 */
export function resolveSessionPendingTurns(
  projected: readonly HubPendingTurn[],
  session: SparkSessionView | null,
): HubPendingTurn[] {
  if (!session || session.pendingTurns === undefined) return [...projected];
  return session.pendingTurns.map((turn) => ({
    commandId: turn.invocationId,
    invocationId: turn.invocationId,
    prompt: turn.prompt,
    status: turn.status,
    createdAt: turn.createdAt,
    startedAt: turn.startedAt ?? null,
  }));
}
