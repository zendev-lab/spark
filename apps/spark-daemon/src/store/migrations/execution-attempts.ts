import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

function prepareExecutionAttemptSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_attempts (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch > 0),
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation > 0),
      correlation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'crashed'
      )),
      accepted_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      next_attempt_at TEXT,
      event_high_water_mark INTEGER NOT NULL DEFAULT 0 CHECK (event_high_water_mark >= 0),
      usage_high_water_mark INTEGER NOT NULL DEFAULT 0 CHECK (usage_high_water_mark >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, attempt_epoch)
    );

    CREATE TABLE IF NOT EXISTS execution_attempt_crashes (
      invocation_id TEXT NOT NULL,
      attempt_epoch INTEGER NOT NULL,
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation > 0),
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      accepted_crash_ordinal INTEGER CHECK (
        accepted_crash_ordinal IS NULL OR accepted_crash_ordinal > 0
      ),
      error_code TEXT NOT NULL,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, attempt_epoch),
      FOREIGN KEY (invocation_id, attempt_epoch)
        REFERENCES execution_attempts(invocation_id, attempt_epoch) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS execution_attempt_events (
      invocation_id TEXT NOT NULL REFERENCES invocations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      attempt_epoch INTEGER NOT NULL CHECK (attempt_epoch > 0),
      kind TEXT NOT NULL CHECK (kind IN (
        'execution.attempt.retry_scheduled', 'execution.attempt.retry_exhausted',
        'execution.attempt.event_persisted', 'execution.attempt.usage_persisted'
      )),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (invocation_id, sequence),
      FOREIGN KEY (invocation_id, attempt_epoch)
        REFERENCES execution_attempts(invocation_id, attempt_epoch) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS execution_attempts_current_idx
      ON execution_attempts(invocation_id, attempt_epoch DESC);
    CREATE INDEX IF NOT EXISTS execution_attempts_retry_idx
      ON execution_attempts(status, next_attempt_at)
      WHERE status = 'queued' AND next_attempt_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS execution_attempt_crashes_history_idx
      ON execution_attempt_crashes(invocation_id, accepted, attempt_epoch);
    CREATE INDEX IF NOT EXISTS execution_attempt_events_order_idx
      ON execution_attempt_events(invocation_id, sequence);
  `);
}

export const executionAttemptMigrations = [
  {
    id: "execution-attempts.schema",
    owner: "execution-attempts",
    up: prepareExecutionAttemptSchema,
  },
] satisfies Migration[];
