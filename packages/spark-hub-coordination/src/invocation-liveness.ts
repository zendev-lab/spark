import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import { appendEvent } from "./projection-services";

/** Absolute age after which a still-running mirrored invocation is marked lost. */
export const invocationStaleAfterMs = 35 * 60_000;
/** When the owning runtime is offline, mark running invocations lost sooner. */
export const invocationOfflineStaleAfterMs = 2 * 60_000;

export interface SweepStaleInvocationsOptions {
  now?: Date;
  staleAfterMs?: number;
  offlineStaleAfterMs?: number;
}

export interface SweepStaleInvocationsResult {
  lostInvocationIds: string[];
}

/** Mark stale daemon invocation projections lost so Hub does not spin forever. */
export function sweepStaleInvocations(
  db: DatabaseSync,
  options: SweepStaleInvocationsOptions = {},
): SweepStaleInvocationsResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const absoluteBefore = new Date(
    now.getTime() - (options.staleAfterMs ?? invocationStaleAfterMs),
  ).toISOString();
  const offlineBefore = new Date(
    now.getTime() - (options.offlineStaleAfterMs ?? invocationOfflineStaleAfterMs),
  ).toISOString();

  const staleRows = db
    .prepare(
      `SELECT mi.id,
              mi.runtime_invocation_id AS runtimeInvocationId,
              mi.runtime_workspace_binding_id AS runtimeWorkspaceBindingId,
              mi.workspace_id AS workspaceId,
              mi.project_id AS projectId,
              mi.command_id AS commandId,
              mi.task_runtime_id AS taskRuntimeId,
              mi.agent_name AS agentName,
              mi.status,
              mi.updated_at AS updatedAt,
              rc.status AS runtimeStatus
       FROM mirrored_invocations mi
       JOIN runtime_workspace_bindings rwb ON rwb.id = mi.runtime_workspace_binding_id
       JOIN runtime_connections rc ON rc.id = rwb.runtime_id
       WHERE mi.status IN ('queued', 'running')
         AND (
           mi.updated_at < ?
           OR (rc.status = 'offline' AND mi.updated_at < ?)
         )`,
    )
    .all(absoluteBefore, offlineBefore) as Array<{
    id: string;
    runtimeInvocationId: string;
    runtimeWorkspaceBindingId: string;
    workspaceId: string;
    projectId: string | null;
    commandId: string | null;
    taskRuntimeId: string | null;
    agentName: string | null;
    status: string;
    updatedAt: string;
    runtimeStatus: string;
  }>;

  if (staleRows.length === 0) return { lostInvocationIds: [] };

  db.exec("BEGIN");
  try {
    for (const row of staleRows) {
      const reason =
        row.runtimeStatus === "offline" ? "runtime_offline_stale" : "invocation_projection_stale";
      db.prepare(
        `UPDATE mirrored_invocations
         SET status = 'lost',
             completed_at = ?,
             terminal_reason = ?,
             updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(nowIso, reason, nowIso, row.id);

      db.prepare(
        `INSERT INTO invocation_events
          (id, invocation_id, runtime_event_id, kind, sequence, payload_json, created_at)
         VALUES (?, ?, NULL, 'invocation.lost', NULL, ?, ?)`,
      ).run(
        createId("evt"),
        row.id,
        JSON.stringify({ reason, previousStatus: row.status }),
        nowIso,
      );

      appendEvent(db, {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        actorKind: "server",
        actorId: row.runtimeWorkspaceBindingId,
        kind: "invocation.updated",
        subjectKind: "invocation",
        subjectId: row.runtimeInvocationId,
        payload: {
          runtimeInvocationId: row.runtimeInvocationId,
          status: "lost",
          completedAt: nowIso,
          terminalReason: reason,
          taskRuntimeId: row.taskRuntimeId,
          agentName: row.agentName,
          commandId: row.commandId,
        },
        createdAt: nowIso,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { lostInvocationIds: staleRows.map((row) => row.id) };
}
