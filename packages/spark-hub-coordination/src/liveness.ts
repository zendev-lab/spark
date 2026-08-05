import { appendEvent } from "./projection-services";
import type { DatabaseSync } from "node:sqlite";
import { sweepStaleInvocations } from "./invocation-liveness";
import type { SweepStaleInvocationsResult } from "./invocation-liveness";

export {
  invocationOfflineStaleAfterMs,
  invocationStaleAfterMs,
  sweepStaleInvocations,
} from "./invocation-liveness";
export type {
  SweepStaleInvocationsOptions,
  SweepStaleInvocationsResult,
} from "./invocation-liveness";

export const runtimeHeartbeatIntervalMs = 15_000;
export const runtimeStaleAfterMs = 45_000;
export interface SweepStaleRuntimeConnectionsOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface SweepStaleRuntimeConnectionsResult {
  staleRuntimeIds: string[];
  staleSessionCount: number;
}

export interface LivenessSweepSchedulerOptions {
  intervalMs?: number;
  now?: () => Date;
}

export interface LivenessSweepResult {
  runtimeConnections: SweepStaleRuntimeConnectionsResult;
  invocations: SweepStaleInvocationsResult;
}

/**
 * Own liveness maintenance once per server process instead of once per SSE
 * client. Event polling remains connection-local; only the mutating sweeps are
 * gated here.
 */
export function createLivenessSweepScheduler(
  options: LivenessSweepSchedulerOptions = {},
): (db: DatabaseSync) => LivenessSweepResult | null {
  const intervalMs = options.intervalMs ?? runtimeHeartbeatIntervalMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("liveness sweep interval must be a positive finite number");
  }
  let nextSweepAt = Number.NEGATIVE_INFINITY;

  return (db) => {
    const now = options.now?.() ?? new Date();
    if (now.getTime() < nextSweepAt) return null;
    nextSweepAt = now.getTime() + intervalMs;
    try {
      return {
        runtimeConnections: sweepStaleRuntimeConnections(db, { now }),
        invocations: sweepStaleInvocations(db, { now }),
      };
    } catch (error) {
      nextSweepAt = now.getTime();
      throw error;
    }
  };
}

export function sweepStaleRuntimeConnections(
  db: DatabaseSync,
  options: SweepStaleRuntimeConnectionsOptions = {},
): SweepStaleRuntimeConnectionsResult {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? runtimeStaleAfterMs;
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - staleAfterMs).toISOString();
  const staleRuntimes = db
    .prepare(
      `SELECT id, last_heartbeat_at AS lastHeartbeatAt
       FROM runtime_connections
       WHERE status = 'online'
         AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
    )
    .all(staleBefore) as Array<{ id: string; lastHeartbeatAt: string | null }>;

  if (staleRuntimes.length === 0) {
    return { staleRuntimeIds: [], staleSessionCount: 0 };
  }

  let staleSessionCount = 0;
  db.exec("BEGIN");
  try {
    for (const runtime of staleRuntimes) {
      db.prepare(
        "UPDATE runtime_connections SET status = 'offline', updated_at = ? WHERE id = ?",
      ).run(nowIso, runtime.id);

      const sessionUpdate = db
        .prepare(
          `UPDATE runtime_sessions
           SET status = 'stale', closed_at = ?, close_reason = 'heartbeat_stale'
           WHERE runtime_id = ? AND status = 'connected'`,
        )
        .run(nowIso, runtime.id);
      staleSessionCount += Number(sessionUpdate.changes ?? 0);

      appendEvent(db, {
        actorKind: "server",
        kind: "runtime.offline",
        subjectKind: "runtime",
        subjectId: runtime.id,
        payload: {
          reason: "heartbeat_stale",
          staleAfterMs,
          lastHeartbeatAt: runtime.lastHeartbeatAt,
        },
        createdAt: nowIso,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    staleRuntimeIds: staleRuntimes.map((runtime) => runtime.id),
    staleSessionCount,
  };
}
