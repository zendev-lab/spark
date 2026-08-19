import {
  SPARK_PROTOCOL_VERSION,
  isSparkInvocationTerminalStatus,
  sparkSessionInvocationReceiptSchema,
  type SparkModelRef,
  type SparkSessionInvocationReceipt,
  type SparkSessionLifetime,
  type SparkSessionOwner,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import { SparkDaemonControlError } from "../control-error.ts";
import { buildPendingDeliveriesQuery } from "./invocation-delivery-query.ts";

export const sparkInvocationStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type SparkInvocationStatus = (typeof sparkInvocationStatuses)[number];
export type SparkInvocationClaimClass = "root" | "structured";
export type SparkInvocationTerminalStatus = Extract<
  SparkInvocationStatus,
  "succeeded" | "failed" | "cancelled"
>;

export const SPARK_INVOCATION_INTERRUPTED_ERROR_CODE = "DAEMON_EXECUTION_INTERRUPTED";
export const SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE =
  "The daemon exited while this invocation was running. The successor daemon will resume this turn from persisted session state.";

export const SPARK_INVOCATION_RESUME_SOURCE_KIND = "invocation.resume";

export const LOOP_EXECUTION_SESSION_IDS_QUERY = `SELECT DISTINCT session_id
 FROM invocations
 WHERE session_id IS NOT NULL
   AND session_id <> ?
   AND payload_redacted_at IS NULL
   AND (
     source_kind = 'loop.tick'
     OR CASE
       WHEN json_valid(task_json)
         THEN json_extract(task_json, '$.type') = 'loop.tick'
       ELSE 0
     END
   )
   AND CASE
     WHEN json_valid(task_json) THEN COALESCE(
       json_extract(task_json, '$.ownerSessionId'),
       json_extract(task_json, '$.stateOwnerSessionId')
     )
   END = ?
 ORDER BY session_id`;

function unacknowledgedDeliveryExistsSql(
  invocationAlias: string,
  invocationIdSql: string,
  cursorSql: string,
): string {
  return `(
    EXISTS (
      SELECT 1
      FROM daemon_server_credentials route_credentials
      JOIN daemon_workspaces route_workspace
        ON route_workspace.server_id = route_credentials.server_id
      LEFT JOIN invocation_event_deliveries route_delivery
        ON route_delivery.destination = 'hub:' || route_credentials.runtime_id
       AND route_delivery.invocation_id = ${invocationIdSql}
      WHERE NOT EXISTS (
        SELECT 1
        FROM workspace_lifecycle route_lifecycle
        WHERE route_lifecycle.workspace_id = route_workspace.id
      )
        AND (
        ${invocationAlias}.workspace_binding_id = route_workspace.id
        OR ${invocationAlias}.workspace_binding_id = route_workspace.server_binding_id
        OR (
          ${invocationAlias}.workspace_binding_id IS NULL
          AND route_workspace.server_workspace_id = CASE
            WHEN json_valid(${invocationAlias}.task_json)
              THEN json_extract(${invocationAlias}.task_json, '$.workspaceId')
          END
          AND (
            SELECT COUNT(*)
            FROM daemon_workspaces unique_route_workspace
            WHERE unique_route_workspace.server_workspace_id = CASE
              WHEN json_valid(${invocationAlias}.task_json)
                THEN json_extract(${invocationAlias}.task_json, '$.workspaceId')
            END
              AND NOT EXISTS (
                SELECT 1
                FROM workspace_lifecycle unique_route_lifecycle
                WHERE unique_route_lifecycle.workspace_id = unique_route_workspace.id
              )
          ) = 1
        )
      )
        AND COALESCE(route_delivery.sequence, 0) < ${cursorSql}
    )
    OR EXISTS (
      SELECT 1
      FROM invocation_event_delivery_consumers known
      LEFT JOIN invocation_event_deliveries known_delivery
        ON known_delivery.destination = known.destination
       AND known_delivery.invocation_id = ${invocationIdSql}
      WHERE (
        substr(known.destination, 1, 4) <> 'hub:'
        OR NOT EXISTS (SELECT 1 FROM daemon_server_credentials)
      )
        AND COALESCE(known_delivery.sequence, 0) < ${cursorSql}
    )
  )`;
}

const LATEST_INVOCATION_EVENT_SEQUENCE_SQL = `COALESCE((
  SELECT MAX(latest.sequence)
  FROM invocation_events latest
  WHERE latest.invocation_id = i.id
), 0)`;

export interface SparkInvocationRecord {
  invocationId: string;
  commandId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  status: SparkInvocationStatus;
  prompt?: string;
  task?: unknown;
  result?: unknown;
  sourceKind?: string;
  sourceRef?: string;
  parentInvocationId?: string;
  retryOfInvocationId?: string;
  claimClass: SparkInvocationClaimClass;
  executionProfile?: Record<string, unknown>;
  retentionSummary?: Record<string, unknown>;
  payloadRedactedAt?: string;
  workerId?: string;
  attemptCount: number;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SparkInvocationEvent {
  invocationId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SparkInvocationEventPage {
  invocationId: string;
  events: SparkInvocationEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface SparkInvocationListInput {
  status?: SparkInvocationStatus;
  /** Terminal-only convenience filter; `status` takes precedence when both are set. */
  terminalOnly?: boolean;
  sessionId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface SparkInvocationListPage {
  invocations: SparkInvocationRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface SparkInvocationSummaryRecord {
  invocationId: string;
  sessionId?: string;
  retryOfInvocationId?: string;
  status: SparkInvocationStatus;
  attemptCount: number;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  eventCursor: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SparkInvocationSummaryPage {
  invocations: SparkInvocationSummaryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface SparkInvocationSessionActivity {
  active: boolean;
  activity: "idle" | "queued" | "running";
  updatedAt?: string;
}

export interface SparkInvocationRetryTarget {
  invocationId: string;
  failedAt: string;
}

export interface SparkInvocationReceiptContext {
  lifetime: SparkSessionLifetime;
  ownerKind: SparkSessionOwner["kind"];
  effectiveRoleRef?: string;
  effectiveRoleRevision?: string;
  model?: SparkModelRef;
  thinkingLevel?: SparkThinkingLevel;
  toolPolicyDigest?: string;
  authorizationSource: {
    kind: string;
    ref?: string;
  };
  inputRefs?: string[];
  outputRefs?: string[];
}

export interface SparkInvocationRetentionPreview {
  before: string;
  invocationIds: string[];
  eventCount: number;
  blockedByDeliveryCount: number;
}

export interface SparkInvocationRetentionApplyInput {
  invocationLimit?: number;
  eventLimit?: number;
  now?: string;
}

export interface SparkInvocationRetentionApplyResult {
  before: string;
  touchedInvocationIds: string[];
  retainedInvocationIds: string[];
  deletedEventCount: number;
  retainedInvocationCount: number;
  clearedResultCount: number;
  blockedByDeliveryCount: number;
  hasMore: boolean;
}

export interface SparkInvocationPendingDelivery {
  invocation: SparkInvocationRecord;
  event: SparkInvocationEvent;
}

export interface SparkInvocationPendingDeliveryPage {
  deliveries: SparkInvocationDeliveryPageItem[];
  hasMore: boolean;
}

export interface SparkInvocationDeliveryPageItem {
  event: SparkInvocationEvent;
  /** Authoritative daemon-local binding selected for this Hub connection. */
  workspaceBindingId?: string;
}

export interface SubmitSparkInvocationInput {
  invocationId?: string;
  commandId?: string;
  workspaceBindingId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  prompt?: string;
  task?: unknown;
  sourceKind?: string;
  sourceRef?: string;
  parentInvocationId?: string;
  retryOfInvocationId?: string;
  claimClass?: SparkInvocationClaimClass;
  now?: string;
}

export interface ImportSparkInvocationInput extends SubmitSparkInvocationInput {
  invocationId: string;
  status: SparkInvocationStatus;
  result?: unknown;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface CompleteSparkInvocationInput {
  status: SparkInvocationTerminalStatus;
  cancelReason?: string;
  errorCode?: string;
  errorMessage?: string;
  result?: unknown;
  executionProfile?: Record<string, unknown>;
  retentionSummary?: Record<string, unknown>;
  now?: string;
}

export interface SparkInvocationPayloadRedactionResult {
  sessionId: string;
  redactedInvocationIds: string[];
  deletedEventCount: number;
  blockedInvocationIds: string[];
  redactedAt: string;
}

const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_INVOCATION_EVENT_PAGE_LIMIT = 500;
export const MAX_INVOCATION_DELIVERY_PAGE_LIMIT = 256;
export const MAX_PERSISTED_INVOCATION_RESULT_BYTES = 512 * 1024;
export const MAX_PERSISTED_INVOCATION_EVENT_BYTES = 256 * 1024;
const MAX_PERSISTED_EVENT_SESSION_ID_BYTES = 4 * 1024;
const MAX_PERSISTED_RESULT_STRING_BYTES = 384 * 1024;
const MAX_PERSISTED_RESULT_ARRAY_ITEMS = 64;
const MAX_PERSISTED_RESULT_OBJECT_KEYS = 128;
const MAX_PERSISTED_RETENTION_SUMMARY_BYTES = 16 * 1024;
const MAX_PERSISTED_EXECUTION_PROFILE_BYTES = 16 * 1024;

const allowedTransitions: Record<SparkInvocationStatus, readonly SparkInvocationStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

interface InvocationRow {
  id: string;
  command_id: string | null;
  workspace_binding_id: string | null;
  session_id: string | null;
  idempotency_key: string | null;
  status: string;
  prompt: string | null;
  task_json: string | null;
  result_json: string | null;
  result_json_bytes: number;
  source_kind: string | null;
  source_ref: string | null;
  parent_invocation_id: string | null;
  retry_of_invocation_id: string | null;
  claim_class: string;
  execution_profile_json: string | null;
  retention_summary_json: string | null;
  payload_redacted_at: string | null;
  worker_id: string | null;
  attempt_count: number;
  cancel_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface InvocationSummaryRow {
  id: string;
  session_id: string | null;
  retry_of_invocation_id: string | null;
  status: string;
  attempt_count: number;
  cancel_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  event_cursor: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface InvocationRetryTargetRow {
  id: string;
  status: string;
  error_code: string | null;
  source_kind: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface InvocationEventRow {
  invocation_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: string;
}

interface PendingDeliveryRow extends InvocationRow {
  event_invocation_id: string;
  event_sequence: number;
  event_kind: string;
  event_payload_json: string;
  event_created_at: string;
}

interface DeliveryCandidateRow {
  invocation_id: string;
  workspace_binding_id: string | null;
  delivery_sequence: number;
  event_cursor: number;
  status: string;
  legacy_projection: number;
  legacy_workspace_id: string | null;
}

interface DeliveryHeadCandidateRow extends DeliveryCandidateRow {
  head_sequence: number;
  head_created_at: string;
}

interface DeliveryHeadRow {
  sequence: number;
  created_at: string;
}

interface DeliveryHead {
  invocationId: string;
  workspaceBindingId?: string;
  sequence: number;
  createdAt: string;
  orderAt: string;
  legacyTerminal: boolean;
  legacyFixedSequence?: number;
}

interface LegacyTerminalDeliveryRow {
  id: string;
  session_id: string | null;
  status: string;
  task_json: string | null;
  source_kind: string | null;
  cancel_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
  finished_at: string | null;
}

class DeliveryHeadHeap {
  readonly #items: DeliveryHead[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(value: DeliveryHead): void {
    this.#items.push(value);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.#items[parent];
      if (!parentValue || compareDeliveryHeads(parentValue, value) <= 0) break;
      this.#items[index] = parentValue;
      index = parent;
    }
    this.#items[index] = value;
  }

  pop(): DeliveryHead | undefined {
    const first = this.#items[0];
    const last = this.#items.pop();
    if (!first || !last || this.#items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#items.length) break;
      const leftValue = this.#items[left];
      const rightValue = this.#items[right];
      if (!leftValue) break;
      const child = rightValue && compareDeliveryHeads(rightValue, leftValue) < 0 ? right : left;
      const childValue = this.#items[child];
      if (!childValue || compareDeliveryHeads(last, childValue) <= 0) break;
      this.#items[index] = childValue;
      index = child;
    }
    this.#items[index] = last;
    return first;
  }
}

function compareDeliveryHeads(left: DeliveryHead, right: DeliveryHead): number {
  return (
    left.orderAt.localeCompare(right.orderAt) ||
    left.invocationId.localeCompare(right.invocationId) ||
    left.sequence - right.sequence
  );
}

export class SparkInvocationStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  submit(input: SubmitSparkInvocationInput): SparkInvocationRecord {
    const now = input.now ?? new Date().toISOString();
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) {
        assertIdempotentSubmission(existing, input);
        return existing;
      }
    }

    const invocationId = input.invocationId ?? `inv_${randomUUID().replaceAll("-", "")}`;
    try {
      this.db
        .prepare(
          `INSERT INTO invocations
            (id, command_id, workspace_binding_id, session_id, idempotency_key, status, prompt,
             task_json, source_kind, source_ref, parent_invocation_id, retry_of_invocation_id,
             claim_class, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invocationId,
          input.commandId ?? null,
          input.workspaceBindingId ?? null,
          input.sessionId ?? null,
          input.idempotencyKey ?? null,
          input.prompt ?? null,
          serializeJson(input.task),
          input.sourceKind ?? null,
          input.sourceRef ?? null,
          input.parentInvocationId ?? null,
          input.retryOfInvocationId ?? null,
          input.claimClass ?? "root",
          now,
          now,
        );
    } catch (error) {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertIdempotentSubmission(existing, input);
          return existing;
        }
      }
      throw error;
    }
    return this.require(invocationId);
  }

  submitIfSessionIdle(input: SubmitSparkInvocationInput): SparkInvocationRecord {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new SparkDaemonControlError(
        "session_not_idle",
        "SESSION_NOT_IDLE: idle admission requires sessionId",
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const existing = this.findByIdempotencyKey(input.idempotencyKey);
        if (existing) {
          assertIdempotentSubmission(existing, input);
          this.db.exec("COMMIT");
          return existing;
        }
      }
      const pending = this.db
        .prepare(
          `SELECT id
           FROM invocations
           WHERE session_id = ? AND status IN ('queued', 'running')
           LIMIT 1`,
        )
        .get(sessionId) as { id: string } | undefined;
      if (pending) {
        throw new SparkDaemonControlError(
          "session_not_idle",
          `SESSION_NOT_IDLE: session ${sessionId} already has pending invocation ${pending.id}`,
        );
      }
      const invocation = this.submit({ ...input, sessionId });
      this.db.exec("COMMIT");
      return invocation;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  importRecord(input: ImportSparkInvocationInput): SparkInvocationRecord {
    if (input.idempotencyKey) {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;
    }
    this.db
      .prepare(
        `INSERT INTO invocations
          (id, command_id, workspace_binding_id, session_id, idempotency_key, status, prompt,
           task_json, result_json, source_kind, source_ref, parent_invocation_id,
           retry_of_invocation_id, claim_class, execution_profile_json, retention_summary_json,
           payload_redacted_at, worker_id,
           attempt_count, cancel_reason, error_code, error_message, created_at, updated_at,
           claimed_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        input.invocationId,
        input.commandId ?? null,
        input.workspaceBindingId ?? null,
        input.sessionId ?? null,
        input.idempotencyKey ?? null,
        input.status,
        input.prompt ?? null,
        serializeJson(input.task),
        serializeJson(compactInvocationResult(input.result)),
        input.sourceKind ?? null,
        input.sourceRef ?? null,
        input.parentInvocationId ?? null,
        input.retryOfInvocationId ?? null,
        input.claimClass ?? "root",
        input.status === "queued" ? 0 : 1,
        input.cancelReason ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.createdAt,
        input.updatedAt,
        input.startedAt ?? null,
        input.finishedAt ?? null,
      );
    return this.require(input.invocationId);
  }

  get(invocationId: string): SparkInvocationRecord | undefined {
    const row = this.db.prepare(`${invocationSelect} WHERE id = ?`).get(invocationId) as
      | InvocationRow
      | undefined;
    return row ? invocationRecord(row) : undefined;
  }

  getSummary(invocationId: string): SparkInvocationSummaryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, retry_of_invocation_id, status, attempt_count,
                cancel_reason, error_code, error_message, event_cursor, created_at, updated_at,
                started_at, finished_at
         FROM invocations
         WHERE id = ?`,
      )
      .get(invocationId) as InvocationSummaryRow | undefined;
    return row ? invocationSummaryRecord(row) : undefined;
  }

  require(invocationId: string): SparkInvocationRecord {
    const record = this.get(invocationId);
    if (!record) {
      throw new SparkDaemonControlError(
        "invocation_not_found",
        `Unknown Spark invocation: ${invocationId}`,
      );
    }
    return record;
  }

  counts(): Record<SparkInvocationStatus, number> {
    const counts = Object.fromEntries(
      sparkInvocationStatuses.map((status) => [status, 0]),
    ) as Record<SparkInvocationStatus, number>;
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM invocations GROUP BY status")
      .all() as unknown as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if (isInvocationStatus(row.status)) counts[row.status] = Number(row.count);
    }
    return counts;
  }

  list(limit = 100): SparkInvocationRecord[] {
    return this.listPage({ limit: Math.max(1, Math.floor(limit)) }).invocations;
  }

  listPage(input: SparkInvocationListInput = {}): SparkInvocationListPage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.status) {
      conditions.push("status = ?");
      values.push(input.status);
    } else if (input.terminalOnly) {
      conditions.push("status NOT IN ('queued', 'running')");
    }
    if (input.sessionId?.trim()) {
      conditions.push("session_id = ?");
      values.push(input.sessionId.trim());
    }
    if (input.since) {
      conditions.push("created_at >= ?");
      values.push(input.since);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM invocations${where}`)
      .get(...values) as { count: number };
    const rows = this.db
      .prepare(`${invocationSelect}${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as InvocationRow[];
    return {
      invocations: rows.map(invocationRecord),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  listSummaryPage(input: SparkInvocationListInput = {}): SparkInvocationSummaryPage {
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const { where, values } = invocationListFilter(input, "i");
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM invocations i${where}`)
      .get(...values) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT i.id,
                i.session_id,
                i.retry_of_invocation_id,
                i.status,
                i.attempt_count,
                i.cancel_reason,
                i.error_code,
                i.error_message,
                i.event_cursor,
                i.created_at,
                i.updated_at,
                i.started_at,
                i.finished_at
         FROM invocations i${where}
         ORDER BY i.created_at DESC, i.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as unknown as InvocationSummaryRow[];
    return {
      invocations: rows.map(invocationSummaryRecord),
      total: Number(totalRow.count),
      limit,
      offset,
    };
  }

  pendingSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id
         FROM invocations
         WHERE session_id IS NOT NULL AND status IN ('queued', 'running')`,
      )
      .all() as unknown as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  }

  runningSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_id
         FROM invocations
         WHERE session_id IS NOT NULL AND status = 'running'`,
      )
      .all() as unknown as Array<{ session_id: string }>;
    return new Set(rows.map((row) => row.session_id));
  }

  /** Hydration hot path: filter in SQLite so terminal result payloads are never materialized. */
  listPendingForSession(sessionId: string): SparkInvocationRecord[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return [];
    return (
      this.db
        .prepare(
          `${invocationSelect}
           WHERE session_id = ? AND status IN ('queued', 'running')
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(normalizedSessionId) as unknown as InvocationRow[]
    ).map(invocationRecord);
  }

  latestTuiUserRetryTargetForSession(sessionId: string): SparkInvocationRetryTarget | undefined {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return undefined;
    const row = this.db
      .prepare(
        `SELECT id, status, error_code, source_kind, finished_at, updated_at
         FROM invocations
         WHERE session_id = ?
           AND json_extract(task_json, '$.type') = 'session.run'
           AND json_extract(task_json, '$.messageMetadata.origin.kind') = 'user'
           AND json_extract(task_json, '$.messageMetadata.origin.host') = 'tui'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(normalizedSessionId) as InvocationRetryTargetRow | undefined;
    if (!row) return undefined;
    if (!isInvocationStatus(row.status))
      throw new Error(`Invalid invocation status: ${row.status}`);
    const invocation = {
      status: row.status,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
      hasObjectTask: true,
      taskType: "session.run",
    };
    return isExplicitlyRetryableInvocationState(invocation)
      ? { invocationId: row.id, failedAt: row.finished_at ?? row.updated_at }
      : undefined;
  }

  /**
   * Find every unredacted synthetic execution Session ever materialized for
   * one durable Loop owner. Loop restart clears its current last-invocation
   * pointer, so close cleanup must query the durable Invocation history.
   */
  listLoopExecutionSessionIds(ownerSessionId: string): string[] {
    const normalizedOwnerSessionId = ownerSessionId.trim();
    if (!normalizedOwnerSessionId) return [];
    const rows = this.db
      .prepare(LOOP_EXECUTION_SESSION_IDS_QUERY)
      .all(normalizedOwnerSessionId, normalizedOwnerSessionId) as unknown as Array<{
      session_id: string;
    }>;
    return rows.map((row) => row.session_id);
  }

  /**
   * Return the durable execution state for one session without hydrating task
   * or result payloads. Session registry status is only a convenience mirror;
   * SQLite invocations are the execution source of truth.
   */
  sessionActivity(sessionId: string): SparkInvocationSessionActivity {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return { active: false, activity: "idle" };
    return (
      this.sessionActivities([normalizedSessionId]).get(normalizedSessionId) ?? {
        active: false,
        activity: "idle",
      }
    );
  }

  /** Resolve a session list in one query. The two existing covering indexes
   * keep active-state and latest-update lookups independent of history size. */
  sessionActivities(sessionIds: string[]): Map<string, SparkInvocationSessionActivity> {
    const normalizedSessionIds = [
      ...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
    ];
    if (normalizedSessionIds.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `WITH requested_sessions(session_id) AS (
           SELECT DISTINCT CAST(value AS TEXT)
             FROM json_each(?)
         )
         SELECT requested_sessions.session_id,
                EXISTS(
                  SELECT 1
                    FROM invocations active_invocation
                   WHERE active_invocation.session_id = requested_sessions.session_id
                     AND active_invocation.status IN ('queued', 'running')
                ) AS active,
                (
                  SELECT active_status.status
                    FROM invocations active_status
                   WHERE active_status.session_id = requested_sessions.session_id
                     AND active_status.status IN ('queued', 'running')
                   ORDER BY CASE active_status.status WHEN 'running' THEN 0 ELSE 1 END,
                            active_status.updated_at DESC
                   LIMIT 1
                ) AS activity,
                (
                  SELECT latest_invocation.updated_at
                    FROM invocations latest_invocation
                   WHERE latest_invocation.session_id = requested_sessions.session_id
                   ORDER BY latest_invocation.updated_at DESC
                   LIMIT 1
                ) AS updated_at
           FROM requested_sessions`,
      )
      .all(JSON.stringify(normalizedSessionIds)) as unknown as Array<{
      active: number;
      activity: "queued" | "running" | null;
      session_id: string;
      updated_at: string | null;
    }>;
    return new Map(
      rows.map((row) => [
        row.session_id,
        {
          active: row.active === 1,
          activity: row.activity ?? "idle",
          ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
        },
      ]),
    );
  }

  findByIdempotencyKey(idempotencyKey: string): SparkInvocationRecord | undefined {
    const row = this.db
      .prepare(`${invocationSelect} WHERE idempotency_key = ?`)
      .get(idempotencyKey) as InvocationRow | undefined;
    return row ? invocationRecord(row) : undefined;
  }

  claimNext(
    workerId: string,
    now = new Date().toISOString(),
    blockedSessionIds: readonly string[] = [],
    options: { sourceKind?: string } = {},
  ): SparkInvocationRecord | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const blockedClause = blockedSessionIds.length
        ? `AND (session_id IS NULL OR session_id NOT IN (${blockedSessionIds.map(() => "?").join(", ")}))`
        : "";
      const sourceClause = options.sourceKind ? "AND source_kind = ?" : "";
      const candidate = this.db
        .prepare(
          `${invocationSelect}
           WHERE status = 'queued'
             AND claim_class = 'root'
             ${sourceClause}
             AND (
               session_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM invocations active
                 WHERE active.session_id = invocations.session_id
                   AND active.status = 'running'
               )
             )
             ${blockedClause}
           ORDER BY CASE WHEN source_kind = 'session.question' THEN 0 ELSE 1 END,
                    created_at, rowid
           LIMIT 1`,
        )
        .get(...(options.sourceKind ? [options.sourceKind] : []), ...blockedSessionIds) as
        | InvocationRow
        | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const changes = Number(
        this.db
          .prepare(
            `UPDATE invocations
             SET status = 'running', worker_id = ?, attempt_count = attempt_count + 1,
                 claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ? AND status = 'queued'`,
          )
          .run(workerId, now, now, now, candidate.id).changes,
      );
      if (changes !== 1) throw new Error(`Invocation claim conflict: ${candidate.id}`);
      this.db.exec("COMMIT");
      return this.require(candidate.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Claim a child invocation for in-stack execution without consuming a root worker slot. */
  claimStructured(
    invocationId: string,
    workerId: string,
    now = new Date().toISOString(),
  ): SparkInvocationRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(invocationId);
      if (current.claimClass !== "structured" || !current.parentInvocationId) {
        throw new Error(`Invocation ${invocationId} is not a structured child`);
      }
      const parent = this.getSummary(current.parentInvocationId);
      if (!parent || parent.status !== "running") {
        throw new Error(
          `Structured invocation ${invocationId} requires running parent ${current.parentInvocationId}`,
        );
      }
      const changes = Number(
        this.db
          .prepare(
            `UPDATE invocations
             SET status = 'running', worker_id = ?, attempt_count = attempt_count + 1,
                 claimed_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE id = ? AND status = 'queued' AND claim_class = 'structured'`,
          )
          .run(workerId, now, now, now, invocationId).changes,
      );
      if (changes !== 1) throw new Error(`Invocation structured claim conflict: ${invocationId}`);
      this.db.exec("COMMIT");
      return this.require(invocationId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(
    invocationId: string,
    reason: string,
    now = new Date().toISOString(),
  ): "cancelled" | "requested" | "terminal" | "not-found" {
    const current = this.getSummary(invocationId);
    if (!current) return "not-found";
    if (this.hasDurableCommitStarted(invocationId)) return "terminal";
    if (current.status === "queued") {
      this.complete(invocationId, { status: "cancelled", cancelReason: reason, now });
      return "cancelled";
    }
    if (current.status !== "running") return "terminal";
    this.db
      .prepare(
        `UPDATE invocations
         SET cancel_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(reason, now, invocationId);
    return "requested";
  }

  markDurableCommitStarted(
    invocationId: string,
    now = new Date().toISOString(),
  ): SparkInvocationEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(invocationId);
      if (current.status !== "running") {
        throw new Error(`Invocation durable commit conflict: ${invocationId} is ${current.status}`);
      }
      if (current.cancelReason) {
        throw new Error(`Invocation cancellation already requested: ${current.cancelReason}`);
      }
      const existing = this.previousEvent(
        invocationId,
        Number.MAX_SAFE_INTEGER,
        "invocation.durable_commit_started",
      );
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      const event = this.appendEventInTransaction(
        invocationId,
        "invocation.durable_commit_started",
        { phase: "transcript_replace" },
        now,
      );
      this.db.exec("COMMIT");
      return { ...event, payload: { phase: "transcript_replace" } };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasDurableCommitStarted(invocationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM invocation_events
           WHERE invocation_id = ? AND kind = 'invocation.durable_commit_started'
           LIMIT 1`,
        )
        .get(invocationId),
    );
  }

  failInterruptedRunning(now = new Date().toISOString()): number {
    return Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(
          SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
          SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
          now,
          now,
        ).changes,
    );
  }

  /**
   * Requeue a crashed `running` invocation so the successor daemon can resume
   * the same turn against persisted session state.
   */
  requeueForResume(invocationId: string, now = new Date().toISOString()): SparkInvocationRecord {
    const current = this.require(invocationId);
    if (current.status !== "running") {
      throw new Error(`Invocation resume conflict: ${invocationId} is ${current.status}`);
    }
    assertTransition(current.status, "queued");
    const nextTask = markTaskForResume(current.task);
    const changes = Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = 'queued',
               worker_id = NULL,
               claimed_at = NULL,
               started_at = NULL,
               finished_at = NULL,
               cancel_reason = NULL,
               error_code = NULL,
               error_message = NULL,
               result_json = NULL,
               source_kind = ?,
               task_json = ?,
               updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          SPARK_INVOCATION_RESUME_SOURCE_KIND,
          nextTask === undefined ? null : JSON.stringify(nextTask),
          now,
          invocationId,
        ).changes,
    );
    if (changes !== 1) throw new Error(`Invocation resume conflict: ${invocationId}`);
    this.appendEvent(
      invocationId,
      "invocation.resume_queued",
      {
        reason: SPARK_INVOCATION_INTERRUPTED_ERROR_CODE,
        message: SPARK_INVOCATION_INTERRUPTED_ERROR_MESSAGE,
      },
      now,
    );
    return this.require(invocationId);
  }

  /**
   * Atomically hand a running invocation to the restart successor before any
   * pending assistant tool call is dispatched.
   */
  requeueAtRestartCheckpoint(
    invocationId: string,
    checkpoint: SparkTurnResumeCheckpoint,
    now = new Date().toISOString(),
  ): SparkInvocationRecord {
    if (!isSparkTurnResumeCheckpointPersistable(checkpoint)) {
      throw new Error("Invocation restart checkpoint is not safe for durable storage");
    }
    const current = this.require(invocationId);
    if (current.status !== "running") {
      throw new Error(
        `Invocation restart checkpoint conflict: ${invocationId} is ${current.status}`,
      );
    }
    assertTransition(current.status, "queued");
    const nextTask = markTaskForRestartCheckpoint(current.task, checkpoint);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = Number(
        this.db
          .prepare(
            `UPDATE invocations
             SET status = 'queued',
                 worker_id = NULL,
                 claimed_at = NULL,
                 started_at = NULL,
                 finished_at = NULL,
                 cancel_reason = NULL,
                 error_code = NULL,
                 error_message = NULL,
                 result_json = NULL,
                 source_kind = ?,
                 task_json = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(SPARK_INVOCATION_RESUME_SOURCE_KIND, JSON.stringify(nextTask), now, invocationId)
          .changes,
      );
      if (changes !== 1) {
        throw new Error(`Invocation restart checkpoint conflict: ${invocationId}`);
      }
      this.appendEventInTransaction(
        invocationId,
        "invocation.restart_checkpoint_queued",
        {
          phase: checkpoint.phase,
          checkpointVersion: checkpoint.version,
          pendingToolCallCount: checkpoint.toolCalls.length,
        },
        now,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.require(invocationId);
  }

  hasRestartCheckpoint(invocationId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM invocation_events
           WHERE invocation_id = ? AND kind = 'invocation.restart_checkpoint_queued'
           LIMIT 1`,
        )
        .get(invocationId),
    );
  }

  complete(invocationId: string, input: CompleteSparkInvocationInput): SparkInvocationRecord {
    const row = this.db
      .prepare(`SELECT ${invocationSelectColumns(undefined, false)} FROM invocations WHERE id = ?`)
      .get(invocationId) as InvocationRow | undefined;
    if (!row) {
      throw new SparkDaemonControlError(
        "invocation_not_found",
        `Unknown Spark invocation: ${invocationId}`,
      );
    }
    const current = invocationRecord(row);
    assertTransition(current.status, input.status);
    const now = input.now ?? new Date().toISOString();
    const result = compactInvocationResult(input.result);
    const executionProfile =
      input.executionProfile ??
      ({
        claimClass: current.claimClass,
        ...(current.sourceKind ? { sourceKind: current.sourceKind } : {}),
        status: input.status,
        attemptCount: current.attemptCount,
        startedAt: current.startedAt ?? now,
        finishedAt: now,
      } satisfies Record<string, unknown>);
    const changes = Number(
      this.db
        .prepare(
          `UPDATE invocations
           SET status = ?, cancel_reason = ?, error_code = ?, error_message = ?, result_json = ?,
               execution_profile_json = ?, retention_summary_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          input.status,
          input.cancelReason ?? null,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          serializePersistedResult(result),
          serializeBoundedRecord(executionProfile, MAX_PERSISTED_EXECUTION_PROFILE_BYTES),
          serializeBoundedRecord(input.retentionSummary, MAX_PERSISTED_RETENTION_SUMMARY_BYTES),
          now,
          now,
          invocationId,
          current.status,
        ).changes,
    );
    if (changes !== 1) throw new Error(`Invocation transition conflict: ${invocationId}`);
    return completedInvocationRecord(current, { ...input, executionProfile }, result, now);
  }

  appendEvent(
    invocationId: string,
    kind: string,
    payload: Record<string, unknown>,
    now = new Date().toISOString(),
  ): SparkInvocationEvent {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const event = this.appendEventInTransaction(invocationId, kind, payload, now);
      if (ownsTransaction) this.db.exec("COMMIT");
      return { ...event, payload };
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Persist the execution profile frozen at Invocation start. Terminal state,
   * errors, timings, and output refs remain sourced from the Invocation row. */
  recordReceiptContext(
    invocationId: string,
    context: SparkInvocationReceiptContext,
    now = new Date().toISOString(),
  ): SparkSessionInvocationReceipt {
    const invocation = this.require(invocationId);
    if (!invocation.sessionId) {
      throw new Error(`Invocation receipt requires a Session: ${invocationId}`);
    }
    this.appendEvent(invocationId, "invocation.receipt_context", { ...context }, now);
    return this.invocationReceipt(invocationId);
  }

  invocationReceipt(invocationId: string): SparkSessionInvocationReceipt {
    const invocation = this.require(invocationId);
    if (!invocation.sessionId) {
      throw new Error(`Invocation receipt requires a Session: ${invocationId}`);
    }
    const row = this.db
      .prepare(
        `SELECT payload_json
         FROM invocation_events
         WHERE invocation_id = ? AND kind = 'invocation.receipt_context'
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(invocationId) as { payload_json: string } | undefined;
    if (!row) throw new Error(`Invocation receipt context is missing: ${invocationId}`);
    const context = parseJson(row.payload_json) as SparkInvocationReceiptContext;
    return sparkSessionInvocationReceiptSchema.parse({
      invocationId,
      sessionId: invocation.sessionId,
      lifetime: context.lifetime,
      ownerKind: context.ownerKind,
      effectiveRoleRef: context.effectiveRoleRef,
      effectiveRoleRevision: context.effectiveRoleRevision,
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      toolPolicyDigest: context.toolPolicyDigest,
      authorizationSource: context.authorizationSource,
      inputRefs: context.inputRefs ?? [],
      outputRefs: context.outputRefs ?? invocationOutputRefs(invocation.result),
      status: invocation.status,
      errorCode: invocation.errorCode,
      errorMessage: invocation.errorMessage,
      createdAt: invocation.createdAt,
      startedAt: invocation.startedAt,
      finishedAt: invocation.finishedAt,
    });
  }

  private appendEventInTransaction(
    invocationId: string,
    kind: string,
    payload: Record<string, unknown>,
    now: string,
  ): SparkInvocationEvent {
    const cursor = this.db
      .prepare(
        `UPDATE invocations
         SET event_cursor = event_cursor + 1,
             updated_at = ?
         WHERE id = ?
         RETURNING event_cursor AS sequence`,
      )
      .get(now, invocationId) as { sequence: number } | undefined;
    if (!cursor) {
      throw new SparkDaemonControlError(
        "invocation_not_found",
        `Unknown Spark invocation: ${invocationId}`,
      );
    }
    const sequence = Number(cursor.sequence);
    const persistedPayload = persistedInvocationEventPayload(invocationId, sequence, kind, payload);
    this.db
      .prepare(
        `INSERT INTO invocation_events
          (invocation_id, sequence, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(invocationId, sequence, kind, JSON.stringify(persistedPayload), now);
    return { invocationId, sequence, kind, payload: persistedPayload, createdAt: now };
  }

  previousEvent(
    invocationId: string,
    beforeSequence: number,
    kind?: string,
  ): SparkInvocationEvent | undefined {
    this.require(invocationId);
    return this.previousKnownEvent(invocationId, beforeSequence, kind);
  }

  /** Trusted cursor lookup for an invocation event already read from durable storage. */
  previousKnownEvent(
    invocationId: string,
    beforeSequence: number,
    kind?: string,
  ): SparkInvocationEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT invocation_id, sequence, kind, payload_json, created_at
         FROM invocation_events
         WHERE invocation_id = ? AND sequence < ?
           AND (? IS NULL OR kind = ?)
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(invocationId, beforeSequence, kind ?? null, kind ?? null) as
      | InvocationEventRow
      | undefined;
    return row ? invocationEvent(row) : undefined;
  }

  invocationDeliveryBinding(invocationId: string): string | null | undefined {
    const row = this.db
      .prepare(`SELECT workspace_binding_id FROM invocations WHERE id = ?`)
      .get(invocationId) as { workspace_binding_id: string | null } | undefined;
    return row?.workspace_binding_id;
  }

  pendingDeliveries(
    destination: string,
    limit = 500,
    workspaceBindingIds?: readonly string[],
  ): SparkInvocationPendingDelivery[] {
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    const normalizedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    this.ensureDeliveryConsumer(normalizedDestination);
    const normalizedBindings = workspaceBindingIds
      ? [...new Set(workspaceBindingIds.map((value) => value.trim()).filter(Boolean))]
      : undefined;
    if (normalizedBindings?.length === 0) return [];
    const bindingPlaceholders = normalizedBindings?.map(() => "?").join(", ");
    const bindingFilter = normalizedBindings
      ? ` AND (
            i.workspace_binding_id IN (${bindingPlaceholders})
            OR (
              i.workspace_binding_id IS NULL
              AND (
                SELECT COUNT(*)
                FROM daemon_workspaces unique_dw
                WHERE unique_dw.server_workspace_id = CASE
                    WHEN json_valid(i.task_json)
                      THEN json_extract(i.task_json, '$.workspaceId')
                  END
                  AND NOT EXISTS (
                    SELECT 1
                    FROM workspace_lifecycle unique_lifecycle
                    WHERE unique_lifecycle.workspace_id = unique_dw.id
                  )
              ) = 1
              AND EXISTS (
                SELECT 1
                FROM daemon_workspaces dw
                WHERE dw.id IN (${bindingPlaceholders})
                  AND dw.server_workspace_id = CASE
                    WHEN json_valid(i.task_json)
                      THEN json_extract(i.task_json, '$.workspaceId')
                  END
                  AND NOT EXISTS (
                    SELECT 1
                    FROM workspace_lifecycle lifecycle
                    WHERE lifecycle.workspace_id = dw.id
                  )
              )
            )
          )`
      : "";
    const invocationRows = this.db
      .prepare(buildPendingDeliveriesQuery(invocationSelectColumns("i", false), bindingFilter))
      .all(
        ...(normalizedBindings ? ["legacy", "legacy"] : [null, null]),
        normalizedDestination,
        ...(normalizedBindings ?? []),
        ...(normalizedBindings ?? []),
        normalizedLimit,
      ) as unknown as PendingDeliveryRow[];
    return invocationRows.map((row) => ({
      invocation: invocationRecord(row),
      event:
        normalizedBindings &&
        row.workspace_binding_id === null &&
        isSparkInvocationTerminalStatus(row.status)
          ? recoveredTerminalLifecycleEvent(row)
          : invocationEvent({
              invocation_id: row.event_invocation_id,
              sequence: row.event_sequence,
              kind: row.event_kind,
              payload_json: row.event_payload_json,
              created_at: row.event_created_at,
            }),
    }));
  }

  ensureDeliveryConsumer(destination: string, now = new Date().toISOString()): void {
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO invocation_event_delivery_consumers (destination, registered_at)
         VALUES (?, ?)`,
      )
      .run(normalizedDestination, now);
  }

  pendingDeliveryPage(
    destination: string,
    limit = MAX_INVOCATION_DELIVERY_PAGE_LIMIT,
    workspaceBindingIds?: readonly string[],
  ): SparkInvocationPendingDeliveryPage {
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    this.ensureDeliveryConsumer(normalizedDestination);
    const normalizedLimit = Math.max(
      1,
      Math.min(MAX_INVOCATION_DELIVERY_PAGE_LIMIT, Math.floor(limit)),
    );
    const normalizedBindings = workspaceBindingIds
      ? [...new Set(workspaceBindingIds.map((value) => value.trim()).filter(Boolean))]
      : undefined;
    if (normalizedBindings?.length === 0) return { deliveries: [], hasMore: false };
    const candidates = this.deliveryHeads(
      normalizedDestination,
      normalizedBindings,
      normalizedLimit + 1,
    );
    const heads = new DeliveryHeadHeap();
    for (const candidate of candidates) {
      const head = this.deliveryHead(candidate);
      if (head) heads.push(head);
    }

    const nextEvent = this.db.prepare(
      `SELECT sequence, created_at
       FROM invocation_events INDEXED BY invocation_events_delivery_head_idx
       WHERE invocation_id = ? AND sequence > ?
       ORDER BY sequence
       LIMIT 1`,
    );
    const eventBySequence = this.db.prepare(
      `SELECT invocation_id, sequence, kind, payload_json, created_at
       FROM invocation_events INDEXED BY invocation_events_cursor_idx
       WHERE invocation_id = ? AND sequence = ?`,
    );
    const legacyInvocation = this.db.prepare(
      `SELECT id, session_id, status, task_json, source_kind, cancel_reason,
              error_code, error_message, updated_at, finished_at
       FROM invocations
       WHERE id = ?`,
    );

    const selected: DeliveryHead[] = [];
    while (selected.length < normalizedLimit + 1) {
      const head = heads.pop();
      if (!head) break;
      selected.push(head);
      const next = this.nextDeliveryHead(head, nextEvent);
      if (next) heads.push(next);
    }
    const hasMore = selected.length > normalizedLimit || heads.size > 0;
    const deliveries = selected
      .slice(0, normalizedLimit)
      .map((head) => this.deliveryPageItem(head, eventBySequence, legacyInvocation));
    return { deliveries, hasMore };
  }

  private deliveryHeads(
    destination: string,
    workspaceBindingIds: readonly string[] | undefined,
    candidateLimit: number,
  ): DeliveryHeadCandidateRow[] {
    if (!workspaceBindingIds) {
      return this.db
        .prepare(
          `WITH eligible AS MATERIALIZED (
             SELECT i.id AS invocation_id,
                  i.workspace_binding_id,
                  COALESCE(delivery.sequence, 0) AS delivery_sequence,
                  i.event_cursor,
                  i.status,
                  0 AS legacy_projection,
                  NULL AS legacy_workspace_id
             FROM invocations i
             LEFT JOIN invocation_event_deliveries delivery
               ON delivery.destination = ? AND delivery.invocation_id = i.id
             WHERE i.event_cursor > COALESCE(delivery.sequence, 0)
             LIMIT ?
           )
           SELECT eligible.*,
                  event.sequence AS head_sequence,
                  event.created_at AS head_created_at
           FROM eligible
           JOIN invocation_events event INDEXED BY invocation_events_delivery_head_idx
             ON event.invocation_id = eligible.invocation_id
            AND event.sequence = (
              SELECT MIN(candidate.sequence)
              FROM invocation_events candidate INDEXED BY invocation_events_delivery_head_idx
              WHERE candidate.invocation_id = eligible.invocation_id
                AND candidate.sequence > eligible.delivery_sequence
            )`,
        )
        .all(destination, candidateLimit) as unknown as DeliveryHeadCandidateRow[];
    }

    const placeholders = workspaceBindingIds.map(() => "?").join(", ");
    const bound = this.db
      .prepare(
        `WITH eligible AS MATERIALIZED (
           SELECT i.id AS invocation_id,
                i.workspace_binding_id,
                COALESCE(delivery.sequence, 0) AS delivery_sequence,
                i.event_cursor,
                i.status,
                0 AS legacy_projection,
                NULL AS legacy_workspace_id
         FROM invocations i INDEXED BY invocations_workspace_updated_idx
         LEFT JOIN invocation_event_deliveries delivery
           ON delivery.destination = ? AND delivery.invocation_id = i.id
         WHERE i.workspace_binding_id IN (${placeholders})
           AND i.event_cursor > COALESCE(delivery.sequence, 0)
         LIMIT ?
         )
         SELECT eligible.*,
                event.sequence AS head_sequence,
                event.created_at AS head_created_at
         FROM eligible
         JOIN invocation_events event INDEXED BY invocation_events_delivery_head_idx
           ON event.invocation_id = eligible.invocation_id
          AND event.sequence = (
            SELECT MIN(candidate.sequence)
            FROM invocation_events candidate INDEXED BY invocation_events_delivery_head_idx
            WHERE candidate.invocation_id = eligible.invocation_id
              AND candidate.sequence > eligible.delivery_sequence
          )`,
      )
      .all(
        destination,
        ...workspaceBindingIds,
        candidateLimit,
      ) as unknown as DeliveryHeadCandidateRow[];
    const legacyBindings = this.uniqueLegacyWorkspaceBindings(workspaceBindingIds);
    if (legacyBindings.size === 0) return bound;
    const legacyWorkspaceIds = [...legacyBindings.keys()];
    const legacyPlaceholders = legacyWorkspaceIds.map(() => "?").join(", ");
    const legacy = this.db
      .prepare(
        `WITH eligible AS MATERIALIZED (
           SELECT i.id AS invocation_id,
                NULL AS workspace_binding_id,
                COALESCE(delivery.sequence, 0) AS delivery_sequence,
                i.event_cursor,
                i.status,
                1 AS legacy_projection,
                json_extract(i.task_json, '$.workspaceId') AS legacy_workspace_id
         FROM invocations i INDEXED BY invocations_legacy_workspace_delivery_idx
         LEFT JOIN invocation_event_deliveries delivery
           ON delivery.destination = ? AND delivery.invocation_id = i.id
         WHERE i.workspace_binding_id IS NULL
           AND json_extract(i.task_json, '$.workspaceId') IN (${legacyPlaceholders})
           AND i.event_cursor > COALESCE(delivery.sequence, 0)
           LIMIT ?
         ), selected AS MATERIALIZED (
           SELECT eligible.*,
                  CASE
                    WHEN eligible.status IN ('succeeded', 'failed', 'cancelled')
                      THEN eligible.event_cursor
                    ELSE COALESCE(
                      (
                        SELECT lifecycle.sequence
                        FROM invocation_events lifecycle INDEXED BY invocation_events_delivery_head_idx
                        WHERE lifecycle.invocation_id = eligible.invocation_id
                          AND lifecycle.kind = 'daemon.task.lifecycle'
                        ORDER BY lifecycle.sequence DESC
                        LIMIT 1
                      ),
                      eligible.event_cursor
                    )
                  END AS head_sequence
           FROM eligible
         )
         SELECT selected.*,
                event.created_at AS head_created_at
         FROM selected
         JOIN invocation_events event INDEXED BY invocation_events_delivery_head_idx
           ON event.invocation_id = selected.invocation_id
          AND event.sequence = selected.head_sequence
         WHERE selected.head_sequence > selected.delivery_sequence`,
      )
      .all(
        destination,
        ...legacyWorkspaceIds,
        candidateLimit,
      ) as unknown as DeliveryHeadCandidateRow[];
    return [
      ...bound,
      ...legacy.map((candidate) => ({
        ...candidate,
        workspace_binding_id:
          candidate.legacy_workspace_id === null
            ? null
            : (legacyBindings.get(candidate.legacy_workspace_id) ?? null),
      })),
    ];
  }

  private deliveryHead(candidate: DeliveryHeadCandidateRow): DeliveryHead | undefined {
    if (candidate.legacy_projection === 1) {
      const workspaceBindingId = candidate.workspace_binding_id ?? undefined;
      if (!workspaceBindingId) return undefined;
      const legacyTerminal = isSparkInvocationTerminalStatus(candidate.status);
      return {
        invocationId: candidate.invocation_id,
        workspaceBindingId,
        sequence: candidate.head_sequence,
        createdAt: candidate.head_created_at,
        orderAt: candidate.head_created_at,
        legacyTerminal,
        legacyFixedSequence: candidate.head_sequence,
      };
    }
    return {
      invocationId: candidate.invocation_id,
      ...(candidate.workspace_binding_id
        ? { workspaceBindingId: candidate.workspace_binding_id }
        : {}),
      sequence: candidate.head_sequence,
      createdAt: candidate.head_created_at,
      orderAt: candidate.head_created_at,
      legacyTerminal: false,
    };
  }

  private nextDeliveryHead(
    head: DeliveryHead,
    statement: ReturnType<DatabaseSync["prepare"]>,
  ): DeliveryHead | undefined {
    if (head.legacyFixedSequence !== undefined) return undefined;
    const row = statement.get(head.invocationId, head.sequence) as DeliveryHeadRow | undefined;
    return row
      ? {
          invocationId: head.invocationId,
          ...(head.workspaceBindingId ? { workspaceBindingId: head.workspaceBindingId } : {}),
          sequence: row.sequence,
          createdAt: row.created_at,
          orderAt: row.created_at > head.orderAt ? row.created_at : head.orderAt,
          legacyTerminal: false,
        }
      : undefined;
  }

  private deliveryPageItem(
    head: DeliveryHead,
    eventBySequence: ReturnType<DatabaseSync["prepare"]>,
    legacyInvocation: ReturnType<DatabaseSync["prepare"]>,
  ): SparkInvocationDeliveryPageItem {
    if (head.legacyTerminal) {
      const row = legacyInvocation.get(head.invocationId) as LegacyTerminalDeliveryRow | undefined;
      if (!row) throw new Error(`Missing legacy invocation delivery: ${head.invocationId}`);
      return {
        event: recoveredTerminalLifecycleEventFromLean(row, head.sequence, head.createdAt),
        ...(head.workspaceBindingId ? { workspaceBindingId: head.workspaceBindingId } : {}),
      };
    }
    const row = eventBySequence.get(head.invocationId, head.sequence) as
      | InvocationEventRow
      | undefined;
    if (!row) {
      throw new Error(`Missing invocation delivery event: ${head.invocationId}:${head.sequence}`);
    }
    return {
      event: invocationEvent(row),
      ...(head.workspaceBindingId ? { workspaceBindingId: head.workspaceBindingId } : {}),
    };
  }

  private uniqueLegacyWorkspaceBindings(
    workspaceBindingIds: readonly string[],
  ): Map<string, string> {
    const placeholders = workspaceBindingIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT server_workspace_id, MIN(id) AS binding_id
         FROM daemon_workspaces
         WHERE server_workspace_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM workspace_lifecycle lifecycle
             WHERE lifecycle.workspace_id = daemon_workspaces.id
           )
         GROUP BY server_workspace_id
         HAVING COUNT(*) = 1 AND MIN(id) IN (${placeholders})`,
      )
      .all(...workspaceBindingIds) as unknown as Array<{
      server_workspace_id: string;
      binding_id: string;
    }>;
    return new Map(rows.map((row) => [row.server_workspace_id, row.binding_id]));
  }

  acknowledgeDelivery(
    destination: string,
    invocationId: string,
    sequence: number,
    now = new Date().toISOString(),
  ): void {
    this.require(invocationId);
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    const normalizedSequence = Math.max(0, Math.floor(sequence));
    this.ensureDeliveryConsumer(normalizedDestination, now);
    if (normalizedSequence > this.latestEventSequence(invocationId)) {
      throw new SparkDaemonControlError(
        "invocation_cursor_gap",
        `INVOCATION_DELIVERY_CURSOR_GAP: cursor ${normalizedSequence} is beyond latest sequence`,
      );
    }
    this.upsertDeliveryCursor(normalizedDestination, invocationId, normalizedSequence, now);
  }

  acknowledgeKnownDelivery(
    destination: string,
    event: Pick<SparkInvocationEvent, "invocationId" | "sequence">,
    now = new Date().toISOString(),
  ): void {
    const normalizedDestination = destination.trim();
    if (!normalizedDestination) {
      throw new Error("invocation delivery destination must not be blank");
    }
    if (!event.invocationId.trim() || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      throw new Error("known invocation delivery event must have a positive sequence");
    }
    this.upsertDeliveryCursor(normalizedDestination, event.invocationId, event.sequence, now);
  }

  private upsertDeliveryCursor(
    destination: string,
    invocationId: string,
    sequence: number,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO invocation_event_deliveries (destination, invocation_id, sequence, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(destination, invocation_id) DO UPDATE SET
           sequence = MAX(invocation_event_deliveries.sequence, excluded.sequence),
           updated_at = excluded.updated_at`,
      )
      .run(destination, invocationId, sequence, now);
  }

  /** True only when this acknowledgement reaches a terminal Invocation's
   * current event cursor and can therefore release a retention delivery fence. */
  terminalDeliveryMayUnblockRetention(invocationId: string, sequence: number): boolean {
    const row = this.db
      .prepare(
        `SELECT status, payload_redacted_at, event_cursor
         FROM invocations
         WHERE id = ?`,
      )
      .get(invocationId) as
      | { status: string; payload_redacted_at: string | null; event_cursor: number }
      | undefined;
    return Boolean(
      row &&
      isSparkInvocationTerminalStatus(row.status) &&
      row.payload_redacted_at === null &&
      Math.max(0, Math.floor(sequence)) === Number(row.event_cursor),
    );
  }

  latestEventSequence(invocationId: string): number {
    this.require(invocationId);
    const row = this.db
      .prepare(
        `SELECT event_cursor AS sequence
         FROM invocations
         WHERE id = ?`,
      )
      .get(invocationId) as { sequence: number };
    return Number(row.sequence);
  }

  retry(invocationId: string, now = new Date().toISOString()): SparkInvocationRecord {
    const original = this.require(invocationId);
    if (isLoopTickInvocation(original)) {
      throw new SparkDaemonControlError(
        "invocation_not_retryable",
        `INVOCATION_NOT_RETRYABLE: ${invocationId} is a Loop tick; use loop.restart or loop.wake`,
      );
    }
    const explicitlyRetryable = isExplicitlyRetryableInvocation(original);
    if (!explicitlyRetryable && original.status !== "failed") {
      throw new SparkDaemonControlError(
        "invocation_not_retryable",
        `INVOCATION_NOT_RETRYABLE: ${invocationId} is ${original.status}`,
      );
    }
    if (!explicitlyRetryable && !isRetryableInvocationError(original.errorCode)) {
      throw new SparkDaemonControlError(
        "invocation_not_retryable",
        `INVOCATION_NOT_RETRYABLE: ${original.errorCode ?? "UNKNOWN"} requires correction before resubmission`,
      );
    }
    if (!explicitlyRetryable) {
      throw new SparkDaemonControlError(
        "invocation_not_retryable",
        `INVOCATION_NOT_RETRYABLE: ${invocationId} has no task`,
      );
    }
    return this.submit({
      commandId: original.commandId,
      workspaceBindingId: original.workspaceBindingId,
      sessionId: original.sessionId,
      idempotencyKey: `invocation.retry:${invocationId}`,
      prompt: original.prompt,
      task: taskForExplicitRetry(original.task),
      sourceKind: "invocation.retry",
      sourceRef: invocationId,
      retryOfInvocationId: invocationId,
      now,
    });
  }

  retentionPreview(before: string, limit = 100): SparkInvocationRetentionPreview {
    const normalizedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT i.id,
                COUNT(e.sequence) AS event_count,
                CASE WHEN ${LATEST_INVOCATION_EVENT_SEQUENCE_SQL} > 0
                  AND ${unacknowledgedDeliveryExistsSql(
                    "i",
                    "i.id",
                    LATEST_INVOCATION_EVENT_SEQUENCE_SQL,
                  )}
                  THEN 1 ELSE 0 END AS blocked
         FROM invocations i
         LEFT JOIN invocation_events e ON e.invocation_id = i.id
         WHERE i.status IN ('succeeded', 'failed', 'cancelled')
           AND i.retained_at IS NULL
           AND i.finished_at IS NOT NULL
           AND i.finished_at < ?
         GROUP BY i.id, i.finished_at
         ORDER BY i.finished_at, i.id
         LIMIT ?`,
      )
      .all(before, normalizedLimit) as unknown as Array<{
      id: string;
      event_count: number;
      blocked: number;
    }>;
    return {
      before,
      invocationIds: rows.filter((row) => Number(row.blocked) === 0).map((row) => row.id),
      eventCount: rows
        .filter((row) => Number(row.blocked) === 0)
        .reduce((sum, row) => sum + Number(row.event_count), 0),
      blockedByDeliveryCount: rows.filter((row) => Number(row.blocked) !== 0).length,
    };
  }

  pruneViewEventCache(before: string, limit = 1_000): number {
    const normalizedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return Number(
      this.db
        .prepare(
          `DELETE FROM invocation_events
           WHERE rowid IN (
             SELECT e.rowid
             FROM invocation_events e
             JOIN invocations i ON i.id = e.invocation_id
             WHERE e.kind = 'daemon.view_event'
               AND e.created_at < ?
               AND i.status IN ('succeeded', 'failed', 'cancelled')
               AND NOT ${unacknowledgedDeliveryExistsSql("i", "e.invocation_id", "e.sequence")}
             ORDER BY e.created_at, e.rowid
             LIMIT ?
           )`,
        )
        .run(before, normalizedLimit).changes,
    );
  }

  retentionApply(
    before: string,
    input: SparkInvocationRetentionApplyInput = {},
  ): SparkInvocationRetentionApplyResult {
    const invocationLimit = Math.max(1, Math.min(100, Math.floor(input.invocationLimit ?? 10)));
    const eventLimit = Math.max(1, Math.min(10_000, Math.floor(input.eventLimit ?? 100)));
    const retainedAt = input.now ?? new Date().toISOString();
    const candidateRows = this.db
      .prepare(
        `SELECT i.id
         FROM invocations i INDEXED BY invocations_retention_idx
         WHERE i.retained_at IS NULL
           AND i.status IN ('succeeded', 'failed', 'cancelled')
           AND i.finished_at IS NOT NULL
           AND i.finished_at < ?
           AND NOT ${unacknowledgedDeliveryExistsSql("i", "i.id", "i.event_cursor")}
         ORDER BY i.finished_at, i.id
         LIMIT ?`,
      )
      .all(before, invocationLimit) as unknown as Array<{ id: string }>;
    const touchedInvocationIds: string[] = [];
    const retainedInvocationIds: string[] = [];
    let deletedEventCount = 0;
    let clearedResultCount = 0;

    for (const candidate of candidateRows) {
      if (deletedEventCount >= eventLimit) break;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const eligible = this.db
          .prepare(
            `SELECT 1
             FROM invocations i
             WHERE i.id = ?
               AND i.retained_at IS NULL
               AND i.status IN ('succeeded', 'failed', 'cancelled')
               AND i.finished_at IS NOT NULL
               AND i.finished_at < ?
               AND NOT ${unacknowledgedDeliveryExistsSql("i", "i.id", "i.event_cursor")}`,
          )
          .get(candidate.id, before);
        if (!eligible) {
          this.db.exec("COMMIT");
          continue;
        }
        touchedInvocationIds.push(candidate.id);
        this.sealReceiptOutputRefsInTransaction(candidate.id);
        const deleted = Number(
          this.db
            .prepare(
              `DELETE FROM invocation_events
               WHERE rowid IN (
                 SELECT rowid
                 FROM invocation_events
                 WHERE invocation_id = ?
                   AND kind <> 'invocation.receipt_context'
                 ORDER BY sequence
                 LIMIT ?
               )`,
            )
            .run(candidate.id, eventLimit - deletedEventCount).changes,
        );
        deletedEventCount += deleted;
        const hasPrunableEvents = Boolean(
          this.db
            .prepare(
              `SELECT 1
               FROM invocation_events
               WHERE invocation_id = ? AND kind <> 'invocation.receipt_context'
               LIMIT 1`,
            )
            .get(candidate.id),
        );
        if (!hasPrunableEvents) {
          const cleared = this.db
            .prepare(
              `UPDATE invocations
               SET result_json = NULL
               WHERE id = ? AND retained_at IS NULL AND result_json IS NOT NULL`,
            )
            .run(candidate.id);
          const retained = this.db
            .prepare(
              `UPDATE invocations
               SET retained_at = ?
               WHERE id = ? AND retained_at IS NULL`,
            )
            .run(retainedAt, candidate.id);
          if (Number(retained.changes) === 1) {
            retainedInvocationIds.push(candidate.id);
            clearedResultCount += Number(cleared.changes);
          }
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const blockedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM invocations i INDEXED BY invocations_retention_idx
         WHERE i.retained_at IS NULL
           AND i.status IN ('succeeded', 'failed', 'cancelled')
           AND i.finished_at IS NOT NULL
           AND i.finished_at < ?
           AND ${unacknowledgedDeliveryExistsSql("i", "i.id", "i.event_cursor")}`,
      )
      .get(before) as { count: number };
    const hasMore = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM invocations i INDEXED BY invocations_retention_idx
           WHERE i.retained_at IS NULL
             AND i.status IN ('succeeded', 'failed', 'cancelled')
             AND i.finished_at IS NOT NULL
             AND i.finished_at < ?
             AND NOT ${unacknowledgedDeliveryExistsSql("i", "i.id", "i.event_cursor")}
           LIMIT 1`,
        )
        .get(before),
    );
    return {
      before,
      touchedInvocationIds,
      retainedInvocationIds,
      deletedEventCount,
      retainedInvocationCount: retainedInvocationIds.length,
      clearedResultCount,
      blockedByDeliveryCount: Number(blockedRow.count),
      hasMore,
    };
  }

  /**
   * Remove closed-session content while preserving lifecycle metadata, usage
   * rows, execution profiles, and one bounded retention summary per invocation.
   */
  redactSessionPayloads(
    sessionId: string,
    input: { now?: string } = {},
  ): SparkInvocationPayloadRedactionResult {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) throw new Error("sessionId is required for payload redaction");
    const redactedAt = input.now ?? new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, status, source_kind, error_code, event_cursor, claim_class
         FROM invocations
         WHERE session_id = ?
         ORDER BY created_at, rowid`,
      )
      .all(normalizedSessionId) as unknown as Array<{
      id: string;
      status: string;
      source_kind: string | null;
      error_code: string | null;
      event_cursor: number;
      claim_class: string;
    }>;
    const blockedInvocationIds = rows
      .filter((row) => {
        if (row.status === "queued" || row.status === "running") return true;
        // Structured children are synchronously returned to and projected by
        // their parent invocation. They have no independent external delivery
        // destination, so global delivery consumers must not retain them.
        if (row.claim_class === "structured") return false;
        return Boolean(
          this.db
            .prepare(
              `SELECT 1
               FROM invocations i
               WHERE i.id = ?
                 AND ${unacknowledgedDeliveryExistsSql("i", "i.id", "?2")}`,
            )
            .get(row.id, Number(row.event_cursor)),
        );
      })
      .map((row) => row.id);
    const blocked = new Set(blockedInvocationIds);
    const eligible = rows.filter((row) => !blocked.has(row.id));
    let deletedEventCount = 0;
    const redactedInvocationIds: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of eligible) {
        this.sealReceiptOutputRefsInTransaction(row.id);
        deletedEventCount += Number(
          this.db
            .prepare(
              `DELETE FROM invocation_events
               WHERE invocation_id = ? AND kind <> 'invocation.receipt_context'`,
            )
            .run(row.id).changes,
        );
        const summary = {
          status: row.status,
          ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
          ...(row.error_code ? { errorCode: row.error_code } : {}),
        } satisfies Record<string, unknown>;
        const changed = this.db
          .prepare(
            `UPDATE invocations
             SET prompt = NULL,
                 task_json = NULL,
                 result_json = NULL,
                 cancel_reason = NULL,
                 error_message = NULL,
                 retention_summary_json = ?,
                 payload_redacted_at = ?,
                 retained_at = COALESCE(retained_at, ?),
                 updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
             WHERE id = ? AND status IN ('succeeded', 'failed', 'cancelled')`,
          )
          .run(
            serializeBoundedRecord(summary, MAX_PERSISTED_RETENTION_SUMMARY_BYTES),
            redactedAt,
            redactedAt,
            redactedAt,
            redactedAt,
            row.id,
          );
        if (Number(changed.changes) === 1) redactedInvocationIds.push(row.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      sessionId: normalizedSessionId,
      redactedInvocationIds,
      deletedEventCount,
      blockedInvocationIds,
      redactedAt,
    };
  }

  private sealReceiptOutputRefsInTransaction(invocationId: string): void {
    const row = this.db
      .prepare(
        `SELECT rowid, payload_json
         FROM invocation_events
         WHERE invocation_id = ? AND kind = 'invocation.receipt_context'
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(invocationId) as { rowid: number; payload_json: string } | undefined;
    if (!row) return;
    const context = parseJson(row.payload_json) as SparkInvocationReceiptContext;
    if (context.outputRefs) return;
    const receipt = this.invocationReceipt(invocationId);
    this.db
      .prepare("UPDATE invocation_events SET payload_json = ? WHERE rowid = ?")
      .run(JSON.stringify({ ...context, outputRefs: receipt.outputRefs }), row.rowid);
  }

  oldestActive(): { queued?: string; running?: string } {
    const rows = this.db
      .prepare(
        `SELECT status, MIN(created_at) AS created_at
         FROM invocations
         WHERE status IN ('queued', 'running')
         GROUP BY status`,
      )
      .all() as unknown as Array<{ status: "queued" | "running"; created_at: string }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.created_at]));
  }

  eventPage(
    invocationId: string,
    after = 0,
    limit = DEFAULT_EVENT_PAGE_LIMIT,
  ): SparkInvocationEventPage {
    const latestSequence = this.latestEventSequence(invocationId);
    const normalizedAfter = Math.max(0, Math.floor(after));
    if (normalizedAfter > latestSequence) {
      throw new SparkDaemonControlError(
        "invocation_cursor_gap",
        `INVOCATION_CURSOR_GAP: cursor ${normalizedAfter} is beyond latest sequence ${latestSequence}`,
      );
    }
    const normalizedLimit = Math.max(
      1,
      Math.min(MAX_INVOCATION_EVENT_PAGE_LIMIT, Math.floor(limit)),
    );
    const rows = this.db
      .prepare(
        `SELECT invocation_id, sequence, kind, payload_json, created_at
         FROM invocation_events
         WHERE invocation_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(invocationId, normalizedAfter, normalizedLimit + 1) as unknown as InvocationEventRow[];
    const hasMore = rows.length > normalizedLimit;
    const events = rows.slice(0, normalizedLimit).map(invocationEvent);
    return {
      invocationId,
      events,
      nextCursor: events.at(-1)?.sequence ?? normalizedAfter,
      hasMore,
    };
  }
}

const invocationSelect = `SELECT ${invocationSelectColumns()}
  FROM invocations`;

function invocationSelectColumns(alias?: string, includeResult = true): string {
  const prefix = alias ? `${alias}.` : "";
  const column = (name: string) => `${prefix}${name} AS ${name}`;
  return [
    ...[
      "id",
      "command_id",
      "workspace_binding_id",
      "session_id",
      "idempotency_key",
      "status",
      "prompt",
      "task_json",
    ].map(column),
    includeResult
      ? `CASE WHEN COALESCE(octet_length(${prefix}result_json), 0) <= ${MAX_PERSISTED_INVOCATION_RESULT_BYTES} THEN ${prefix}result_json ELSE NULL END AS result_json`
      : "NULL AS result_json",
    `COALESCE(octet_length(${prefix}result_json), 0) AS result_json_bytes`,
    ...[
      "source_kind",
      "source_ref",
      "parent_invocation_id",
      "retry_of_invocation_id",
      "claim_class",
      "execution_profile_json",
      "retention_summary_json",
      "payload_redacted_at",
      "worker_id",
      "attempt_count",
      "cancel_reason",
      "error_code",
      "error_message",
      "created_at",
      "updated_at",
      "claimed_at",
      "started_at",
      "finished_at",
    ].map(column),
  ].join(", ");
}

function invocationRecord(row: InvocationRow): SparkInvocationRecord {
  if (!isInvocationStatus(row.status)) throw new Error(`Invalid invocation status: ${row.status}`);
  const result = persistedResult(row);
  return {
    invocationId: row.id,
    ...(row.command_id ? { commandId: row.command_id } : {}),
    ...(row.workspace_binding_id ? { workspaceBindingId: row.workspace_binding_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    status: row.status,
    ...(row.prompt !== null ? { prompt: row.prompt } : {}),
    ...(row.task_json !== null ? { task: parseJson(row.task_json) } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(row.source_kind ? { sourceKind: row.source_kind } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.parent_invocation_id ? { parentInvocationId: row.parent_invocation_id } : {}),
    ...(row.retry_of_invocation_id ? { retryOfInvocationId: row.retry_of_invocation_id } : {}),
    claimClass: row.claim_class === "structured" ? "structured" : "root",
    ...(row.execution_profile_json
      ? { executionProfile: parseJsonRecord(row.execution_profile_json) }
      : {}),
    ...(row.retention_summary_json
      ? { retentionSummary: parseJsonRecord(row.retention_summary_json) }
      : {}),
    ...(row.payload_redacted_at ? { payloadRedactedAt: row.payload_redacted_at } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    attemptCount: Number(row.attempt_count),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function persistedResult(row: InvocationRow): unknown {
  if (row.result_json !== null) return parseJson(row.result_json);
  if (row.result_json_bytes <= MAX_PERSISTED_INVOCATION_RESULT_BYTES) return undefined;
  return {
    legacyOversizedResult: true,
    originalBytes: row.result_json_bytes,
    truncated: true,
  };
}

function invocationSummaryRecord(row: InvocationSummaryRow): SparkInvocationSummaryRecord {
  if (!isInvocationStatus(row.status)) throw new Error(`Invalid invocation status: ${row.status}`);
  return {
    invocationId: row.id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.retry_of_invocation_id ? { retryOfInvocationId: row.retry_of_invocation_id } : {}),
    status: row.status,
    attemptCount: Number(row.attempt_count),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    eventCursor: Number(row.event_cursor),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function invocationListFilter(
  input: SparkInvocationListInput,
  alias?: string,
): { where: string; values: Array<string | number> } {
  const prefix = alias ? `${alias}.` : "";
  const conditions: string[] = [];
  const values: Array<string | number> = [];
  if (input.status) {
    conditions.push(`${prefix}status = ?`);
    values.push(input.status);
  }
  if (input.sessionId?.trim()) {
    conditions.push(`${prefix}session_id = ?`);
    values.push(input.sessionId.trim());
  }
  if (input.since) {
    conditions.push(`${prefix}created_at >= ?`);
    values.push(input.since);
  }
  return {
    where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    values,
  };
}

function invocationEvent(row: InvocationEventRow): SparkInvocationEvent {
  const payload = parseJson(row.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid invocation event payload at sequence ${row.sequence}`);
  }
  return {
    invocationId: row.invocation_id,
    sequence: Number(row.sequence),
    kind: row.kind,
    payload: payload as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function recoveredTerminalLifecycleEvent(row: PendingDeliveryRow): SparkInvocationEvent {
  if (!isSparkInvocationTerminalStatus(row.status)) {
    throw new Error(`Cannot recover nonterminal invocation lifecycle: ${row.id}`);
  }
  const task = jsonObject(row.task_json === null ? undefined : parseJson(row.task_json));
  const taskType = jsonString(task, "type") ?? row.source_kind ?? "legacy.invocation";
  const workspaceId = jsonString(task, "workspaceId");
  const projectId = jsonString(task, "projectId");
  const sessionId = row.session_id ?? jsonString(task, "sessionId");
  const summary =
    row.status === "failed"
      ? (row.error_message ?? row.error_code)
      : row.status === "cancelled"
        ? row.cancel_reason
        : null;
  return {
    invocationId: row.event_invocation_id,
    sequence: Number(row.event_sequence),
    kind: "daemon.task.lifecycle",
    payload: {
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: row.finished_at ?? row.updated_at,
      invocationId: row.id,
      taskType,
      status: row.status,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(summary ? { summary } : {}),
      metadata: { recoveredFromInvocationRow: true },
    },
    createdAt: row.event_created_at,
  };
}

function recoveredTerminalLifecycleEventFromLean(
  row: LegacyTerminalDeliveryRow,
  sequence: number,
  createdAt: string,
): SparkInvocationEvent {
  if (!isSparkInvocationTerminalStatus(row.status)) {
    throw new Error(`Cannot recover nonterminal invocation lifecycle: ${row.id}`);
  }
  const task = jsonObject(row.task_json === null ? undefined : parseJson(row.task_json));
  const taskType = jsonString(task, "type") ?? row.source_kind ?? "legacy.invocation";
  const workspaceId = jsonString(task, "workspaceId");
  const projectId = jsonString(task, "projectId");
  const sessionId = row.session_id ?? jsonString(task, "sessionId");
  const summary =
    row.status === "failed"
      ? (row.error_message ?? row.error_code)
      : row.status === "cancelled"
        ? row.cancel_reason
        : null;
  return {
    invocationId: row.id,
    sequence,
    kind: "daemon.task.lifecycle",
    payload: {
      type: "daemon.task.lifecycle",
      source: "daemon",
      emittedAt: row.finished_at ?? row.updated_at,
      invocationId: row.id,
      taskType,
      status: row.status,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(summary ? { summary } : {}),
      metadata: { recoveredFromInvocationRow: true },
    },
    createdAt,
  };
}

function persistedInvocationEventPayload(
  invocationId: string,
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== "daemon.view_event") return payload;
  const bounded = boundedJsonValue(payload, 0, MAX_PERSISTED_INVOCATION_EVENT_BYTES);
  if (
    !containsTruncatedMarker(bounded) &&
    jsonBytes(bounded) <= MAX_PERSISTED_INVOCATION_EVENT_BYTES
  ) {
    return bounded as Record<string, unknown>;
  }
  const rawSessionId = jsonString(payload, "sessionId");
  const sessionId =
    rawSessionId && jsonBytes(rawSessionId) <= MAX_PERSISTED_EVENT_SESSION_ID_BYTES
      ? rawSessionId
      : "unknown";
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.view_event",
    source: "daemon",
    invocationId,
    sessionId,
    view: {
      version: SPARK_PROTOCOL_VERSION,
      type: "session.message",
      sessionId,
      message: {
        version: SPARK_PROTOCOL_VERSION,
        id: `cache-omitted-${invocationId}-${sequence}`,
        role: "assistant",
        text: "[streamed view event omitted from durable cache]",
        status: "done",
        metadata: { cacheOmitted: true },
      },
    },
  };
}

function containsTruncatedMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && (value as Record<string, unknown>).truncated === true) return true;
  return Array.isArray(value)
    ? value.some(containsTruncatedMarker)
    : Object.values(value as Record<string, unknown>).some(containsTruncatedMarker);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jsonString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function truncateJsonString(value: string, maxJsonBytes: number): string {
  const bounded = value.length > maxJsonBytes ? value.slice(0, maxJsonBytes) : value;
  if (Buffer.byteLength(JSON.stringify(bounded)) <= maxJsonBytes) return bounded;
  let low = 0;
  let high = bounded.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(bounded.slice(0, middle))) <= maxJsonBytes) low = middle;
    else high = middle - 1;
  }
  return bounded.slice(0, low);
}

function compactRegistryPersistence(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const compact: Record<string, unknown> = {};
  if (typeof value.status === "string") compact.status = truncateJsonString(value.status, 512);
  if (typeof value.message === "string") compact.message = truncateJsonString(value.message, 8_192);
  return compact;
}

function compactInvocationResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (Object.hasOwn(record, "jsonEvents")) {
      const assistantTextJsonBytes =
        typeof record.assistantText === "string"
          ? Buffer.byteLength(JSON.stringify(record.assistantText))
          : undefined;
      const registryPersistence = compactRegistryPersistence(
        jsonObject(record.registryPersistence),
      );
      const compact: Record<string, unknown> = {
        ...(typeof record.sessionId === "string"
          ? { sessionId: truncateJsonString(record.sessionId, 1_024) }
          : {}),
        ...(typeof record.sessionPath === "string"
          ? { sessionPath: truncateJsonString(record.sessionPath, 8_192) }
          : {}),
        ...(typeof record.newMessageCount === "number" && Number.isFinite(record.newMessageCount)
          ? { newMessageCount: record.newMessageCount }
          : {}),
        ...(typeof record.assistantText === "string"
          ? {
              assistantText: truncateJsonString(record.assistantText, 384 * 1_024),
              ...(assistantTextJsonBytes !== undefined && assistantTextJsonBytes > 384 * 1_024
                ? {
                    assistantTextOriginalBytes: assistantTextJsonBytes,
                    assistantTextTruncated: true,
                  }
                : {}),
            }
          : {}),
        ...(typeof record.stderr === "string"
          ? { stderr: truncateJsonString(record.stderr, 64 * 1_024) }
          : {}),
        ...(typeof record.eventsStreamed === "boolean"
          ? { eventsStreamed: record.eventsStreamed }
          : {}),
        ...(Array.isArray(record.jsonEvents) ? { jsonEventCount: record.jsonEvents.length } : {}),
        ...(record.channelReplyDelivered === true ? { channelReplyDelivered: true } : {}),
        ...(record.channelReplyDeliveryPending === true
          ? { channelReplyDeliveryPending: true }
          : {}),
        ...(registryPersistence ? { registryPersistence } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(compact)) > MAX_PERSISTED_INVOCATION_RESULT_BYTES) {
        throw new Error("Compacted invocation result exceeded the persisted result byte limit");
      }
      return compact;
    }
  }
  return boundedJsonValue(result);
}

function boundedJsonValue(
  value: unknown,
  depth = 0,
  budget = MAX_PERSISTED_INVOCATION_RESULT_BYTES,
): unknown {
  if (value === undefined) return undefined;
  if (depth > 8) return { truncated: true, reason: "depth" };
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const inputBytes = Buffer.byteLength(value) + 2;
    if (inputBytes <= budget) return value;
    const maxStringBytes = Math.max(0, Math.min(MAX_PERSISTED_RESULT_STRING_BYTES, budget - 64));
    return {
      value: truncateJsonString(value, maxStringBytes),
      originalBytes: inputBytes,
      truncated: true,
    };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    let truncated = value.length > MAX_PERSISTED_RESULT_ARRAY_ITEMS;
    for (const item of value.slice(0, MAX_PERSISTED_RESULT_ARRAY_ITEMS)) {
      const candidate = [...items, boundedJsonValue(item, depth + 1, Math.max(64, budget - 128))];
      if (jsonBytes(candidate) > budget - 64) {
        truncated = true;
        break;
      }
      items.push(candidate[candidate.length - 1]);
    }
    if (!truncated) return items;
    const bounded = { itemCount: value.length, items, truncated: true };
    return jsonBytes(bounded) <= budget ? bounded : { itemCount: value.length, truncated: true };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "function") return "[function]";
  const bounded: Record<string, unknown> = {};
  let truncated = false;
  let seenKeys = 0;
  for (const key in value as Record<string, unknown>) {
    seenKeys += 1;
    if (seenKeys > MAX_PERSISTED_RESULT_OBJECT_KEYS) {
      truncated = true;
      break;
    }
    const child = boundedJsonValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      Math.max(64, budget - jsonBytes(bounded) - 128),
    );
    bounded[key] = child;
    if (jsonBytes(bounded) > budget - 64) {
      delete bounded[key];
      truncated = true;
      break;
    }
  }
  if (truncated) {
    bounded.truncated = true;
    while (jsonBytes(bounded) > budget && Object.keys(bounded).length > 1) {
      const lastKey = Object.keys(bounded).at(-2);
      if (!lastKey) break;
      delete bounded[lastKey];
    }
  }
  return jsonBytes(bounded) <= budget ? bounded : { truncated: true };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function completedInvocationRecord(
  current: SparkInvocationRecord,
  input: CompleteSparkInvocationInput,
  result: unknown,
  now: string,
): SparkInvocationRecord {
  const completed: SparkInvocationRecord = {
    ...current,
    status: input.status,
    updatedAt: now,
    finishedAt: now,
  };
  Reflect.deleteProperty(completed, "cancelReason");
  Reflect.deleteProperty(completed, "errorCode");
  Reflect.deleteProperty(completed, "errorMessage");
  Reflect.deleteProperty(completed, "result");
  if (input.cancelReason) completed.cancelReason = input.cancelReason;
  if (input.errorCode) completed.errorCode = input.errorCode;
  if (input.errorMessage) completed.errorMessage = input.errorMessage;
  if (result !== undefined) completed.result = result;
  if (input.executionProfile) completed.executionProfile = input.executionProfile;
  if (input.retentionSummary) completed.retentionSummary = input.retentionSummary;
  return completed;
}

function serializePersistedResult(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_PERSISTED_INVOCATION_RESULT_BYTES) {
    throw new Error(
      `Persisted invocation result exceeded ${MAX_PERSISTED_INVOCATION_RESULT_BYTES} bytes`,
    );
  }
  return serialized;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function serializeBoundedRecord(
  value: Record<string, unknown> | undefined,
  budget: number,
): string | null {
  if (!value) return null;
  return JSON.stringify(boundedJsonValue(value, 0, budget));
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : { invalid: true };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Invalid persisted JSON", { cause: error });
  }
}

function invocationOutputRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || refs.size >= 128 || current === null || current === undefined) return;
    if (typeof current === "string") {
      if (/^(?:artifact|evidence|run|task|proj|subgoal|document):\S+$/u.test(current)) {
        refs.add(current);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    if (typeof current === "object") {
      for (const entry of Object.values(current as Record<string, unknown>)) {
        visit(entry, depth + 1);
      }
    }
  };
  visit(value, 0);
  return [...refs].sort();
}

function assertTransition(from: SparkInvocationStatus, to: SparkInvocationStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid Spark invocation transition: ${from} -> ${to}`);
  }
}

function assertIdempotentSubmission(
  existing: SparkInvocationRecord,
  input: SubmitSparkInvocationInput,
): void {
  if (
    existing.sessionId !== input.sessionId ||
    existing.prompt !== input.prompt ||
    existing.commandId !== input.commandId ||
    existing.workspaceBindingId !== input.workspaceBindingId ||
    existing.parentInvocationId !== input.parentInvocationId ||
    existing.retryOfInvocationId !== input.retryOfInvocationId ||
    existing.claimClass !== (input.claimClass ?? "root") ||
    JSON.stringify(existing.task) !== JSON.stringify(input.task)
  ) {
    throw new SparkDaemonControlError(
      "invocation_idempotency_conflict",
      `Invocation idempotency conflict: ${input.idempotencyKey}`,
    );
  }
}

export function isRetryableInvocationError(errorCode: string | undefined): boolean {
  return (
    errorCode === "EXECUTOR_TIMEOUT" ||
    errorCode === "STREAM_IDLE_TIMEOUT" ||
    errorCode === "STREAM_WALL_TIMEOUT" ||
    errorCode === "EXECUTION_TRANSIENT" ||
    errorCode === "DELIVERY_FAILED" ||
    errorCode === SPARK_INVOCATION_INTERRUPTED_ERROR_CODE
  );
}

export function isExplicitlyRetryableInvocation(invocation: SparkInvocationRecord): boolean {
  const task =
    invocation.task && typeof invocation.task === "object" && !Array.isArray(invocation.task)
      ? (invocation.task as { type?: unknown })
      : undefined;
  return isExplicitlyRetryableInvocationState({
    status: invocation.status,
    ...(invocation.errorCode ? { errorCode: invocation.errorCode } : {}),
    ...(invocation.sourceKind ? { sourceKind: invocation.sourceKind } : {}),
    hasObjectTask: task !== undefined,
    taskType: task?.type,
  });
}

function isExplicitlyRetryableInvocationState(invocation: {
  status: SparkInvocationStatus;
  errorCode?: string;
  sourceKind?: string;
  hasObjectTask: boolean;
  taskType?: unknown;
}): boolean {
  if (invocation.status !== "failed" || !isRetryableInvocationError(invocation.errorCode)) {
    return false;
  }
  return (
    invocation.hasObjectTask &&
    invocation.sourceKind !== "loop.tick" &&
    invocation.taskType !== "loop.tick"
  );
}

function isLoopTickInvocation(invocation: { sourceKind?: string; task?: unknown }): boolean {
  return (
    invocation.sourceKind === "loop.tick" ||
    (invocation.task !== undefined &&
      typeof invocation.task === "object" &&
      !Array.isArray(invocation.task) &&
      (invocation.task as { type?: unknown }).type === "loop.tick")
  );
}

function markTaskForResume(task: unknown): unknown {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  if ((task as { type?: unknown }).type === "session.compact") return task;
  return { ...(task as Record<string, unknown>), resumeFromInterrupt: true };
}

function markTaskForRestartCheckpoint(
  task: unknown,
  checkpoint: SparkTurnResumeCheckpoint,
): Record<string, unknown> {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Invocation restart checkpoint requires a durable task");
  }
  return {
    ...(task as Record<string, unknown>),
    resumeFromInterrupt: true,
    restartCheckpoint: checkpoint,
  };
}

function taskForExplicitRetry(task: unknown): unknown {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  const retryTask = { ...(task as Record<string, unknown>) };
  delete retryTask.restartCheckpoint;
  return retryTask;
}

function isInvocationStatus(value: string): value is SparkInvocationStatus {
  return sparkInvocationStatuses.includes(value as SparkInvocationStatus);
}
