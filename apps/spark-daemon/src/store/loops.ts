import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import {
  SPARK_PROTOCOL_VERSION,
  sparkLoopMutationResultSchema,
  sparkLoopViewSchema,
  type SparkLoopBinding,
  type SparkLoopContinuity,
  type SparkLoopListResult,
  type SparkLoopMutationResult,
  type SparkLoopScheduleRequest,
  type SparkLoopStatus,
  type SparkLoopView,
  type SparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import {
  SparkInvocationStore,
  isRetryableInvocationError,
  type CompleteSparkInvocationInput,
  type SparkInvocationRecord,
} from "./invocations.ts";
import type { SparkDaemonLoopTickTask } from "../core/types.ts";
import { SparkDaemonControlError } from "../control-error.ts";

export interface SparkLoopRoute {
  cwd: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
}

export interface StartSparkLoopInput extends SparkLoopRoute {
  loopId?: string;
  ownerSessionId: string;
  binding?: SparkLoopBinding;
  continuity?: SparkLoopContinuity;
  prompt: string;
  dueAt?: string;
  reason?: string;
  domainStateDigest?: string;
  wakePrompt?: string;
  initialStatus?: Extract<SparkLoopStatus, "scheduled" | "retry_wait">;
  initialAttempt?: number;
  cancellationReason?: string;
  now?: string;
}

export interface SparkLoopRecord extends SparkLoopView {
  prompt: string;
  wakePrompt?: string;
  route: SparkLoopRoute;
  domainStateDigest?: string;
  createdAt: string;
  updatedAt: string;
}

interface LoopRow {
  loop_id: string;
  owner_session_id: string;
  binding_json: string;
  continuity: SparkLoopContinuity;
  status: SparkLoopStatus;
  generation: number;
  cycle_step: SparkLoopRecord["cycleStep"] | null;
  due_at: string | null;
  attempt: number;
  last_invocation_id: string | null;
  reason: string | null;
  error: string | null;
  prompt: string;
  wake_prompt: string | null;
  route_json: string;
  domain_state_digest: string | null;
  created_at: string;
  updated_at: string;
}

const loopSelect = `SELECT loop_id, owner_session_id, binding_json, continuity, status,
  generation, cycle_step, due_at, attempt, last_invocation_id, reason, error, prompt, route_json,
  wake_prompt, domain_state_digest, created_at, updated_at
  FROM loop_wakeups`;

interface HiddenSessionGcRow {
  execution_session_id: string;
  session_path: string | null;
}

export interface SparkLoopHiddenSessionGcResult {
  examined: number;
  deleted: number;
  errors: Array<{ executionSessionId: string; message: string }>;
}

export class SparkLoopStore {
  readonly #db: DatabaseSync;
  readonly #invocations: SparkInvocationStore;

  constructor(db: DatabaseSync, invocations = new SparkInvocationStore(db)) {
    this.#db = db;
    this.#invocations = invocations;
  }

  start(input: StartSparkLoopInput): SparkLoopRecord {
    const now = input.now ?? new Date().toISOString();
    const ownerSessionId = required(input.ownerSessionId, "ownerSessionId");
    const prompt = required(input.prompt, "prompt");
    const route = normalizeRoute(input);
    const initialAttempt = Math.max(0, Math.trunc(input.initialAttempt ?? 0));
    const loopId = input.loopId?.trim() || `loop_${randomUUID().replaceAll("-", "")}`;
    const binding = input.binding ?? {};
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.get(loopId);
      if (existing?.lastInvocationId) {
        this.#invocations.requestCancellation(
          existing.lastInvocationId,
          input.cancellationReason ?? "loop restarted by loop.start",
          now,
        );
      }
      const superseded = this.#db
        .prepare(
          `${loopSelect}
           WHERE owner_session_id = ? AND loop_id <> ?
             AND status NOT IN ('completed', 'stopped')`,
        )
        .all(ownerSessionId, loopId) as unknown as LoopRow[];
      for (const row of superseded) {
        if (row.last_invocation_id) {
          this.#invocations.requestCancellation(
            row.last_invocation_id,
            "loop superseded by another active loop",
            now,
          );
        }
      }
      this.#db
        .prepare(
          `UPDATE loop_wakeups
           SET status = 'stopped', generation = generation + 1, cycle_step = NULL, due_at = NULL,
               reason = 'superseded by another active loop', updated_at = ?
           WHERE owner_session_id = ? AND loop_id <> ?
             AND status NOT IN ('completed', 'stopped')`,
        )
        .run(now, ownerSessionId, loopId);
      this.#db
        .prepare(
          `INSERT INTO loop_wakeups
            (loop_id, owner_session_id, binding_json, continuity, status, generation, cycle_step,
             due_at, attempt, reason, prompt, wake_prompt, route_json, domain_state_digest,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(loop_id) DO UPDATE SET
             owner_session_id = excluded.owner_session_id,
             binding_json = excluded.binding_json,
             continuity = excluded.continuity,
             status = excluded.status,
             generation = loop_wakeups.generation + 1,
             cycle_step = NULL,
             due_at = excluded.due_at,
             attempt = excluded.attempt,
             last_invocation_id = NULL,
             reason = excluded.reason,
             error = NULL,
             prompt = excluded.prompt,
             wake_prompt = excluded.wake_prompt,
             route_json = excluded.route_json,
             domain_state_digest = excluded.domain_state_digest,
             updated_at = excluded.updated_at`,
        )
        .run(
          loopId,
          ownerSessionId,
          JSON.stringify(binding),
          input.continuity ?? "session",
          input.initialStatus ?? "scheduled",
          input.dueAt ?? now,
          initialAttempt,
          input.reason ?? null,
          prompt,
          input.wakePrompt ?? null,
          JSON.stringify(route),
          input.domainStateDigest ?? null,
          now,
          now,
        );
      this.#db.exec("COMMIT");
      return this.require(loopId);
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  get(loopId: string): SparkLoopRecord | undefined {
    const row = this.#db.prepare(`${loopSelect} WHERE loop_id = ?`).get(loopId) as
      | LoopRow
      | undefined;
    return row ? loopRecord(row) : undefined;
  }

  require(loopId: string): SparkLoopRecord {
    const record = this.get(loopId);
    if (!record) {
      throw new SparkDaemonControlError("loop_not_found", `Loop was not found: ${loopId}`);
    }
    return record;
  }

  list(
    input: {
      loopId?: string;
      ownerSessionId?: string;
      includeTerminal?: boolean;
    } = {},
  ): SparkLoopRecord[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (input.loopId?.trim()) {
      conditions.push("loop_id = ?");
      values.push(input.loopId.trim());
    }
    if (input.ownerSessionId?.trim()) {
      conditions.push("owner_session_id = ?");
      values.push(input.ownerSessionId.trim());
    }
    if (!input.includeTerminal) conditions.push("status NOT IN ('completed', 'stopped')");
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.#db
        .prepare(`${loopSelect}${where} ORDER BY created_at, loop_id`)
        .all(...values) as unknown as LoopRow[]
    ).map(loopRecord);
  }

  listResult(
    input: {
      loopId?: string;
      ownerSessionId?: string;
      includeTerminal?: boolean;
    } = {},
  ): SparkLoopListResult {
    return {
      loops: this.list(input).map(loopView),
      observedAt: new Date().toISOString(),
    };
  }

  stop(
    loopId: string,
    reason?: string,
    now = new Date().toISOString(),
    options: { cancelInvocation?: boolean } = {},
  ): SparkLoopRecord {
    const current = this.require(loopId);
    if (current.lastInvocationId && options.cancelInvocation !== false) {
      this.#invocations.requestCancellation(
        current.lastInvocationId,
        reason ?? "loop stopped",
        now,
      );
    }
    return this.transition(loopId, "stopped", {
      reason,
      clearDue: true,
      incrementGeneration: true,
      now,
    });
  }

  restart(loopId: string, reason?: string, now = new Date().toISOString()): SparkLoopRecord {
    const current = this.require(loopId);
    return this.start({
      ...current.route,
      loopId,
      ownerSessionId: current.ownerSessionId,
      binding: current.binding,
      continuity: current.continuity,
      prompt: current.prompt,
      reason,
      dueAt: now,
      domainStateDigest: current.domainStateDigest,
      cancellationReason: reason ?? "loop restarted",
      now,
    });
  }

  wake(
    loopId: string,
    input: { prompt?: string; reason?: string; now?: string } = {},
  ): SparkLoopRecord {
    const current = this.require(loopId);
    const now = input.now ?? new Date().toISOString();
    return this.start({
      ...current.route,
      loopId,
      ownerSessionId: current.ownerSessionId,
      binding: current.binding,
      continuity: current.continuity,
      prompt: current.prompt,
      wakePrompt: input.prompt,
      reason: input.reason,
      dueAt: now,
      domainStateDigest: current.domainStateDigest,
      cancellationReason: input.reason ?? "loop manually woken",
      now,
    });
  }

  schedule(input: SparkLoopScheduleRequest, now = new Date().toISOString()): SparkLoopRecord {
    if (input.dueAt === undefined && input.delayMs === undefined) {
      throw new SparkDaemonControlError(
        "loop_schedule_invalid",
        "Loop schedule requires dueAt or delayMs.",
      );
    }
    const dueAt =
      input.dueAt ?? new Date(Date.parse(now) + Math.max(0, input.delayMs ?? 0)).toISOString();
    const changes = Number(
      this.#db
        .prepare(
          `UPDATE loop_wakeups
           SET generation = generation + 1, status = 'scheduled', due_at = ?,
               attempt = 0, reason = ?, error = NULL,
               prompt = COALESCE(?, prompt), updated_at = ?
           WHERE loop_id = ? AND generation = ? AND status = 'running'`,
        )
        .run(dueAt, input.reason ?? null, input.prompt ?? null, now, input.loopId, input.generation)
        .changes,
    );
    if (changes !== 1) {
      throw new SparkDaemonControlError(
        "loop_generation_conflict",
        `LOOP_GENERATION_CONFLICT: ${input.loopId} generation ${input.generation}`,
      );
    }
    return this.require(input.loopId);
  }

  /**
   * Atomically coalesce one due wake into one ordinary scheduler invocation.
   * A busy owner remains overdue; no second tick is accumulated.
   */
  materializeDue(now = new Date().toISOString()): SparkInvocationRecord | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.#db
        .prepare(
          `${loopSelect}
           WHERE status IN ('scheduled', 'retry_wait') AND due_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM invocations AS pending
               WHERE pending.session_id = loop_wakeups.owner_session_id
                 AND pending.status IN ('queued', 'running')
             )
           ORDER BY due_at, updated_at
           LIMIT 1`,
        )
        .get(now) as LoopRow | undefined;
      if (!candidate) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      const record = loopRecord(candidate);
      const task = loopTickTask(record);
      const invocation = this.#invocations.submit({
        workspaceBindingId: record.route.workspaceBindingId,
        sessionId: record.ownerSessionId,
        idempotencyKey: `loop.tick:${record.loopId}:${record.generation}`,
        prompt: task.prompt,
        task,
        sourceKind: "loop.tick",
        sourceRef: record.loopId,
        now,
      });
      const changes = Number(
        this.#db
          .prepare(
            `UPDATE loop_wakeups
             SET status = 'running', cycle_step = 'invoke', due_at = NULL, last_invocation_id = ?,
                 wake_prompt = NULL, updated_at = ?
             WHERE loop_id = ? AND generation = ? AND status IN ('scheduled', 'retry_wait')`,
          )
          .run(invocation.invocationId, now, record.loopId, record.generation).changes,
      );
      if (changes !== 1) throw new Error(`LOOP_MATERIALIZE_CONFLICT: ${record.loopId}`);
      if (record.continuity === "fresh") {
        const executionSessionId = loopExecutionSessionId(record);
        this.#db
          .prepare(
            `INSERT INTO loop_hidden_sessions
              (execution_session_id, loop_id, generation, invocation_id, status, created_at)
             VALUES (?, ?, ?, ?, 'active', ?)
             ON CONFLICT(execution_session_id) DO UPDATE SET
               invocation_id = excluded.invocation_id`,
          )
          .run(executionSessionId, record.loopId, record.generation, invocation.invocationId, now);
      }
      this.#db.exec("COMMIT");
      return invocation;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Commit invocation terminal state and the default loop transition in one
   * transaction. A schedule/stop that advanced generation wins the CAS.
   */
  completeTick(
    invocation: SparkInvocationRecord,
    task: SparkDaemonLoopTickTask,
    completion: CompleteSparkInvocationInput,
  ): { invocation: SparkInvocationRecord; loop: SparkLoopRecord } {
    const now = completion.now ?? new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const completed = this.#invocations.complete(invocation.invocationId, {
        ...completion,
        now,
      });
      if (task.continuity === "fresh" && task.executionSessionId) {
        this.#db
          .prepare(
            `UPDATE loop_hidden_sessions
             SET status = 'archived', session_path = COALESCE(?, session_path),
                 archived_at = ?, gc_after = ?
             WHERE execution_session_id = ? AND invocation_id = ?`,
          )
          .run(
            resultSessionPath(completion.result) ?? null,
            now,
            new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
            task.executionSessionId,
            invocation.invocationId,
          );
      }
      const current = this.require(task.loopId);
      if (
        current.generation === task.generation &&
        current.lastInvocationId === invocation.invocationId &&
        current.status === "running"
      ) {
        const transition = completionTransition(current, completion, now);
        this.#db
          .prepare(
            `UPDATE loop_wakeups
             SET generation = generation + 1, status = ?, cycle_step = NULL, due_at = ?, attempt = ?,
                 reason = ?, error = ?, updated_at = ?
             WHERE loop_id = ? AND generation = ? AND last_invocation_id = ? AND status = 'running'`,
          )
          .run(
            transition.status,
            transition.dueAt ?? null,
            transition.attempt,
            transition.reason ?? null,
            transition.error ?? null,
            now,
            task.loopId,
            task.generation,
            invocation.invocationId,
          );
      }
      this.#db.exec("COMMIT");
      return { invocation: completed, loop: this.require(task.loopId) };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Reconcile a terminal invocation left beside a running wake after a process
   * exit between executor settlement and loop transition.
   */
  reconcileTerminalTicks(now = new Date().toISOString()): SparkLoopRecord[] {
    const rows = this.#db
      .prepare(
        `${loopSelect}
         WHERE status = 'running' AND last_invocation_id IN (
           SELECT id FROM invocations WHERE status IN ('succeeded', 'failed', 'cancelled')
         )`,
      )
      .all() as unknown as LoopRow[];
    const repaired: SparkLoopRecord[] = [];
    for (const row of rows) {
      const record = loopRecord(row);
      const invocation = this.#invocations.require(record.lastInvocationId!);
      const completion: CompleteSparkInvocationInput = {
        status: invocation.status as CompleteSparkInvocationInput["status"],
        cancelReason: invocation.cancelReason,
        errorCode: invocation.errorCode,
        errorMessage: invocation.errorMessage,
        result: invocation.result,
        now,
      };
      const transition = completionTransition(record, completion, now);
      this.#db
        .prepare(
          `UPDATE loop_wakeups SET generation = generation + 1, status = ?, cycle_step = NULL, due_at = ?,
             attempt = ?, reason = ?, error = ?, updated_at = ?
           WHERE loop_id = ? AND generation = ? AND status = 'running'`,
        )
        .run(
          transition.status,
          transition.dueAt ?? null,
          transition.attempt,
          transition.reason ?? null,
          transition.error ?? null,
          now,
          record.loopId,
          record.generation,
        );
      repaired.push(this.require(record.loopId));
    }
    return repaired;
  }

  async gcHiddenSessions(
    now = new Date().toISOString(),
    removeSessionPath: (path: string) => Promise<void> = async (path) => {
      await rm(path, { force: true });
    },
  ): Promise<SparkLoopHiddenSessionGcResult> {
    const rows = this.#db
      .prepare(
        `SELECT execution_session_id, session_path
         FROM loop_hidden_sessions
         WHERE status = 'archived' AND gc_after IS NOT NULL AND gc_after <= ?
         ORDER BY gc_after, execution_session_id`,
      )
      .all(now) as unknown as HiddenSessionGcRow[];
    const result: SparkLoopHiddenSessionGcResult = {
      examined: rows.length,
      deleted: 0,
      errors: [],
    };
    for (const row of rows) {
      try {
        if (row.session_path) await removeSessionPath(row.session_path);
        result.deleted += Number(
          this.#db
            .prepare(
              `DELETE FROM loop_hidden_sessions
               WHERE execution_session_id = ? AND status = 'archived'
                 AND gc_after IS NOT NULL AND gc_after <= ?`,
            )
            .run(row.execution_session_id, now).changes,
        );
      } catch (error) {
        result.errors.push({
          executionSessionId: row.execution_session_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  mutationResult(record: SparkLoopRecord): SparkLoopMutationResult {
    return sparkLoopMutationResultSchema.parse({
      loop: loopView(record),
      observedAt: new Date().toISOString(),
    });
  }

  private transition(
    loopId: string,
    status: SparkLoopStatus,
    options: {
      reason?: string;
      dueAt?: string;
      prompt?: string;
      clearDue?: boolean;
      clearError?: boolean;
      resetAttempt?: boolean;
      incrementGeneration?: boolean;
      now?: string;
    },
  ): SparkLoopRecord {
    const now = options.now ?? new Date().toISOString();
    this.require(loopId);
    this.#db
      .prepare(
        `UPDATE loop_wakeups SET status = ?,
           generation = generation + ?,
           cycle_step = CASE WHEN ? IN ('scheduled', 'retry_wait', 'dormant', 'paused', 'blocked', 'completed', 'stopped') THEN NULL ELSE cycle_step END,
           due_at = ?,
           attempt = CASE WHEN ? THEN 0 ELSE attempt END,
           reason = ?,
           error = CASE WHEN ? THEN NULL ELSE error END,
           prompt = COALESCE(?, prompt),
           updated_at = ?
         WHERE loop_id = ?`,
      )
      .run(
        status,
        options.incrementGeneration ? 1 : 0,
        status,
        options.clearDue ? null : (options.dueAt ?? null),
        options.resetAttempt ? 1 : 0,
        options.reason ?? null,
        options.clearError ? 1 : 0,
        options.prompt ?? null,
        now,
        loopId,
      );
    return this.require(loopId);
  }
}

export function loopUpdateEvent(
  record: SparkLoopRecord | SparkLoopView,
  invocationId?: string,
): SparkDaemonEvent {
  const loop = "route" in record ? loopView(record) : sparkLoopViewSchema.parse(record);
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.view_event",
    source: "daemon",
    emittedAt: new Date().toISOString(),
    sessionId: loop.ownerSessionId,
    ...(invocationId ? { invocationId } : {}),
    view: {
      version: SPARK_PROTOCOL_VERSION,
      type: "loop.update",
      sessionId: loop.ownerSessionId,
      loop,
    },
    metadata: { stateOwnerSessionId: loop.ownerSessionId },
  };
}

function loopTickTask(record: SparkLoopRecord): SparkDaemonLoopTickTask {
  const executionSessionId =
    record.continuity === "fresh" ? loopExecutionSessionId(record) : record.ownerSessionId;
  return {
    type: "loop.tick",
    sessionId: record.ownerSessionId,
    loopId: record.loopId,
    binding: record.binding,
    ownerSessionId: record.ownerSessionId,
    generation: record.generation,
    continuity: record.continuity,
    prompt: record.wakePrompt ?? record.prompt,
    cwd: record.route.cwd,
    workspaceBindingId: record.route.workspaceBindingId,
    workspaceId: record.route.workspaceId,
    projectId: record.route.projectId,
    stateOwnerSessionId: record.ownerSessionId,
    ...(record.continuity === "fresh" ? { executionSessionId, reset: true } : {}),
  };
}

function loopExecutionSessionId(record: Pick<SparkLoopRecord, "loopId" | "generation">): string {
  const loopHash = createHash("sha256").update(record.loopId).digest("hex").slice(0, 24);
  return `loop_${loopHash}_${record.generation}`;
}

function resultSessionPath(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const value = (result as Record<string, unknown>).sessionPath;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function completionTransition(
  record: SparkLoopRecord,
  completion: CompleteSparkInvocationInput,
  now: string,
): {
  status: SparkLoopStatus;
  dueAt?: string;
  attempt: number;
  reason?: string;
  error?: string;
} {
  if (completion.status === "cancelled") {
    return {
      status: "blocked",
      attempt: record.attempt,
      reason: "manual abort",
      error: completion.cancelReason ?? "loop tick cancelled",
    };
  }
  if (completion.status === "failed") {
    const error = completion.errorMessage ?? completion.errorCode ?? "loop tick failed";
    if (!safeToRetry(completion.errorCode)) {
      return {
        status: "blocked",
        attempt: record.attempt,
        reason: "failure outcome is not safe to replay",
        error,
      };
    }
    const attempt = record.attempt + 1;
    const retryDelaysMs = [30_000, 60_000, 120_000] as const;
    return {
      status: "retry_wait",
      dueAt: new Date(
        Date.parse(now) +
          retryDelaysMs[Math.min(Math.max(0, attempt - 1), retryDelaysMs.length - 1)]!,
      ).toISOString(),
      attempt,
      reason: "safe transient failure",
      error,
    };
  }
  return {
    status: "dormant",
    attempt: 0,
    reason: "tick completed without an explicit loop.schedule",
  };
}

function safeToRetry(errorCode: string | undefined): boolean {
  return isRetryableInvocationError(errorCode);
}

function normalizeRoute(input: SparkLoopRoute): SparkLoopRoute {
  return {
    cwd: required(input.cwd, "cwd"),
    ...(input.workspaceBindingId?.trim()
      ? { workspaceBindingId: input.workspaceBindingId.trim() }
      : {}),
    ...(input.workspaceId?.trim() ? { workspaceId: input.workspaceId.trim() } : {}),
    ...(input.projectId?.trim() ? { projectId: input.projectId.trim() } : {}),
  };
}

function loopRecord(row: LoopRow): SparkLoopRecord {
  const route = parsePersistedLoopRoute(row);
  return {
    loopId: row.loop_id,
    ownerSessionId: row.owner_session_id,
    status: row.status,
    continuity: row.continuity,
    generation: Number(row.generation),
    ...(row.cycle_step ? { cycleStep: row.cycle_step } : {}),
    binding: parsePersistedLoopBinding(row),
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    attempt: Number(row.attempt),
    ...(row.last_invocation_id ? { lastInvocationId: row.last_invocation_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.error ? { error: row.error } : {}),
    prompt: row.prompt,
    ...(row.wake_prompt ? { wakePrompt: row.wake_prompt } : {}),
    route,
    ...(row.domain_state_digest ? { domainStateDigest: row.domain_state_digest } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePersistedLoopRoute(row: LoopRow): SparkLoopRoute {
  try {
    return JSON.parse(row.route_json) as SparkLoopRoute;
  } catch (error) {
    throw new Error(`Invalid persisted route for loop ${row.loop_id}`, { cause: error });
  }
}

function parsePersistedLoopBinding(row: LoopRow): SparkLoopBinding {
  try {
    const parsed = JSON.parse(row.binding_json) as SparkLoopBinding;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    throw new Error(`Invalid persisted binding for loop ${row.loop_id}`, { cause: error });
  }
}

function loopView(record: SparkLoopRecord): SparkLoopView {
  return sparkLoopViewSchema.parse({
    loopId: record.loopId,
    ownerSessionId: record.ownerSessionId,
    status: record.status,
    continuity: record.continuity,
    generation: record.generation,
    cycleStep: record.cycleStep,
    binding: record.binding,
    dueAt: record.dueAt,
    attempt: record.attempt,
    lastInvocationId: record.lastInvocationId,
    reason: record.reason,
    error: record.error,
  });
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`LOOP_INVALID: ${field} is required`);
  return normalized;
}
