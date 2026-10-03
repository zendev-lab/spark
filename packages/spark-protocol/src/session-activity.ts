import type { SparkSessionActivityPhase } from "./host-events.ts";
import type { SparkSessionView } from "./protocol.ts";

export interface SparkPendingTurn {
  commandId: string;
  invocationId: string;
  prompt: string;
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
}

export interface SparkSessionActivityState {
  phase: SparkSessionActivityPhase;
  pendingTurns: SparkPendingTurn[];
  runningTurnId: string | null;
}

/**
 * Prefer daemon admission truth (`session.pendingTurns`) whenever a real
 * session snapshot is available. Surface projections are offline-only fallback
 * and must not invent queue rows while the daemon view is live.
 */
export function resolveSessionPendingTurns(
  projected: readonly SparkPendingTurn[],
  session: SparkSessionView | null,
): SparkPendingTurn[] {
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

export function sessionIsWorking(input: {
  registryStatus: string | null | undefined;
  liveStatus: string | null | undefined;
}): boolean {
  return (input.liveStatus ?? input.registryStatus) === "running";
}

export function sessionActivityNeedsStatusProbe(state: SparkSessionActivityState): boolean {
  return state.phase !== "idle";
}

/** One presentation boundary for daemon run truth used by spinner, Stop and queue UI. */
export function resolveSessionActivityState(input: {
  registryStatus?: string | null;
  session: SparkSessionView | null;
  projectedTurns: readonly SparkPendingTurn[];
  liveActiveTurnId?: string | null;
}): SparkSessionActivityState {
  const pendingTurns = resolveSessionPendingTurns(input.projectedTurns, input.session);
  const authoritativePendingTurns = input.session?.pendingTurns !== undefined;
  const runningTurnId =
    pendingTurns.find((turn) => turn.status === "running")?.invocationId ?? null;

  if (authoritativePendingTurns) {
    return {
      phase: runningTurnId
        ? "running"
        : pendingTurns.some((turn) => turn.status === "queued")
          ? "queued"
          : "idle",
      pendingTurns,
      runningTurnId,
    };
  }

  const working = sessionIsWorking({
    registryStatus: input.registryStatus,
    liveStatus: input.session?.status,
  });
  return {
    phase: working
      ? "running"
      : pendingTurns.some((turn) => turn.status === "queued")
        ? "queued"
        : "idle",
    pendingTurns,
    runningTurnId: working ? (runningTurnId ?? input.liveActiveTurnId ?? null) : null,
  };
}
