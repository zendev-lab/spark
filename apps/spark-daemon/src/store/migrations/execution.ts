import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

export const executionMigrations = [
  {
    id: "execution.run-attempt-checkpoint-aggregate-v1",
    owner: "execution",
    up: migrateExecutionAggregate,
  },
] satisfies Migration[];

export function migrateExecutionAggregate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_runs (
      run_ref TEXT PRIMARY KEY CHECK (run_ref LIKE 'run:%'),
      invocation_id TEXT UNIQUE REFERENCES invocations(id) ON DELETE SET NULL,
      task_ref TEXT,
      project_ref TEXT,
      workspace_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'paused', 'cancelling', 'cancelled',
        'succeeded', 'failed', 'blocked', 'recovery_required'
      )),
      state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
      pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN (
        'session_shutdown', 'daemon_restart', 'launchagent_handoff',
        'process_interrupted', 'lease_expired', 'owner_detached'
      )),
      recovery_reason TEXT CHECK (recovery_reason IS NULL OR recovery_reason IN (
        'side_effect_uncertain', 'checkpoint_invalid', 'model_unavailable',
        'stale_generation', 'missing_owner', 'manual_reconcile'
      )),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_run_attempts (
      attempt_id TEXT PRIMARY KEY CHECK (attempt_id LIKE 'attempt:%'),
      run_ref TEXT NOT NULL REFERENCES execution_runs(run_ref) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      parent_attempt_id TEXT REFERENCES execution_run_attempts(attempt_id),
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'running', 'paused', 'succeeded', 'failed',
        'blocked', 'recovery_required', 'cancelled'
      )),
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation > 0),
      state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
      lease_token TEXT NOT NULL UNIQUE,
      checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (run_ref, attempt_number)
    );

    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      checkpoint_id TEXT PRIMARY KEY CHECK (checkpoint_id LIKE 'checkpoint:%'),
      run_ref TEXT NOT NULL REFERENCES execution_runs(run_ref) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES execution_run_attempts(attempt_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (attempt_id, revision)
    );

    CREATE TABLE IF NOT EXISTS execution_leases (
      lease_token TEXT PRIMARY KEY,
      run_ref TEXT NOT NULL REFERENCES execution_runs(run_ref) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES execution_run_attempts(attempt_id) ON DELETE CASCADE,
      daemon_generation INTEGER NOT NULL CHECK (daemon_generation > 0),
      state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
      acquired_at TEXT NOT NULL,
      expires_at TEXT,
      released_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS execution_run_attempts_one_active_idx
      ON execution_run_attempts(run_ref)
      WHERE status IN ('queued', 'running');
    CREATE INDEX IF NOT EXISTS execution_runs_status_updated_idx
      ON execution_runs(status, updated_at);
    CREATE INDEX IF NOT EXISTS execution_run_attempts_run_number_idx
      ON execution_run_attempts(run_ref, attempt_number);
    CREATE INDEX IF NOT EXISTS execution_checkpoints_run_revision_idx
      ON execution_checkpoints(run_ref, revision);
    CREATE INDEX IF NOT EXISTS execution_leases_active_idx
      ON execution_leases(run_ref, daemon_generation, expires_at)
      WHERE released_at IS NULL;
  `);
  backfillExecutionAggregate(db);
}

function backfillExecutionAggregate(db: DatabaseSync): void {
  if (!tableExists(db, "invocations")) return;
  const invocationColumns = tableColumns(db, "invocations");
  const optionalColumn = (name: string, fallback: string) =>
    invocationColumns.has(name) ? name : `${fallback} AS ${name}`;
  const invocations = db
    .prepare(
      `SELECT id,
              ${optionalColumn("workspace_binding_id", "NULL")},
              status,
              ${optionalColumn("task_json", "NULL")},
              ${optionalColumn("attempt_count", "0")},
              created_at,
              updated_at,
              ${optionalColumn("started_at", "NULL")},
              ${optionalColumn("finished_at", "NULL")}
       FROM invocations`,
    )
    .all() as unknown as InvocationBackfillRow[];
  const generation = persistedDaemonGeneration(db);
  const existingRunRef = db.prepare("SELECT run_ref FROM execution_runs WHERE invocation_id = ?");
  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO execution_runs
      (run_ref, invocation_id, task_ref, project_ref, workspace_id, status,
       state_revision, created_at, updated_at, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  const insertAttempt = db.prepare(`
    INSERT OR IGNORE INTO execution_run_attempts
      (attempt_id, run_ref, attempt_number, status, daemon_generation,
       state_revision, lease_token, checkpoint_revision, created_at, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
  `);
  const insertLease = db.prepare(`
    INSERT OR IGNORE INTO execution_leases
      (lease_token, run_ref, attempt_id, daemon_generation, state_revision,
       acquired_at, released_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of invocations) {
      const binding = taskBinding(row.task_json);
      const existing = existingRunRef.get(row.id) as { run_ref?: string } | undefined;
      if (existing?.run_ref) continue;
      const runRef = canonicalRunRef(binding.runRef) ?? deterministicRef("run", row.id);
      const attemptNumber = Math.max(1, row.attempt_count || 1);
      const attemptId = deterministicRef("attempt", `${row.id}:${attemptNumber}`);
      const leaseToken = deterministicRef("lease", `${row.id}:${attemptNumber}`);
      const runStatus = executionRunStatus(row.status);
      const attemptStatus = executionAttemptStatus(row.status);
      insertRun.run(
        runRef,
        row.id,
        binding.taskRef,
        binding.projectRef,
        row.workspace_binding_id ?? binding.workspaceId,
        runStatus,
        row.created_at,
        row.updated_at,
        row.started_at,
        row.finished_at,
      );
      insertAttempt.run(
        attemptId,
        runRef,
        attemptNumber,
        attemptStatus,
        generation,
        leaseToken,
        row.created_at,
        row.started_at,
        row.finished_at,
      );
      insertLease.run(
        leaseToken,
        runRef,
        attemptId,
        generation,
        row.started_at ?? row.created_at,
        isActiveInvocation(row.status) ? null : (row.finished_at ?? row.updated_at),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

interface InvocationBackfillRow {
  id: string;
  workspace_binding_id: string | null;
  status: string;
  task_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function taskBinding(raw: string | null): {
  runRef: string | null;
  taskRef: string | null;
  projectRef: string | null;
  workspaceId: string | null;
} {
  if (!raw) return { runRef: null, taskRef: null, projectRef: null, workspaceId: null };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      runRef: stringField(value, "runRef"),
      taskRef: stringField(value, "taskRef") ?? stringField(value, "task_ref"),
      projectRef: stringField(value, "projectRef") ?? stringField(value, "project_ref"),
      workspaceId: stringField(value, "workspaceId") ?? stringField(value, "workspace_id"),
    };
  } catch {
    return { runRef: null, taskRef: null, projectRef: null, workspaceId: null };
  }
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function canonicalRunRef(value: string | null): string | null {
  return value && /^run:[^:]+$/u.test(value) ? value : null;
}

function persistedDaemonGeneration(db: DatabaseSync): number {
  if (!tableExists(db, "daemon_meta")) return 1;
  const row = db.prepare("SELECT value FROM daemon_meta WHERE key = 'daemon_generation'").get() as
    | { value?: string }
    | undefined;
  const parsed = Number.parseInt(row?.value ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function executionRunStatus(status: string): string {
  if (status === "running" || status === "queued") return status;
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  return "failed";
}

function executionAttemptStatus(status: string): string {
  if (status === "running" || status === "queued") return status;
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  return "failed";
}

function isActiveInvocation(status: string): boolean {
  return status === "queued" || status === "running";
}

function deterministicRef(kind: "run" | "attempt" | "lease", identity: string): string {
  return `${kind}:${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
}
