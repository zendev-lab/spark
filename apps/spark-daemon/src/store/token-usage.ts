import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  sparkTokenUsageAggregateSchema,
  sparkTokenUsageByPersistenceSchema,
  sparkUsageExecutionSchema,
  type SparkReproUsageScope,
  type SparkTokenBreakdown,
  type SparkTokenUsageAggregate,
  type SparkTokenUsageByPersistence,
  type SparkTokenUsagePersistenceBucket,
  type SparkTokenUsagePersistenceRequest,
  type SparkTokenUsageSummaryRequest,
  type SparkUsageExecution,
  type SparkUsageExecutionKind,
  type SparkUsageExecutionPersistence,
} from "@zendev-lab/spark-protocol/token-usage";

interface InvocationUsageRow {
  id: string;
  session_id: string | null;
  parent_invocation_id: string | null;
  retry_of_invocation_id: string | null;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface UsageExecutionRow {
  execution_id: string;
  invocation_id: string;
  root_invocation_id: string;
  parent_execution_id: string | null;
  scope_kind: "repro";
  repro_id: string;
  kind: SparkUsageExecutionKind;
  kind_provisional: number;
  detail_kind: string | null;
  persistence: SparkUsageExecutionPersistence;
  session_id: string | null;
  run_ref: string | null;
  started_at: string;
  invocation_status?: string;
  finished_at?: string | null;
}

interface TokenUsageJoinRow {
  execution_id: string;
  execution_kind: SparkUsageExecutionKind;
  execution_persistence: SparkUsageExecutionPersistence;
  detail_kind: string | null;
  execution_status: SparkUsageExecution["status"];
  event_id: string | null;
  measurement: "reported" | "estimated" | "missing" | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
}

export interface RegisterUsageExecutionInput {
  invocationId: string;
  scope?: SparkReproUsageScope;
  executionId?: string;
  parentExecutionId?: string;
  kind?: SparkUsageExecutionKind;
  /** Scheduler-only placeholder classification, refined by the owning executor. */
  kindProvisional?: boolean;
  detailKind?: string;
  persistence?: SparkUsageExecutionPersistence;
  sessionId?: string;
  runRef?: string;
}

export interface RecordTurnCompleteUsageInput extends RegisterUsageExecutionInput {
  event: unknown;
  recordedAt?: string;
  /** @internal Stable identity for explicit legacy imports only. */
  eventIdOverride?: string;
}

export interface TokenUsageSummaryOptions {
  asOf?: string;
}

interface PersistedUsageExecution {
  executionId: string;
  invocationId: string;
  rootInvocationId: string;
  parentExecutionId?: string;
  scope: SparkReproUsageScope;
  kind: SparkUsageExecutionKind;
  kindProvisional: boolean;
  detailKind?: string;
  persistence: SparkUsageExecutionPersistence;
  sessionId?: string;
  runRef?: string;
  startedAt: string;
}

interface NormalizedUsage {
  breakdown: SparkTokenBreakdown;
  costUsd?: number;
}

/** Daemon-owned append-only accounting for provider response token usage. */
export class SparkTokenUsageStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Register one causally scoped execution. Unscoped invocations fail closed and
   * are not attributed merely because they share a session or time window.
   */
  registerExecution(input: RegisterUsageExecutionInput): PersistedUsageExecution | undefined {
    const invocation = this.invocation(input.invocationId);
    const executionId = input.executionId ?? input.invocationId;
    const existing = this.persistedExecution(executionId);
    if (existing) {
      this.assertExistingAttribution(existing, input, invocation);
      if (input.scope && input.scope.reproId !== existing.scope.reproId) {
        throw new Error(
          `Token usage execution ${executionId} is already scoped to ${existing.scope.reproId}`,
        );
      }
      return this.refineProvisionalExecution(existing, input);
    }

    const parentInvocationId =
      invocation.parent_invocation_id ?? invocation.retry_of_invocation_id ?? undefined;
    const inferredParentExecutionId = input.parentExecutionId ?? parentInvocationId;
    let parentExecution = inferredParentExecutionId
      ? this.persistedExecution(inferredParentExecutionId)
      : undefined;
    if (!parentExecution && parentInvocationId) {
      parentExecution = this.registerExecution({ invocationId: parentInvocationId });
    }
    if (input.scope && parentExecution && input.scope.reproId !== parentExecution.scope.reproId) {
      throw new Error(
        `Token usage execution ${executionId} scope does not match parent ${parentExecution.executionId}`,
      );
    }
    const scope = input.scope ?? parentExecution?.scope;
    if (!scope) return undefined;

    const execution: PersistedUsageExecution = {
      executionId,
      invocationId: input.invocationId,
      rootInvocationId: this.rootInvocationId(input.invocationId),
      ...(inferredParentExecutionId ? { parentExecutionId: inferredParentExecutionId } : {}),
      scope,
      kind: input.kind ?? "root_session",
      kindProvisional: input.kindProvisional === true,
      ...(input.detailKind ? { detailKind: input.detailKind } : {}),
      persistence: input.persistence ?? "persistent",
      sessionId: input.sessionId ?? invocation.session_id ?? undefined,
      ...(input.runRef ? { runRef: input.runRef } : {}),
      startedAt: invocation.created_at,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_executions
          (execution_id, invocation_id, root_invocation_id, parent_execution_id,
           scope_kind, repro_id, kind, kind_provisional, detail_kind, persistence,
           session_id, run_ref, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.executionId,
        execution.invocationId,
        execution.rootInvocationId,
        execution.parentExecutionId ?? null,
        execution.scope.kind,
        execution.scope.reproId,
        execution.kind,
        execution.kindProvisional ? 1 : 0,
        execution.detailKind ?? null,
        execution.persistence,
        execution.sessionId ?? null,
        execution.runRef ?? null,
        execution.startedAt,
      );
    const persisted = this.persistedExecution(executionId);
    if (persisted)
      this.recordExecutionLifecycle(persisted.executionId, "running", persisted.startedAt);
    return persisted;
  }

  /** Append a child/root terminal lifecycle fact without mutating its execution row. */
  settleExecution(
    executionId: string,
    status: Exclude<SparkUsageExecution["status"], "running">,
    observedAt = new Date().toISOString(),
  ): boolean {
    if (!this.persistedExecution(executionId)) {
      throw new Error(`Unknown token usage execution: ${executionId}`);
    }
    const terminal = this.db
      .prepare(
        `SELECT status
         FROM usage_execution_lifecycle_events
         WHERE execution_id = ? AND status <> 'running'
         LIMIT 1`,
      )
      .get(executionId) as { status: string } | undefined;
    if (terminal) {
      if (terminal.status === status) return false;
      throw new Error(
        `Token usage execution ${executionId} is already terminal with status ${terminal.status}`,
      );
    }
    return this.recordExecutionLifecycle(executionId, status, observedAt);
  }

  /** Public lifecycle projection; queued/unknown internal states never escape. */
  execution(executionId: string): SparkUsageExecution | undefined {
    const row = this.db
      .prepare(
        `SELECT e.*, i.status AS invocation_status, i.finished_at
         FROM usage_executions e
         JOIN invocations i ON i.id = e.invocation_id
         WHERE e.execution_id = ?`,
      )
      .get(executionId) as UsageExecutionRow | undefined;
    if (!row) return undefined;
    return sparkUsageExecutionSchema.parse({
      executionId: row.execution_id,
      invocationId: row.invocation_id,
      ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
      scope: { kind: row.scope_kind, reproId: row.repro_id },
      kind: row.kind,
      persistence: row.persistence,
      status: this.executionStatus(row.execution_id, row.invocation_status ?? "running"),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.run_ref ? { runRef: row.run_ref } : {}),
    });
  }

  recordTurnComplete(input: RecordTurnCompleteUsageInput): boolean {
    const event = turnCompleteEvent(input.event);
    if (!event) return false;
    const execution = this.registerExecution(input);
    if (!execution) return false;

    const recordedAt = input.recordedAt ?? new Date().toISOString();
    const message = event.message;
    const usageRecord = recognizedUsageRecord(message.usage);
    const normalizedCandidate = usageRecord ? normalizedUsage(usageRecord) : undefined;
    const normalized =
      normalizedCandidate?.breakdown.reasoningTokens !== undefined &&
      normalizedCandidate.breakdown.reasoningTokens > normalizedCandidate.breakdown.outputTokens
        ? undefined
        : normalizedCandidate;
    const measurement = normalized ? "reported" : "missing";
    const provider = nonEmptyString(message.provider);
    const model = nonEmptyString(message.model);
    const providerResponseId =
      nonEmptyString(message.providerResponseId) ??
      nonEmptyString(message.responseId) ??
      nonEmptyString(message.id);
    const providerTotalTokens = optionalInteger(usageRecord?.totalTokens);
    const observedAt = timestampIso(message.timestamp, recordedAt);
    const eventId =
      input.eventIdOverride ??
      tokenUsageEventId({
        invocationId: execution.invocationId,
        executionId: execution.executionId,
        observedAt,
        provider,
        model,
        providerResponseId,
        reason: event.reason,
        content: message.content,
        usage: normalized?.breakdown,
        measurement,
      });
    if (this.db.prepare("SELECT 1 FROM token_usage_receipts WHERE event_id = ?").get(eventId)) {
      return false;
    }
    const ordinalRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(response_ordinal), 0) + 1 AS ordinal
         FROM token_usage_receipts
         WHERE execution_id = ?`,
      )
      .get(execution.executionId) as { ordinal: number };
    const usage = normalized?.breakdown;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO token_usage_receipts
          (event_id, execution_id, invocation_id, response_ordinal, measurement, provider, model,
           provider_response_id, provider_total_tokens, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd,
           observed_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        execution.executionId,
        execution.invocationId,
        Number(ordinalRow.ordinal),
        measurement,
        provider ?? null,
        model ?? null,
        providerResponseId ?? null,
        providerTotalTokens ?? null,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.cacheWriteTokens ?? null,
        usage?.reasoningTokens ?? null,
        normalized?.costUsd ?? null,
        observedAt,
        recordedAt,
      );
    return Number(result.changes) > 0;
  }

  summarize(
    request: SparkTokenUsageSummaryRequest,
    options: TokenUsageSummaryOptions = {},
  ): SparkTokenUsageAggregate {
    return this.summarizeRows(
      request.scope,
      this.joinRows(request.scope),
      options.asOf ?? new Date().toISOString(),
    );
  }

  summarizeByPersistence(
    request: SparkTokenUsagePersistenceRequest,
    options: TokenUsageSummaryOptions = {},
  ): SparkTokenUsageByPersistence {
    const rows = this.joinRows(request.scope);
    const asOf = options.asOf ?? new Date().toISOString();
    const bucket = (persistence: SparkUsageExecutionPersistence) =>
      persistenceBucket(
        this.summarizeRows(
          request.scope,
          rows.filter((row) => row.execution_persistence === persistence),
          asOf,
        ),
      );
    return sparkTokenUsageByPersistenceSchema.parse({
      scope: request.scope,
      byPersistence: {
        anonymous: bucket("anonymous"),
        persistent: bucket("persistent"),
      },
      asOf,
    });
  }

  private summarizeRows(
    scope: SparkReproUsageScope,
    rows: TokenUsageJoinRow[],
    asOf: string,
  ): SparkTokenUsageAggregate {
    const executionRows = new Map<string, TokenUsageJoinRow>();
    const receiptRows: TokenUsageJoinRow[] = [];
    for (const row of rows) {
      executionRows.set(row.execution_id, row);
      if (row.event_id) receiptRows.push(row);
    }

    const reported = mutableBreakdown();
    const estimated = mutableBreakdown();
    const byExecutionKind = new Map<string, MutableBreakdown>();
    const byModel = new Map<string, MutableBreakdown>();
    let estimatedResponseCount = 0;
    let missingResponseCount = 0;
    let knownCostUsd = 0;
    let hasKnownCost = false;
    for (const row of receiptRows) {
      if (row.measurement === "reported") {
        addReceipt(reported, row);
      } else if (row.measurement === "estimated") {
        addReceipt(estimated, row);
        estimatedResponseCount += 1;
      } else {
        missingResponseCount += 1;
      }
      if (row.measurement !== "missing") {
        if (row.cost_usd !== null) {
          knownCostUsd += Number(row.cost_usd);
          hasKnownCost = true;
        }
        addReceiptToMap(byExecutionKind, row.execution_kind, row);
        addReceiptToMap(byModel, modelBreakdownKey(row), row);
      }
    }

    const measured = mergeBreakdowns(reported, estimated);
    const activeExecutionCount = [...executionRows.values()].filter(
      (row) => row.execution_status === "running",
    ).length;
    const measuredExecutionIds = new Set(receiptRows.map((row) => row.execution_id));
    const unmeteredChildExecutionCount = [...executionRows.values()].filter(
      (row) =>
        (row.execution_kind === "role_run" || row.execution_kind === "workflow_agent") &&
        row.execution_status !== "running" &&
        !measuredExecutionIds.has(row.execution_id),
    ).length;
    const unsupportedSources = [...executionRows.values()]
      .map((row) => row.detail_kind)
      .filter((detail): detail is string => detail?.startsWith("unsupported:") === true)
      .map((detail) => detail.slice("unsupported:".length));
    const coverageGapCount = [...executionRows.values()].filter(
      (row) =>
        row.detail_kind?.startsWith("unsupported:") === true ||
        ((row.execution_kind === "role_run" || row.execution_kind === "workflow_agent") &&
          row.execution_status !== "running" &&
          !measuredExecutionIds.has(row.execution_id)),
    ).length;
    const quality = aggregateQuality({
      responseCount: receiptRows.length,
      estimatedResponseCount,
      missingResponseCount,
      activeExecutionCount,
      unsupportedSources,
      unmeteredChildExecutionCount,
    });
    return sparkTokenUsageAggregateSchema.parse({
      scope,
      quality,
      totalTokens: measured.totalTokens,
      ...(hasKnownCost ? { knownCostUsd } : {}),
      activeExecutionCount,
      responseCount: receiptRows.length,
      estimatedResponseCount,
      missingResponseCount,
      coverageGapCount,
      reported: finalizedBreakdown(reported),
      estimated: finalizedBreakdown(estimated),
      byExecutionKind: finalizedBreakdownMap(byExecutionKind),
      byModel: finalizedBreakdownMap(byModel),
      asOf,
    });
  }

  receiptCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM token_usage_receipts").get() as {
      count: number;
    };
    return Number(row.count);
  }

  private rootInvocationId(invocationId: string): string {
    const seen = new Set<string>();
    let current = invocationId;
    while (!seen.has(current)) {
      seen.add(current);
      const row = this.invocation(current);
      const parent = row.parent_invocation_id ?? row.retry_of_invocation_id;
      if (!parent) return current;
      current = parent;
    }
    throw new Error(`Token usage invocation ancestry contains a cycle at ${current}`);
  }

  private invocation(invocationId: string): InvocationUsageRow {
    const row = this.db
      .prepare(
        `SELECT id, session_id, parent_invocation_id, retry_of_invocation_id,
                status, created_at, finished_at
         FROM invocations
         WHERE id = ?`,
      )
      .get(invocationId) as InvocationUsageRow | undefined;
    if (!row) throw new Error(`Unknown Spark invocation for token usage: ${invocationId}`);
    return row;
  }

  private persistedExecution(executionId: string): PersistedUsageExecution | undefined {
    const row = this.db
      .prepare("SELECT * FROM usage_executions WHERE execution_id = ?")
      .get(executionId) as UsageExecutionRow | undefined;
    if (!row) return undefined;
    return {
      executionId: row.execution_id,
      invocationId: row.invocation_id,
      rootInvocationId: row.root_invocation_id,
      ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
      scope: { kind: row.scope_kind, reproId: row.repro_id },
      kind: row.kind,
      kindProvisional: row.kind_provisional === 1,
      ...(row.detail_kind ? { detailKind: row.detail_kind } : {}),
      persistence: row.persistence,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.run_ref ? { runRef: row.run_ref } : {}),
      startedAt: row.started_at,
    };
  }

  private refineProvisionalExecution(
    existing: PersistedUsageExecution,
    input: RegisterUsageExecutionInput,
  ): PersistedUsageExecution {
    const requestedKind = input.kind;
    if (!requestedKind || requestedKind === existing.kind) {
      if (existing.kindProvisional && input.kindProvisional !== true && requestedKind) {
        this.db
          .prepare("UPDATE usage_executions SET kind_provisional = 0 WHERE execution_id = ?")
          .run(existing.executionId);
        return this.persistedExecution(existing.executionId) ?? existing;
      }
      return existing;
    }
    if (!existing.kindProvisional) {
      throw new Error(
        `Token usage execution ${existing.executionId} is already classified as ${existing.kind}`,
      );
    }
    if (input.kindProvisional === true || existing.kind !== "root_session") {
      throw new Error(
        `Token usage execution ${existing.executionId} provisional classification cannot change from ${existing.kind} to ${requestedKind}`,
      );
    }
    this.db
      .prepare(
        `UPDATE usage_executions
         SET kind = ?, kind_provisional = 0
         WHERE execution_id = ? AND kind_provisional = 1`,
      )
      .run(requestedKind, existing.executionId);
    return this.persistedExecution(existing.executionId) ?? existing;
  }

  private assertExistingAttribution(
    existing: PersistedUsageExecution,
    input: RegisterUsageExecutionInput,
    invocation: InvocationUsageRow,
  ): void {
    const requestedParentExecutionId =
      input.parentExecutionId ??
      invocation.parent_invocation_id ??
      invocation.retry_of_invocation_id ??
      undefined;
    const conflicts = [
      existing.invocationId !== input.invocationId ? "invocationId" : undefined,
      requestedParentExecutionId !== existing.parentExecutionId ? "parentExecutionId" : undefined,
      input.persistence !== undefined && input.persistence !== existing.persistence
        ? "persistence"
        : undefined,
      input.sessionId !== undefined && input.sessionId !== existing.sessionId
        ? "sessionId"
        : undefined,
      input.runRef !== undefined && input.runRef !== existing.runRef ? "runRef" : undefined,
      input.detailKind !== undefined && input.detailKind !== existing.detailKind
        ? "detailKind"
        : undefined,
    ].filter((field): field is string => field !== undefined);
    if (conflicts.length > 0) {
      throw new Error(
        `Token usage execution ${existing.executionId} has conflicting immutable attribution: ${conflicts.join(", ")}`,
      );
    }
  }

  private recordExecutionLifecycle(
    executionId: string,
    status: SparkUsageExecution["status"],
    observedAt: string,
  ): boolean {
    const eventId = `usage_lifecycle_${digest({ executionId, status })}`;
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_execution_lifecycle_events
          (event_id, execution_id, status, observed_at, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventId, executionId, status, observedAt, new Date().toISOString());
    return Number(result.changes) > 0;
  }

  private executionStatus(
    executionId: string,
    invocationStatus: string,
  ): SparkUsageExecution["status"] {
    const terminal = this.db
      .prepare(
        `SELECT status
         FROM usage_execution_lifecycle_events
         WHERE execution_id = ? AND status <> 'running'
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(executionId) as { status: SparkUsageExecution["status"] } | undefined;
    return terminal?.status ?? publicExecutionStatus(invocationStatus);
  }

  private joinRows(scope: SparkReproUsageScope): TokenUsageJoinRow[] {
    return this.db
      .prepare(
        `SELECT e.execution_id,
                e.kind AS execution_kind,
                e.persistence AS execution_persistence,
                e.detail_kind,
                COALESCE(
                  (
                    SELECT lifecycle.status
                    FROM usage_execution_lifecycle_events lifecycle
                    WHERE lifecycle.execution_id = e.execution_id
                      AND lifecycle.status <> 'running'
                    ORDER BY lifecycle.rowid DESC
                    LIMIT 1
                  ),
                  CASE i.status
                    WHEN 'succeeded' THEN 'complete'
                    WHEN 'failed' THEN 'failed'
                    WHEN 'cancelled' THEN 'cancelled'
                    ELSE 'running'
                  END
                ) AS execution_status,
                r.event_id,
                r.measurement,
                r.provider,
                r.model,
                r.input_tokens,
                r.output_tokens,
                r.cache_read_tokens,
                r.cache_write_tokens,
                r.reasoning_tokens,
                r.cost_usd
         FROM usage_executions e
         JOIN invocations i ON i.id = e.invocation_id
         LEFT JOIN token_usage_receipts r ON r.execution_id = e.execution_id
         WHERE e.scope_kind = ? AND e.repro_id = ?
         ORDER BY e.started_at ASC, r.response_ordinal ASC`,
      )
      .all(scope.kind, scope.reproId) as unknown as TokenUsageJoinRow[];
  }
}

function turnCompleteEvent(
  value: unknown,
): { message: Record<string, unknown>; reason?: unknown } | undefined {
  if (!isRecord(value) || value.type !== "turn_complete" || !isRecord(value.message)) {
    return undefined;
  }
  return { message: value.message, reason: value.reason };
}

function normalizedUsage(usage: Record<string, unknown>): NormalizedUsage {
  const inputTokens = tokenField(usage, "input", "inputTokens");
  const outputTokens = tokenField(usage, "output", "outputTokens");
  const cacheReadTokens = tokenField(usage, "cacheRead", "cacheReadTokens");
  const cacheWriteTokens = tokenField(usage, "cacheWrite", "cacheWriteTokens");
  const reasoningTokens = optionalTokenField(usage, "reasoning", "reasoningTokens");
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const directCost = optionalNumber(usage.costUsd) ?? optionalNumber(cost?.total);
  const componentCosts = [cost?.input, cost?.output, cost?.cacheRead, cost?.cacheWrite]
    .map(optionalNumber)
    .filter((value): value is number => value !== undefined);
  const costUsd =
    directCost ??
    (componentCosts.length > 0
      ? componentCosts.reduce((total, value) => total + value, 0)
      : undefined);
  return {
    breakdown: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    },
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function recognizedUsageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  for (const field of [
    "input",
    "inputTokens",
    "output",
    "outputTokens",
    "cacheRead",
    "cacheReadTokens",
    "cacheWrite",
    "cacheWriteTokens",
  ]) {
    if (optionalNumber(value[field]) !== undefined) return value;
  }
  return undefined;
}

function tokenField(usage: Record<string, unknown>, primary: string, fallback: string): number {
  return optionalTokenField(usage, primary, fallback) ?? 0;
}

function optionalTokenField(
  usage: Record<string, unknown>,
  primary: string,
  fallback: string,
): number | undefined {
  return optionalInteger(usage[primary]) ?? optionalInteger(usage[fallback]);
}

function optionalInteger(value: unknown): number | undefined {
  const number = optionalNumber(value);
  return number === undefined ? undefined : Math.trunc(number);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestampIso(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return fallback;
}

function tokenUsageEventId(input: Record<string, unknown>): string {
  const providerResponseId = input.providerResponseId;
  return `usage_${digest({
    invocationId: input.invocationId,
    executionId: input.executionId,
    // A provider/attempt id is the replay identity. Timestamps remain audit
    // facts and are used only when the provider supplies no stable identity.
    ...(providerResponseId ? { providerResponseId } : { observedAt: input.observedAt }),
    provider: input.provider,
    model: input.model,
    reason: input.reason,
    contentHash: digest(input.content),
    usage: input.usage,
    measurement: input.measurement,
  })}`;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

interface MutableBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  hasReasoningTokens: boolean;
}

function mutableBreakdown(): MutableBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    hasReasoningTokens: false,
  };
}

function addReceipt(target: MutableBreakdown, row: TokenUsageJoinRow): void {
  if (row.measurement === "missing" || row.measurement === null) return;
  target.inputTokens += Number(row.input_tokens ?? 0);
  target.outputTokens += Number(row.output_tokens ?? 0);
  target.cacheReadTokens += Number(row.cache_read_tokens ?? 0);
  target.cacheWriteTokens += Number(row.cache_write_tokens ?? 0);
  if (row.reasoning_tokens !== null) {
    target.reasoningTokens += Number(row.reasoning_tokens);
    target.hasReasoningTokens = true;
  }
}

function mergeBreakdowns(left: MutableBreakdown, right: MutableBreakdown): SparkTokenBreakdown {
  return finalizedBreakdown({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    hasReasoningTokens: left.hasReasoningTokens || right.hasReasoningTokens,
  });
}

function finalizedBreakdown(value: MutableBreakdown): SparkTokenBreakdown {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    ...(value.hasReasoningTokens ? { reasoningTokens: value.reasoningTokens } : {}),
    totalTokens:
      value.inputTokens + value.outputTokens + value.cacheReadTokens + value.cacheWriteTokens,
  };
}

function addReceiptToMap(
  target: Map<string, MutableBreakdown>,
  key: string,
  row: TokenUsageJoinRow,
): void {
  const current = target.get(key) ?? mutableBreakdown();
  addReceipt(current, row);
  target.set(key, current);
}

function finalizedBreakdownMap(
  source: Map<string, MutableBreakdown>,
): Record<string, SparkTokenBreakdown> {
  return Object.fromEntries(
    [...source.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, finalizedBreakdown(entry)]),
  );
}

function persistenceBucket(aggregate: SparkTokenUsageAggregate): SparkTokenUsagePersistenceBucket {
  return {
    quality: aggregate.quality,
    totalTokens: aggregate.totalTokens,
    activeExecutionCount: aggregate.activeExecutionCount,
    responseCount: aggregate.responseCount,
    ...(aggregate.estimatedResponseCount === undefined
      ? {}
      : { estimatedResponseCount: aggregate.estimatedResponseCount }),
    missingResponseCount: aggregate.missingResponseCount,
    ...(aggregate.coverageGapCount === undefined
      ? {}
      : { coverageGapCount: aggregate.coverageGapCount }),
    reported: aggregate.reported,
    estimated: aggregate.estimated,
  };
}

function modelBreakdownKey(row: TokenUsageJoinRow): string {
  if (row.provider && row.model) return `${row.provider}/${row.model}`;
  return row.model ?? row.provider ?? "unknown";
}

function aggregateQuality(input: {
  responseCount: number;
  estimatedResponseCount: number;
  missingResponseCount: number;
  activeExecutionCount: number;
  unsupportedSources: readonly string[];
  unmeteredChildExecutionCount: number;
}): SparkTokenUsageAggregate["quality"] {
  if (
    input.activeExecutionCount > 0 ||
    input.missingResponseCount > 0 ||
    input.unsupportedSources.length > 0 ||
    input.unmeteredChildExecutionCount > 0
  ) {
    return "partial";
  }
  if (input.responseCount === 0) return "unknown";
  return input.estimatedResponseCount > 0 ? "estimated" : "exact";
}

function publicExecutionStatus(status: string): SparkUsageExecution["status"] {
  if (status === "succeeded") return "complete";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
