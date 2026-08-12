import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EXECUTION_FENCE_MISMATCH,
  EXECUTION_TERMINAL_IMMUTABLE,
  executionAttemptSchema,
  executionCheckpointSchema,
  executionProjectionSchema,
  executionRunSchema,
  type ExecutionAttemptWire,
  type ExecutionCheckpointWire,
  type ExecutionProjectionWire,
  type ExecutionRunWire,
} from "@zendev-lab/spark-protocol/execution-lifecycle";
import type { ExecutionPauseReason, ExecutionRunStatus } from "@zendev-lab/spark-core";

export interface CreateExecutionRunInput {
  runRef: string;
  invocationId?: string;
  taskRef?: string;
  projectRef?: string;
  workspaceId?: string;
  now?: string;
  daemonGeneration?: number;
}

export interface ClaimExecutionAttemptInput {
  runRef: string;
  daemonGeneration: number;
  now?: string;
  leaseExpiresAt?: string;
}

export interface ExecutionFence {
  daemonGeneration: number;
  stateRevision: number;
  leaseToken: string;
}

export interface ExecutionRunTransitionResult {
  run: ExecutionRunWire;
  attempt: ExecutionAttemptWire;
}

export class ExecutionLifecycleError extends Error {
  readonly code: typeof EXECUTION_FENCE_MISMATCH | typeof EXECUTION_TERMINAL_IMMUTABLE;

  constructor(
    code: typeof EXECUTION_FENCE_MISMATCH | typeof EXECUTION_TERMINAL_IMMUTABLE,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ExecutionLifecycleError";
    this.code = code;
  }
}

const terminalRunStatuses = new Set<ExecutionRunStatus>([
  "cancelled",
  "succeeded",
  "failed",
  "blocked",
  "recovery_required",
]);

export function executionRunRefForInvocation(invocationId: string): string {
  return `run:${createHash("sha256").update(`invocation:${invocationId}`).digest("hex").slice(0, 32)}`;
}

export class ExecutionRunStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createRun(input: CreateExecutionRunInput): ExecutionRunWire {
    const now = input.now ?? new Date().toISOString();
    const generation = input.daemonGeneration ?? 1;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO execution_runs
          (run_ref, invocation_id, task_ref, project_ref, workspace_id, status,
           state_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(
        input.runRef,
        input.invocationId ?? null,
        input.taskRef ?? null,
        input.projectRef ?? null,
        input.workspaceId ?? null,
        now,
        now,
      );
    const existing = this.get(input.runRef);
    if (!existing) throw new Error(`Execution run was not created: ${input.runRef}`);
    if (!this.getActiveAttempt(input.runRef)) {
      const attemptId = `attempt:${randomUUID().replaceAll("-", "")}`;
      const leaseToken = `lease:${randomUUID().replaceAll("-", "")}`;
      this.db
        .prepare(
          `INSERT INTO execution_run_attempts
            (attempt_id, run_ref, attempt_number, status, daemon_generation,
             state_revision, lease_token, checkpoint_revision, created_at)
           VALUES (?, ?, 1, 'queued', ?, 0, ?, 0, ?)`,
        )
        .run(attemptId, input.runRef, generation, leaseToken, now);
      this.db
        .prepare(
          `INSERT INTO execution_leases
            (lease_token, run_ref, attempt_id, daemon_generation, state_revision, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, 0, ?, NULL)`,
        )
        .run(leaseToken, input.runRef, attemptId, generation, now);
    }
    return this.require(input.runRef);
  }

  get(runRef: string): ExecutionRunWire | undefined {
    const row = this.db.prepare("SELECT * FROM execution_runs WHERE run_ref = ?").get(runRef) as
      | Record<string, unknown>
      | undefined;
    return row ? executionRunSchema.parse(rowFromRun(row)) : undefined;
  }

  getByInvocationId(invocationId: string): ExecutionRunWire | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_runs WHERE invocation_id = ?")
      .get(invocationId) as Record<string, unknown> | undefined;
    return row ? executionRunSchema.parse(rowFromRun(row)) : undefined;
  }

  require(runRef: string): ExecutionRunWire {
    const run = this.get(runRef);
    if (!run) throw new Error(`Execution run not found: ${runRef}`);
    return run;
  }

  getAttempt(attemptId: string): ExecutionAttemptWire | undefined {
    const row = this.db
      .prepare("SELECT * FROM execution_run_attempts WHERE attempt_id = ?")
      .get(attemptId) as Record<string, unknown> | undefined;
    return row ? executionAttemptSchema.parse(rowFromAttempt(row)) : undefined;
  }

  getActiveAttempt(runRef: string): ExecutionAttemptWire | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_run_attempts
         WHERE run_ref = ? AND status IN ('queued', 'running')
         ORDER BY attempt_number DESC LIMIT 1`,
      )
      .get(runRef) as Record<string, unknown> | undefined;
    return row ? executionAttemptSchema.parse(rowFromAttempt(row)) : undefined;
  }

  claimAttempt(input: ClaimExecutionAttemptInput): ExecutionRunTransitionResult {
    const now = input.now ?? new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.require(input.runRef);
      if (terminalRunStatuses.has(run.status)) {
        throw new ExecutionLifecycleError(
          EXECUTION_TERMINAL_IMMUTABLE,
          `cannot claim terminal run ${input.runRef} (${run.status})`,
        );
      }
      const existing = this.getActiveAttempt(input.runRef);
      if (existing) {
        if (existing.daemonGeneration !== input.daemonGeneration) {
          throw new ExecutionLifecycleError(
            EXECUTION_FENCE_MISMATCH,
            `active attempt belongs to generation ${existing.daemonGeneration}`,
          );
        }
        const changes = Number(
          this.db
            .prepare(
              `UPDATE execution_run_attempts
               SET status = 'running', started_at = COALESCE(started_at, ?), state_revision = state_revision + 1
               WHERE attempt_id = ? AND status IN ('queued', 'running')
                 AND daemon_generation = ?`,
            )
            .run(now, existing.attemptId, input.daemonGeneration).changes,
        );
        if (changes !== 1)
          throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "claim raced");
        this.db
          .prepare(
            `UPDATE execution_leases SET state_revision=?
             WHERE lease_token=? AND run_ref=? AND released_at IS NULL`,
          )
          .run(existing.stateRevision + 1, existing.leaseToken, input.runRef);
        this.db
          .prepare(
            `UPDATE execution_runs SET status = 'running', state_revision = state_revision + 1, updated_at = ?, started_at = COALESCE(started_at, ?)
             WHERE run_ref = ? AND status IN ('queued', 'paused', 'running')`,
          )
          .run(now, now, input.runRef);
        const result = this.readTransition(input.runRef, existing.attemptId);
        this.db.exec("COMMIT");
        return result;
      }
      throw new Error(`No active execution attempt for ${input.runRef}`);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pauseRun(
    runRef: string,
    fence: ExecutionFence,
    reason: ExecutionPauseReason,
    now = new Date().toISOString(),
  ): ExecutionRunWire {
    this.assertFence(runRef, fence);
    const run = this.require(runRef);
    if (terminalRunStatuses.has(run.status)) {
      throw new ExecutionLifecycleError(
        EXECUTION_TERMINAL_IMMUTABLE,
        `cannot pause ${run.status} run`,
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changes = Number(
        this.db
          .prepare(
            `UPDATE execution_runs SET status='paused', pause_reason=?, state_revision=state_revision+1, updated_at=?
             WHERE run_ref=? AND status IN ('queued','running','paused') AND state_revision=?`,
          )
          .run(reason, now, runRef, fence.stateRevision).changes,
      );
      if (changes !== 1)
        throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "pause fence mismatch");
      const attemptChanges = Number(
        this.db
          .prepare(
            `UPDATE execution_run_attempts SET status='paused', state_revision=state_revision+1
             WHERE attempt_id=? AND run_ref=? AND status IN ('queued','running','paused')
               AND daemon_generation=? AND state_revision=? AND lease_token=?`,
          )
          .run(
            fenceAttemptId(this.db, fence.leaseToken),
            runRef,
            fence.daemonGeneration,
            fence.stateRevision,
            fence.leaseToken,
          ).changes,
      );
      if (attemptChanges !== 1) {
        throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "pause attempt fence mismatch");
      }
      this.db
        .prepare(
          "UPDATE execution_leases SET released_at=? WHERE lease_token=? AND released_at IS NULL",
        )
        .run(now, fence.leaseToken);
      this.db.exec("COMMIT");
      return this.require(runRef);
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  resumePausedRun(
    runRef: string,
    daemonGeneration: number,
    now = new Date().toISOString(),
  ): ExecutionRunTransitionResult {
    const run = this.require(runRef);
    if (terminalRunStatuses.has(run.status)) {
      throw new ExecutionLifecycleError(
        EXECUTION_TERMINAL_IMMUTABLE,
        `cannot resume ${run.status} run`,
      );
    }
    const current = this.latestAttempt(runRef);
    if (!current || current.status !== "paused")
      throw new Error(`Execution run is not paused: ${runRef}`);
    const active = this.getActiveAttempt(runRef);
    if (active) return this.readTransition(runRef, active.attemptId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const attemptNumber = current.attempt + 1;
      const attemptId = `attempt:${randomUUID().replaceAll("-", "")}`;
      const leaseToken = `lease:${randomUUID().replaceAll("-", "")}`;
      const nextRevision = run.stateRevision + 1;
      this.db
        .prepare(
          `INSERT INTO execution_run_attempts
            (attempt_id, run_ref, attempt_number, parent_attempt_id, status, daemon_generation,
             state_revision, lease_token, checkpoint_revision, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          attemptId,
          runRef,
          attemptNumber,
          current.attemptId,
          daemonGeneration,
          nextRevision,
          leaseToken,
          current.checkpointRevision,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO execution_leases
            (lease_token, run_ref, attempt_id, daemon_generation, state_revision, acquired_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(leaseToken, runRef, attemptId, daemonGeneration, nextRevision, now);
      this.db
        .prepare(
          "UPDATE execution_runs SET status='queued', state_revision=?, pause_reason=NULL, updated_at=? WHERE run_ref=? AND state_revision=?",
        )
        .run(nextRevision, now, runRef, run.stateRevision);
      const result = this.readTransition(runRef, attemptId);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishRun(
    runRef: string,
    fence: ExecutionFence,
    status: Extract<
      ExecutionRunStatus,
      "cancelled" | "succeeded" | "failed" | "blocked" | "recovery_required"
    >,
    now = new Date().toISOString(),
  ): ExecutionRunWire {
    this.assertFence(runRef, fence);
    const run = this.require(runRef);
    if (terminalRunStatuses.has(run.status)) {
      if (run.status === status) return run;
      throw new ExecutionLifecycleError(
        EXECUTION_TERMINAL_IMMUTABLE,
        `run is already ${run.status}`,
      );
    }
    const changes = Number(
      this.db
        .prepare(
          `UPDATE execution_runs SET status=?, state_revision=state_revision+1, updated_at=?, finished_at=?
           WHERE run_ref=? AND state_revision=? AND status IN ('queued','running','paused','cancelling')`,
        )
        .run(status, now, now, runRef, fence.stateRevision).changes,
    );
    if (changes !== 1)
      throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "finish fence mismatch");
    this.db
      .prepare(
        "UPDATE execution_run_attempts SET status=?, finished_at=? WHERE attempt_id=? AND lease_token=?",
      )
      .run(status, now, fenceAttemptId(this.db, fence.leaseToken), fence.leaseToken);
    this.db
      .prepare(
        "UPDATE execution_leases SET released_at=? WHERE lease_token=? AND released_at IS NULL",
      )
      .run(now, fence.leaseToken);
    return this.require(runRef);
  }

  writeCheckpoint(
    runRef: string,
    fence: ExecutionFence,
    payload: unknown,
    now = new Date().toISOString(),
  ): ExecutionCheckpointWire {
    this.assertFence(runRef, fence);
    const attempt = this.getAttempt(fenceAttemptId(this.db, fence.leaseToken));
    if (
      !attempt ||
      attempt.runRef !== runRef ||
      attempt.leaseToken !== fence.leaseToken ||
      attempt.stateRevision !== fence.stateRevision
    ) {
      throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "checkpoint fence mismatch");
    }
    const revision = attempt.checkpointRevision + 1;
    const checkpointId = `checkpoint:${randomUUID().replaceAll("-", "")}`;
    const checkpoint = {
      checkpointId,
      runRef,
      attemptId: attempt.attemptId,
      revision,
      payload: payload as never,
      createdAt: now,
    };
    executionCheckpointSchema.parse(checkpoint);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO execution_checkpoints (checkpoint_id, run_ref, attempt_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(checkpointId, runRef, attempt.attemptId, revision, JSON.stringify(payload), now);
      const changes = Number(
        this.db
          .prepare(
            "UPDATE execution_run_attempts SET checkpoint_revision=? WHERE attempt_id=? AND state_revision=? AND daemon_generation=? AND lease_token=?",
          )
          .run(
            revision,
            attempt.attemptId,
            fence.stateRevision,
            fence.daemonGeneration,
            fence.leaseToken,
          ).changes,
      );
      if (changes !== 1)
        throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "checkpoint update raced");
      this.db.exec("COMMIT");
      return checkpoint;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  projection(runRef: string): ExecutionProjectionWire {
    const run = this.require(runRef);
    const activeAttempt = this.getActiveAttempt(runRef);
    return executionProjectionSchema.parse({
      runRef: run.runRef,
      ...(run.taskRef ? { taskRef: run.taskRef } : {}),
      ...(run.projectRef ? { projectRef: run.projectRef } : {}),
      ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
      status: run.status,
      stateRevision: run.stateRevision,
      ...(activeAttempt ? { activeAttempt } : {}),
      ...(run.pauseReason ? { pauseReason: run.pauseReason } : {}),
      ...(run.recoveryReason ? { recoveryReason: run.recoveryReason } : {}),
      updatedAt: run.updatedAt,
    });
  }

  private latestAttempt(runRef: string): ExecutionAttemptWire | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM execution_run_attempts WHERE run_ref=? ORDER BY attempt_number DESC LIMIT 1",
      )
      .get(runRef) as Record<string, unknown> | undefined;
    return row ? executionAttemptSchema.parse(rowFromAttempt(row)) : undefined;
  }

  private assertFence(runRef: string, fence: ExecutionFence): void {
    const run = this.require(runRef);
    const attempt = this.getAttempt(fenceAttemptId(this.db, fence.leaseToken));
    if (
      !attempt ||
      attempt.runRef !== runRef ||
      run.stateRevision !== fence.stateRevision ||
      attempt.daemonGeneration !== fence.daemonGeneration ||
      attempt.leaseToken !== fence.leaseToken
    ) {
      throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, `stale writer for ${runRef}`);
    }
  }

  private readTransition(runRef: string, attemptId: string): ExecutionRunTransitionResult {
    const run = this.require(runRef);
    const attempt = this.getAttempt(attemptId);
    if (!attempt) throw new Error(`Execution attempt not found: ${attemptId}`);
    return { run, attempt };
  }
}

function rowFromRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    runRef: row.run_ref,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.task_ref ? { taskRef: row.task_ref } : {}),
    ...(row.project_ref ? { projectRef: row.project_ref } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    status: row.status,
    stateRevision: row.state_revision,
    ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}),
    ...(row.recovery_reason ? { recoveryReason: row.recovery_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function rowFromAttempt(row: Record<string, unknown>): Record<string, unknown> {
  return {
    attemptId: row.attempt_id,
    runRef: row.run_ref,
    attempt: row.attempt_number,
    ...(row.parent_attempt_id ? { parentAttemptId: row.parent_attempt_id } : {}),
    status: row.status,
    daemonGeneration: row.daemon_generation,
    stateRevision: row.state_revision,
    leaseToken: row.lease_token,
    checkpointRevision: row.checkpoint_revision,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

function fenceAttemptId(db: DatabaseSync, leaseToken: string): string {
  const row = db
    .prepare("SELECT attempt_id FROM execution_leases WHERE lease_token=?")
    .get(leaseToken) as { attempt_id?: string } | undefined;
  if (!row?.attempt_id)
    throw new ExecutionLifecycleError(EXECUTION_FENCE_MISMATCH, "unknown lease token");
  return row.attempt_id;
}
