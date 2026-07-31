import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SessionRequestCompletionDeliveryRecord {
  sourceInvocationId: string;
  status: "pending" | "processing" | "delivered";
  attemptCount: number;
  lastError?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export class SessionRequestCompletionDeliveryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  enqueue(sourceInvocationId: string): SessionRequestCompletionDeliveryRecord {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO session_request_completion_deliveries
           (source_invocation_id, status, attempt_count, created_at, updated_at)
         VALUES (?, 'pending', 0, ?, ?)
         ON CONFLICT(source_invocation_id) DO NOTHING`,
      )
      .run(sourceInvocationId, now, now);
    return this.require(sourceInvocationId);
  }

  claimPending(limit = 50, leaseMs = 300_000): SessionRequestCompletionDeliveryRecord[] {
    const claimed: SessionRequestCompletionDeliveryRecord[] = [];
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    for (let index = 0; index < boundedLimit; index += 1) {
      const record = this.claimNext(leaseMs);
      if (!record) break;
      claimed.push(record);
    }
    return claimed;
  }

  claim(
    sourceInvocationId: string,
    leaseMs = 300_000,
  ): SessionRequestCompletionDeliveryRecord | undefined {
    return this.claimNext(leaseMs, sourceInvocationId);
  }

  recordFailure(
    sourceInvocationId: string,
    claimToken: string,
    error: string,
  ): SessionRequestCompletionDeliveryRecord {
    const result = this.db
      .prepare(
        `UPDATE session_request_completion_deliveries
         SET status = 'pending', attempt_count = attempt_count + 1,
             last_error = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
         WHERE source_invocation_id = ? AND status = 'processing' AND claim_token = ?`,
      )
      .run(error, this.now().toISOString(), sourceInvocationId, claimToken);
    if (result.changes !== 1) return this.require(sourceInvocationId);
    return this.require(sourceInvocationId);
  }

  markDelivered(
    sourceInvocationId: string,
    claimToken: string,
  ): SessionRequestCompletionDeliveryRecord {
    const now = this.now().toISOString();
    this.db
      .prepare(
        `UPDATE session_request_completion_deliveries
         SET status = 'delivered', attempt_count = attempt_count + 1,
             last_error = NULL, claim_token = NULL, claim_expires_at = NULL,
             updated_at = ?, delivered_at = ?
         WHERE source_invocation_id = ? AND status = 'processing' AND claim_token = ?`,
      )
      .run(now, now, sourceInvocationId, claimToken);
    return this.require(sourceInvocationId);
  }

  require(sourceInvocationId: string): SessionRequestCompletionDeliveryRecord {
    const row = this.db
      .prepare(
        `SELECT source_invocation_id AS sourceInvocationId, status,
                attempt_count AS attemptCount, last_error AS lastError,
                claim_token AS claimToken, claim_expires_at AS claimExpiresAt,
                created_at AS createdAt, updated_at AS updatedAt,
                delivered_at AS deliveredAt
         FROM session_request_completion_deliveries
         WHERE source_invocation_id = ?`,
      )
      .get(sourceInvocationId);
    if (!row) throw new Error(`unknown session request completion delivery: ${sourceInvocationId}`);
    return parseRecord(row);
  }

  private claimNext(
    leaseMs: number,
    sourceInvocationId?: string,
  ): SessionRequestCompletionDeliveryRecord | undefined {
    const now = this.now();
    const nowIso = now.toISOString();
    const claimToken = randomUUID();
    const claimExpiresAt = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString();
    const sourceFilter = sourceInvocationId ? "AND source_invocation_id = ?" : "";
    const parameters = sourceInvocationId
      ? [claimToken, claimExpiresAt, nowIso, nowIso, sourceInvocationId]
      : [claimToken, claimExpiresAt, nowIso, nowIso];
    const row = this.db
      .prepare(
        `UPDATE session_request_completion_deliveries
         SET status = 'processing', claim_token = ?, claim_expires_at = ?, updated_at = ?
         WHERE source_invocation_id = (
           SELECT source_invocation_id
           FROM session_request_completion_deliveries
           WHERE (status = 'pending' OR (status = 'processing' AND claim_expires_at <= ?))
             ${sourceFilter}
           ORDER BY created_at ASC, source_invocation_id ASC
           LIMIT 1
         )
         RETURNING source_invocation_id AS sourceInvocationId, status,
                   attempt_count AS attemptCount, last_error AS lastError,
                   claim_token AS claimToken, claim_expires_at AS claimExpiresAt,
                   created_at AS createdAt, updated_at AS updatedAt,
                   delivered_at AS deliveredAt`,
      )
      .get(...parameters);
    return row ? parseRecord(row) : undefined;
  }
}

function parseRecord(value: unknown): SessionRequestCompletionDeliveryRecord {
  const row = value as Record<string, unknown>;
  const status =
    row.status === "delivered"
      ? "delivered"
      : row.status === "processing"
        ? "processing"
        : "pending";
  return {
    sourceInvocationId: String(row.sourceInvocationId),
    status,
    attemptCount: Number(row.attemptCount),
    ...(typeof row.lastError === "string" ? { lastError: row.lastError } : {}),
    ...(typeof row.claimToken === "string" ? { claimToken: row.claimToken } : {}),
    ...(typeof row.claimExpiresAt === "string" ? { claimExpiresAt: row.claimExpiresAt } : {}),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    ...(typeof row.deliveredAt === "string" ? { deliveredAt: row.deliveredAt } : {}),
  };
}
