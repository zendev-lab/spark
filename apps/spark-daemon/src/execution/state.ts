import type { DatabaseSync } from "node:sqlite";

import type { ExecutionAttemptIdentity } from "./contract.ts";

export const EXECUTION_ATTEMPT_ACCEPTED_CRASH_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export type ExecutionAttemptStatus =
  | "queued"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "crashed";

export type ExecutionAttemptStateErrorCode =
  | "execution_attempt_not_found"
  | "execution_attempt_stale"
  | "execution_attempt_transition_invalid"
  | "execution_attempt_retry_exhausted"
  | "execution_attempt_corrupt_state";

export class ExecutionAttemptStateError extends Error {
  readonly code: ExecutionAttemptStateErrorCode;

  constructor(code: ExecutionAttemptStateErrorCode, message: string) {
    super(message);
    this.name = "ExecutionAttemptStateError";
    this.code = code;
  }
}

export interface ExecutionAttemptRecord extends ExecutionAttemptIdentity {
  correlationId: string;
  status: ExecutionAttemptStatus;
  acceptedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  nextAttemptAt?: string;
  eventHighWaterMark: number;
  usageHighWaterMark: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAttemptCrashRecord extends ExecutionAttemptIdentity {
  accepted: boolean;
  acceptedCrashOrdinal?: number;
  errorCode: string;
  nextAttemptAt?: string;
  createdAt: string;
}

export interface ExecutionAttemptCrashResult {
  crashed: ExecutionAttemptRecord;
  replacement?: ExecutionAttemptRecord;
  acceptedCrashCount: number;
  terminalFailed: boolean;
  backoffEvent?: {
    kind: "execution.attempt.retry_scheduled";
    attemptEpoch: number;
    nextAttemptEpoch: number;
    acceptedCrashCount: number;
    nextAttemptAt: string;
  };
}

export interface ExecutionAttemptStateEvent {
  invocationId: string;
  sequence: number;
  attemptEpoch: number;
  kind:
    | "execution.attempt.retry_scheduled"
    | "execution.attempt.retry_exhausted"
    | "execution.attempt.event_persisted"
    | "execution.attempt.usage_persisted";
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AttemptRow {
  invocation_id: string;
  attempt_epoch: number;
  daemon_generation: number;
  correlation_id: string;
  status: ExecutionAttemptStatus;
  accepted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
  event_high_water_mark: number;
  usage_high_water_mark: number;
  created_at: string;
  updated_at: string;
}

interface CrashRow {
  invocation_id: string;
  attempt_epoch: number;
  daemon_generation: number;
  accepted: number;
  accepted_crash_ordinal: number | null;
  error_code: string;
  next_attempt_at: string | null;
  created_at: string;
}

interface EventRow {
  invocation_id: string;
  sequence: number;
  attempt_epoch: number;
  kind: ExecutionAttemptStateEvent["kind"];
  payload_json: string;
  created_at: string;
}

export class ExecutionAttemptStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  create(
    invocationId: string,
    daemonGeneration: number,
    correlationId: string,
    now = new Date().toISOString(),
  ): ExecutionAttemptRecord {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.#db
        .prepare(
          `SELECT COALESCE(MAX(attempt_epoch), 0) AS attempt_epoch
           FROM execution_attempts
           WHERE invocation_id = ?`,
        )
        .get(invocationId) as { attempt_epoch: number };
      const attemptEpoch = last.attempt_epoch + 1;
      this.#insertQueued(
        { invocationId, attemptEpoch, daemonGeneration },
        correlationId,
        now,
        undefined,
      );
      this.#db.exec("COMMIT");
      return this.require({ invocationId, attemptEpoch, daemonGeneration });
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  begin(
    invocationId: string,
    daemonGeneration: number,
    correlationId: string,
    now = new Date().toISOString(),
  ): ExecutionAttemptRecord {
    const current = this.current(invocationId);
    if (!current) return this.create(invocationId, daemonGeneration, correlationId, now);
    if (current.status === "queued") {
      if (current.daemonGeneration === daemonGeneration) return current;
      const changes = Number(
        this.#db
          .prepare(
            `UPDATE execution_attempts
             SET daemon_generation = ?, correlation_id = ?, updated_at = ?
             WHERE invocation_id = ? AND attempt_epoch = ? AND daemon_generation = ?
               AND status = 'queued'`,
          )
          .run(
            daemonGeneration,
            correlationId,
            now,
            invocationId,
            current.attemptEpoch,
            current.daemonGeneration,
          ).changes,
      );
      if (changes !== 1) {
        throw new ExecutionAttemptStateError(
          "execution_attempt_stale",
          "queued execution attempt changed while transferring daemon ownership",
        );
      }
      return this.require({
        invocationId,
        attemptEpoch: current.attemptEpoch,
        daemonGeneration,
      });
    }
    if (current.status === "accepted" || current.status === "running") {
      const crashed = this.crash(current, "daemon_generation_replaced", now, daemonGeneration);
      if (!crashed.replacement) {
        throw new ExecutionAttemptStateError(
          "execution_attempt_retry_exhausted",
          "execution attempt crash budget is exhausted",
        );
      }
      return crashed.replacement;
    }
    const identity = {
      invocationId,
      attemptEpoch: current.attemptEpoch + 1,
      daemonGeneration,
    };
    this.#insertQueued(identity, correlationId, now, undefined);
    return this.require(identity);
  }

  require(identity: ExecutionAttemptIdentity): ExecutionAttemptRecord {
    const row = this.#db
      .prepare(
        `SELECT * FROM execution_attempts
         WHERE invocation_id = ? AND attempt_epoch = ?`,
      )
      .get(identity.invocationId, identity.attemptEpoch) as AttemptRow | undefined;
    if (!row) {
      throw new ExecutionAttemptStateError(
        "execution_attempt_not_found",
        `execution attempt not found: ${identity.invocationId}@${identity.attemptEpoch}`,
      );
    }
    if (row.daemon_generation !== identity.daemonGeneration) {
      throw new ExecutionAttemptStateError(
        "execution_attempt_stale",
        "execution attempt daemon generation is stale",
      );
    }
    return attemptRecord(row);
  }

  current(invocationId: string): ExecutionAttemptRecord | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM execution_attempts
         WHERE invocation_id = ?
         ORDER BY attempt_epoch DESC
         LIMIT 1`,
      )
      .get(invocationId) as AttemptRow | undefined;
    return row ? attemptRecord(row) : undefined;
  }

  accept(
    identity: ExecutionAttemptIdentity,
    now = new Date().toISOString(),
  ): ExecutionAttemptRecord {
    return this.#transition(identity, "queued", "accepted", now, "accepted_at");
  }

  start(
    identity: ExecutionAttemptIdentity,
    now = new Date().toISOString(),
  ): ExecutionAttemptRecord {
    return this.#transition(identity, "accepted", "running", now, "started_at");
  }

  complete(
    identity: ExecutionAttemptIdentity,
    status: "succeeded" | "failed" | "cancelled",
    highWater: { event: number; usage: number },
    now = new Date().toISOString(),
  ): ExecutionAttemptRecord {
    const current = this.#assertCurrent(identity);
    if (current.status !== "accepted" && current.status !== "running") {
      invalidTransition(current.status, status);
    }
    const changes = Number(
      this.#db
        .prepare(
          `UPDATE execution_attempts
           SET status = ?, finished_at = ?, event_high_water_mark = ?,
               usage_high_water_mark = ?, updated_at = ?
           WHERE invocation_id = ? AND attempt_epoch = ? AND daemon_generation = ?
             AND status IN ('accepted', 'running')`,
        )
        .run(
          status,
          now,
          highWater.event,
          highWater.usage,
          now,
          identity.invocationId,
          identity.attemptEpoch,
          identity.daemonGeneration,
        ).changes,
    );
    if (changes !== 1) invalidTransition(current.status, status);
    return this.require(identity);
  }

  crash(
    identity: ExecutionAttemptIdentity,
    errorCode: string,
    now = new Date().toISOString(),
    replacementGeneration = identity.daemonGeneration,
  ): ExecutionAttemptCrashResult {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#assertCurrent(identity);
      if (
        current.status !== "queued" &&
        current.status !== "accepted" &&
        current.status !== "running"
      ) {
        invalidTransition(current.status, "crashed");
      }
      const accepted = current.acceptedAt !== undefined;
      const acceptedCrashCount = accepted
        ? Number(
            (
              this.#db
                .prepare(
                  `SELECT COUNT(*) AS count
                   FROM execution_attempt_crashes
                   WHERE invocation_id = ? AND accepted = 1`,
                )
                .get(identity.invocationId) as { count: number }
            ).count,
          ) + 1
        : Number(
            (
              this.#db
                .prepare(
                  `SELECT COUNT(*) AS count
                   FROM execution_attempt_crashes
                   WHERE invocation_id = ? AND accepted = 1`,
                )
                .get(identity.invocationId) as { count: number }
            ).count,
          );
      const retryDelay = accepted
        ? EXECUTION_ATTEMPT_ACCEPTED_CRASH_DELAYS_MS[acceptedCrashCount - 1]
        : 0;
      const terminalFailed = accepted && retryDelay === undefined;
      const nextAttemptAt = terminalFailed
        ? undefined
        : new Date(Date.parse(now) + (retryDelay ?? 0)).toISOString();
      this.#db
        .prepare(
          `UPDATE execution_attempts
           SET status = ?, finished_at = ?, next_attempt_at = ?, updated_at = ?
           WHERE invocation_id = ? AND attempt_epoch = ? AND daemon_generation = ?`,
        )
        .run(
          terminalFailed ? "failed" : "crashed",
          now,
          nextAttemptAt ?? null,
          now,
          identity.invocationId,
          identity.attemptEpoch,
          identity.daemonGeneration,
        );
      this.#db
        .prepare(
          `INSERT INTO execution_attempt_crashes (
             invocation_id, attempt_epoch, daemon_generation, accepted,
             accepted_crash_ordinal, error_code, next_attempt_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.invocationId,
          identity.attemptEpoch,
          identity.daemonGeneration,
          accepted ? 1 : 0,
          accepted ? acceptedCrashCount : null,
          errorCode,
          nextAttemptAt ?? null,
          now,
        );

      let replacement: ExecutionAttemptRecord | undefined;
      let backoffEvent: ExecutionAttemptCrashResult["backoffEvent"];
      if (!terminalFailed) {
        const nextIdentity = {
          invocationId: identity.invocationId,
          attemptEpoch: identity.attemptEpoch + 1,
          daemonGeneration: replacementGeneration,
        };
        this.#insertQueued(
          nextIdentity,
          `${current.correlationId}:retry:${nextIdentity.attemptEpoch}`,
          now,
          nextAttemptAt,
        );
        replacement = this.require(nextIdentity);
        if (accepted && nextAttemptAt) {
          backoffEvent = {
            kind: "execution.attempt.retry_scheduled",
            attemptEpoch: identity.attemptEpoch,
            nextAttemptEpoch: replacement.attemptEpoch,
            acceptedCrashCount,
            nextAttemptAt,
          };
          this.#appendEvent(
            identity.invocationId,
            identity.attemptEpoch,
            backoffEvent.kind,
            backoffEvent,
            now,
          );
        }
      } else {
        this.#appendEvent(
          identity.invocationId,
          identity.attemptEpoch,
          "execution.attempt.retry_exhausted",
          { acceptedCrashCount, errorCode },
          now,
        );
      }
      this.#db.exec("COMMIT");
      const crashed = this.require(identity);
      return {
        crashed,
        ...(replacement ? { replacement } : {}),
        acceptedCrashCount,
        terminalFailed,
        ...(backoffEvent ? { backoffEvent } : {}),
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  recordOutput(
    identity: ExecutionAttemptIdentity,
    kind: "event" | "usage",
    outputSequence: number,
    payload: unknown,
    now = new Date().toISOString(),
  ): void {
    const current = this.#assertCurrent(identity);
    if (current.status !== "accepted" && current.status !== "running") {
      throw new ExecutionAttemptStateError(
        "execution_attempt_transition_invalid",
        `cannot persist execution attempt ${kind} while ${current.status}`,
      );
    }
    this.#appendEvent(
      identity.invocationId,
      identity.attemptEpoch,
      kind === "event" ? "execution.attempt.event_persisted" : "execution.attempt.usage_persisted",
      { outputSequence, payload },
      now,
    );
  }

  crashes(invocationId: string): ExecutionAttemptCrashRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM execution_attempt_crashes
           WHERE invocation_id = ?
           ORDER BY attempt_epoch`,
        )
        .all(invocationId) as unknown as CrashRow[]
    ).map(crashRecord);
  }

  events(invocationId: string): ExecutionAttemptStateEvent[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM execution_attempt_events
           WHERE invocation_id = ?
           ORDER BY sequence`,
        )
        .all(invocationId) as unknown as EventRow[]
    ).map((row) => ({
      invocationId: row.invocation_id,
      sequence: row.sequence,
      attemptEpoch: row.attempt_epoch,
      kind: row.kind,
      payload: parseEventPayload(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  #assertCurrent(identity: ExecutionAttemptIdentity): ExecutionAttemptRecord {
    const current = this.current(identity.invocationId);
    if (!current) {
      throw new ExecutionAttemptStateError(
        "execution_attempt_not_found",
        `execution attempt not found: ${identity.invocationId}`,
      );
    }
    if (
      current.attemptEpoch !== identity.attemptEpoch ||
      current.daemonGeneration !== identity.daemonGeneration
    ) {
      throw new ExecutionAttemptStateError(
        "execution_attempt_stale",
        "only the current execution attempt may mutate invocation attempt state",
      );
    }
    return current;
  }

  #transition(
    identity: ExecutionAttemptIdentity,
    from: ExecutionAttemptStatus,
    to: ExecutionAttemptStatus,
    now: string,
    timestampColumn: "accepted_at" | "started_at",
  ): ExecutionAttemptRecord {
    this.#assertCurrent(identity);
    const changes = Number(
      this.#db
        .prepare(
          `UPDATE execution_attempts
           SET status = ?, ${timestampColumn} = ?, updated_at = ?${
             to === "accepted" ? ", next_attempt_at = NULL" : ""
           }
           WHERE invocation_id = ? AND attempt_epoch = ? AND daemon_generation = ? AND status = ?`,
        )
        .run(
          to,
          now,
          now,
          identity.invocationId,
          identity.attemptEpoch,
          identity.daemonGeneration,
          from,
        ).changes,
    );
    if (changes !== 1) invalidTransition(this.require(identity).status, to);
    return this.require(identity);
  }

  #appendEvent(
    invocationId: string,
    attemptEpoch: number,
    kind: ExecutionAttemptStateEvent["kind"],
    payload: Record<string, unknown>,
    now: string,
  ): void {
    const next = (
      this.#db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM execution_attempt_events
           WHERE invocation_id = ?`,
        )
        .get(invocationId) as { sequence: number }
    ).sequence;
    this.#db
      .prepare(
        `INSERT INTO execution_attempt_events (
           invocation_id, sequence, attempt_epoch, kind, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(invocationId, next, attemptEpoch, kind, JSON.stringify(payload), now);
  }

  #insertQueued(
    identity: ExecutionAttemptIdentity,
    correlationId: string,
    now: string,
    nextAttemptAt: string | undefined,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO execution_attempts (
           invocation_id, attempt_epoch, daemon_generation, correlation_id, status,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        identity.invocationId,
        identity.attemptEpoch,
        identity.daemonGeneration,
        correlationId,
        nextAttemptAt ?? null,
        now,
        now,
      );
  }
}

function attemptRecord(row: AttemptRow): ExecutionAttemptRecord {
  return {
    invocationId: row.invocation_id,
    attemptEpoch: row.attempt_epoch,
    daemonGeneration: row.daemon_generation,
    correlationId: row.correlation_id,
    status: row.status,
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    eventHighWaterMark: row.event_high_water_mark,
    usageHighWaterMark: row.usage_high_water_mark,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function crashRecord(row: CrashRow): ExecutionAttemptCrashRecord {
  return {
    invocationId: row.invocation_id,
    attemptEpoch: row.attempt_epoch,
    daemonGeneration: row.daemon_generation,
    accepted: row.accepted === 1,
    ...(row.accepted_crash_ordinal === null
      ? {}
      : { acceptedCrashOrdinal: row.accepted_crash_ordinal }),
    errorCode: row.error_code,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    createdAt: row.created_at,
  };
}

function parseEventPayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Report malformed durable state through the daemon-private stable error contract below.
  }
  throw new ExecutionAttemptStateError(
    "execution_attempt_corrupt_state",
    "execution attempt event payload is not a JSON object",
  );
}

function invalidTransition(from: ExecutionAttemptStatus, to: ExecutionAttemptStatus): never {
  throw new ExecutionAttemptStateError(
    "execution_attempt_transition_invalid",
    `invalid execution attempt transition: ${from} -> ${to}`,
  );
}
