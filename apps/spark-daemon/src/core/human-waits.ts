import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createId,
  hasNonEmptySparkHumanAnswer,
  sparkEvidenceAnswerEventSchema,
  type HumanRequestCreatedPayload,
  type SparkDirectAnswerProvenance,
  type SparkEvidenceAnswerEvent,
  type SparkEvidenceRequestBinding,
  type SparkHumanInteractionDeliveryOutcome,
  type SparkHumanInteractionStatus,
} from "@zendev-lab/spark-protocol";

type JsonObject = Record<string, unknown>;
type HumanQuestion = HumanRequestCreatedPayload["questions"][number];
type HumanRequestKind = HumanRequestCreatedPayload["kind"];
type HumanWaitStatus = SparkHumanInteractionStatus;

export type SparkDaemonHumanWaitDelivery = "blocking" | "async";

export interface SparkDaemonHumanWaitInput {
  humanRequestId?: string;
  interactionRequestId?: string;
  sessionId?: string;
  invocationId?: string;
  workspaceBindingId?: string;
  workspaceId?: string;
  projectId?: string;
  toolCallId?: string;
  delivery?: SparkDaemonHumanWaitDelivery;
  evidenceRequest?: SparkEvidenceRequestBinding;
  kind: HumanRequestKind;
  title: string;
  prompt: string;
  questions?: HumanQuestion[];
  context?: JsonObject;
  contextArtifactRefs?: string[];
}

export interface SparkDaemonHumanWaitRecord extends Required<
  Omit<SparkDaemonHumanWaitInput, "humanRequestId" | "evidenceRequest">
> {
  humanRequestId: string;
  evidenceRequest?: SparkEvidenceRequestBinding;
  status: HumanWaitStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SparkDaemonHumanWaitResponse {
  humanRequestId: string;
  humanResponseId: string;
  status: Exclude<HumanWaitStatus, "pending">;
  provenance: SparkDirectAnswerProvenance;
  answers: JsonObject;
  responseArtifactRefs: string[];
  answerEventId?: string;
  deliveredAt: string;
}

export interface SparkDaemonHumanWaitRegistration {
  wait: SparkDaemonHumanWaitRecord;
  created: boolean;
  /** Defined only for blocking waits. Async asks intentionally own no suspended tool promise. */
  response?: Promise<SparkDaemonHumanWaitResponse>;
}

export type SparkDaemonHumanWaitDeliveryOutcome = SparkHumanInteractionDeliveryOutcome;

export interface SparkDaemonHumanWaitDeliveryResult {
  outcome: SparkDaemonHumanWaitDeliveryOutcome;
  retryable: boolean;
  returnedToTool: boolean;
  message: string;
  winnerResponseId?: string;
  wait?: SparkDaemonHumanWaitRecord;
  response?: SparkDaemonHumanWaitResponse;
  answerEvent?: SparkEvidenceAnswerEvent;
}

export interface SparkDaemonHumanWaitCallback {
  wait: SparkDaemonHumanWaitRecord;
  questionId: string;
  value: string;
  label: string;
}

export interface SparkDaemonHumanWaitOutboxInput {
  messageId: string;
  kind: "human.request.created" | "human.response.recorded";
  envelope: JsonObject;
}

export type SparkDaemonHumanWaitOutboxEntry = SparkDaemonHumanWaitOutboxInput;

export interface SparkDaemonHumanWaitOutboxRoute {
  runtimeId: string;
  serverUrl: string | null;
}

export interface SparkDaemonHumanWaitInteractionLookup {
  interactionRequestId: string;
  sessionId?: string;
  invocationId?: string;
}

export class SparkDaemonHumanWaitLookupError extends Error {
  override readonly name = "SparkDaemonHumanWaitLookupError";
  readonly code: "human_interaction_not_found" | "human_interaction_ambiguous";

  constructor(
    code: "human_interaction_not_found" | "human_interaction_ambiguous",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

interface ActiveHumanWait {
  wait: SparkDaemonHumanWaitRecord;
  resolve(response: SparkDaemonHumanWaitResponse): void;
}

interface HumanWaitRow {
  requestJson: string;
  responseJson: string | null;
  acceptedResponseId: string | null;
  status: HumanWaitStatus;
  updatedAt: string;
}

interface HumanAnswerEventRow {
  eventJson: string;
}

/**
 * Daemon-owned human interaction state.
 *
 * The SQLite row is authoritative. The in-memory map is only the continuation
 * for a currently blocking tool call, so async asks and daemon restarts remain
 * explicit instead of pretending a JavaScript Promise is durable.
 */
export class SparkDaemonHumanWaitRegistry {
  private readonly active = new Map<string, ActiveHumanWait>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  register(
    input: SparkDaemonHumanWaitInput,
    outbox?: SparkDaemonHumanWaitOutboxInput,
  ): SparkDaemonHumanWaitRegistration {
    if (input.evidenceRequest) {
      if ((input.delivery ?? "blocking") !== "async" || !input.interactionRequestId?.trim()) {
        throw new Error("evidence-bound human interaction requires async delivery and correlation");
      }
    }
    if (input.evidenceRequest && input.interactionRequestId) {
      const existing = this.readByEvidenceInteraction(input.interactionRequestId);
      if (existing) {
        if (JSON.stringify(existing.evidenceRequest) !== JSON.stringify(input.evidenceRequest)) {
          throw new Error(
            `async evidence interaction ${input.interactionRequestId} was retried with a different binding`,
          );
        }
        return { wait: existing, created: false };
      }
    }
    if (input.evidenceRequest) {
      requireEvidenceOwnerQuestion(input.evidenceRequest, input.questions ?? []);
    }
    const now = new Date().toISOString();
    const wait: SparkDaemonHumanWaitRecord = {
      humanRequestId: input.humanRequestId ?? createId("hreq"),
      interactionRequestId: input.interactionRequestId ?? "",
      sessionId: input.sessionId ?? "",
      invocationId: input.invocationId ?? "",
      workspaceBindingId: input.workspaceBindingId ?? "",
      workspaceId: input.workspaceId ?? "",
      projectId: input.projectId ?? "",
      toolCallId: input.toolCallId ?? "",
      delivery: input.delivery ?? "blocking",
      ...(input.evidenceRequest ? { evidenceRequest: input.evidenceRequest } : {}),
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      questions: input.questions ?? [],
      context: input.context ?? {},
      contextArtifactRefs: input.contextArtifactRefs ?? [],
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO daemon_human_waits
            (human_request_id, interaction_request_id, evidence_request_json, invocation_id,
             workspace_binding_id, workspace_id, project_id, tool_call_id, kind, status,
             request_json, response_json, accepted_response_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          wait.humanRequestId,
          nullable(wait.interactionRequestId),
          wait.evidenceRequest ? JSON.stringify(wait.evidenceRequest) : null,
          nullable(wait.invocationId),
          nullable(wait.workspaceBindingId),
          nullable(wait.workspaceId),
          nullable(wait.projectId),
          nullable(wait.toolCallId),
          wait.kind,
          JSON.stringify(wait),
          now,
          now,
        );
      if (outbox) {
        this.db
          .prepare(
            `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(outbox.messageId, outbox.kind, JSON.stringify(outbox.envelope), now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (wait.delivery === "async") return { wait, created: true };

    let resolve!: (response: SparkDaemonHumanWaitResponse) => void;
    const response = new Promise<SparkDaemonHumanWaitResponse>((done) => {
      resolve = done;
    });
    this.active.set(wait.humanRequestId, { wait, resolve });
    return { wait, response, created: true };
  }

  deliver(
    input: {
      humanRequestId?: string;
      humanResponseId?: string;
      status: Exclude<HumanWaitStatus, "pending">;
      provenance?: SparkDirectAnswerProvenance;
      answers?: JsonObject;
      responseArtifactRefs?: string[];
    },
    outbox?: SparkDaemonHumanWaitOutboxInput,
  ): SparkDaemonHumanWaitDeliveryResult {
    if (!input.humanRequestId) {
      return unknownRequest(
        "Human response did not include a humanRequestId for a daemon-owned wait.",
      );
    }
    const existing = this.readRow(input.humanRequestId);
    if (!existing) {
      return unknownRequest("No daemon-owned human wait matched this response.");
    }

    const humanResponseId = input.humanResponseId ?? createId("hres");
    const provenance = input.provenance ?? "system";
    const acceptedAt = new Date().toISOString();
    const answerEvent = createEvidenceAnswerEvent(existing.wait, {
      humanResponseId,
      status: input.status,
      provenance,
      answers: input.answers ?? {},
      acceptedAt,
    });
    const response: SparkDaemonHumanWaitResponse = {
      humanRequestId: input.humanRequestId,
      humanResponseId,
      status: input.status,
      provenance,
      answers: input.answers ?? {},
      responseArtifactRefs: input.responseArtifactRefs ?? [],
      ...(answerEvent ? { answerEventId: answerEvent.answerEventId } : {}),
      deliveredAt: acceptedAt,
    };
    let updateChanges = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      updateChanges = Number(
        this.db
          .prepare(
            `UPDATE daemon_human_waits
             SET status = ?, response_json = ?, accepted_response_id = ?, updated_at = ?
             WHERE human_request_id = ? AND status = 'pending'`,
          )
          .run(
            response.status,
            JSON.stringify(response),
            humanResponseId,
            response.deliveredAt,
            response.humanRequestId,
          ).changes,
      );
      if (updateChanges === 1 && answerEvent) {
        this.db
          .prepare(
            `INSERT INTO daemon_human_answer_events
              (answer_event_id, human_request_id, interaction_request_id, human_response_id,
               event_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            answerEvent.answerEventId,
            answerEvent.humanRequestId,
            answerEvent.interactionRequestId,
            answerEvent.humanResponseId,
            JSON.stringify(answerEvent),
            answerEvent.acceptedAt,
          );
      }
      if (updateChanges === 1 && outbox) {
        this.db
          .prepare(
            `INSERT INTO outbox (id, kind, payload_json, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            outbox.messageId,
            outbox.kind,
            JSON.stringify(outbox.envelope),
            response.deliveredAt,
            response.deliveredAt,
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (updateChanges === 1) {
      const active = this.active.get(input.humanRequestId);
      if (active) {
        this.active.delete(input.humanRequestId);
        active.resolve(response);
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: true,
          message: "Returned human response to the daemon-owned wait.",
          winnerResponseId: humanResponseId,
          wait: existing.wait,
          response,
          ...(answerEvent ? { answerEvent } : {}),
        };
      }
      if (existing.wait.delivery === "async") {
        return {
          outcome: "accepted",
          retryable: false,
          returnedToTool: false,
          message: "Recorded human response for the async daemon-owned ask.",
          winnerResponseId: humanResponseId,
          wait: existing.wait,
          response,
          ...(answerEvent ? { answerEvent } : {}),
        };
      }
      return {
        outcome: "orphaned",
        retryable: false,
        returnedToTool: false,
        message: "Recorded human response, but the blocking daemon wait is no longer attached.",
        winnerResponseId: humanResponseId,
        wait: existing.wait,
        response,
        ...(answerEvent ? { answerEvent } : {}),
      };
    }

    const settled = this.readRow(input.humanRequestId);
    if (!settled) return unknownRequest("Daemon-owned human wait disappeared during delivery.");
    if (settled.acceptedResponseId === humanResponseId) {
      return {
        outcome: "replayed",
        retryable: false,
        returnedToTool: false,
        message: "Human response was already accepted.",
        winnerResponseId: humanResponseId,
        wait: settled.wait,
        ...(settled.response ? { response: settled.response } : {}),
        ...(settled.answerEvent ? { answerEvent: settled.answerEvent } : {}),
      };
    }
    return {
      outcome: "already_resolved",
      retryable: false,
      returnedToTool: false,
      message: "Human request was already resolved by another response.",
      ...(settled.acceptedResponseId ? { winnerResponseId: settled.acceptedResponseId } : {}),
      wait: settled.wait,
      ...(settled.response ? { response: settled.response } : {}),
      ...(settled.answerEvent ? { answerEvent: settled.answerEvent } : {}),
    };
  }

  get(humanRequestId: string): SparkDaemonHumanWaitRecord | null {
    return this.readRow(humanRequestId)?.wait ?? null;
  }

  listPending(): SparkDaemonHumanWaitRecord[] {
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         WHERE status = 'pending'
         ORDER BY created_at`,
      )
      .all() as unknown as HumanWaitRow[];
    return rows.map((row) => parseHumanWaitRow(row).wait);
  }

  listEvidenceAnswerEvents(humanRequestId?: string): SparkEvidenceAnswerEvent[] {
    return this.readEvidenceAnswerEvents(
      humanRequestId ? "WHERE human_request_id = ?" : "",
      humanRequestId ? [humanRequestId] : [],
    );
  }

  listPendingEvidenceAnswerEvents(): SparkEvidenceAnswerEvent[] {
    return this.readEvidenceAnswerEvents("WHERE wake_completed_at IS NULL", []);
  }

  isEvidenceAnswerEventWakePending(answerEventId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM daemon_human_answer_events
           WHERE answer_event_id = ? AND wake_completed_at IS NULL`,
        )
        .get(answerEventId),
    );
  }

  markEvidenceAnswerEventWakeCompleted(
    answerEventId: string,
    completedAt = new Date().toISOString(),
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE daemon_human_answer_events
           SET wake_completed_at = ?
           WHERE answer_event_id = ? AND wake_completed_at IS NULL`,
        )
        .run(completedAt, answerEventId).changes === 1
    );
  }

  private readEvidenceAnswerEvents(where: string, values: string[]): SparkEvidenceAnswerEvent[] {
    const rows = this.db
      .prepare(
        `SELECT event_json AS eventJson
         FROM daemon_human_answer_events
         ${where}
         ORDER BY created_at, answer_event_id`,
      )
      .all(...values) as unknown as HumanAnswerEventRow[];
    return rows.map((row) => sparkEvidenceAnswerEventSchema.parse(JSON.parse(row.eventJson)));
  }

  requireUniquePendingInteraction(
    input: SparkDaemonHumanWaitInteractionLookup,
  ): SparkDaemonHumanWaitRecord {
    return requireUniqueInteractionMatch(this.listPending(), input, "pending ");
  }

  /** Resolve a stable response retry after the wait may already have settled. */
  requireUniqueInteraction(
    input: SparkDaemonHumanWaitInteractionLookup,
  ): SparkDaemonHumanWaitRecord {
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         ORDER BY created_at`,
      )
      .all() as unknown as HumanWaitRow[];
    return requireUniqueInteractionMatch(
      rows.map((row) => parseHumanWaitRow(row).wait),
      input,
      "",
    );
  }

  hasActive(humanRequestId: string): boolean {
    return this.active.has(humanRequestId);
  }

  /** Resolve an opaque channel callback token without trusting any answer data from the client. */
  findCallback(token: string): SparkDaemonHumanWaitCallback | null {
    if (!token) return null;
    const rows = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         ORDER BY created_at DESC`,
      )
      .all() as unknown as HumanWaitRow[];
    for (const row of rows) {
      const parsed = parseHumanWaitRow(row);
      const callbacks = recordValue(parsed.wait.context.channelCallbacks);
      const selection = callbacks ? recordValue(callbacks[token]) : undefined;
      const questionId = stringValue(selection?.questionId);
      const value = stringValue(selection?.value);
      const label = stringValue(selection?.label);
      if (questionId && value && label) {
        return { wait: parsed.wait, questionId, value, label };
      }
    }
    return null;
  }

  listPendingOutbox(limit = 100): SparkDaemonHumanWaitOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id AS messageId, kind, payload_json AS payloadJson
         FROM outbox
         WHERE kind IN ('human.request.created', 'human.response.recorded')
           AND status != 'acked'
         ORDER BY created_at
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      messageId: string;
      kind: "human.request.created" | "human.response.recorded";
      payloadJson: string;
    }>;
    return rows.map((row) => ({
      messageId: row.messageId,
      kind: row.kind,
      envelope: JSON.parse(row.payloadJson) as JsonObject,
    }));
  }

  /**
   * Return only outbox entries owned by one runtime uplink. Route filtering is
   * part of the SQL query so a busy Hub cannot consume the shared LIMIT and
   * starve another Hub's pending entries.
   */
  listPendingOutboxForRoute(
    route: SparkDaemonHumanWaitOutboxRoute,
    limit = 100,
  ): SparkDaemonHumanWaitOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT o.id AS messageId, o.kind, o.payload_json AS payloadJson
         FROM outbox o
         WHERE o.kind IN ('human.request.created', 'human.response.recorded')
           AND o.status != 'acked'
           AND CAST(json_extract(o.payload_json, '$.runtimeId') AS TEXT) = ?
           AND (
             (
               COALESCE(CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT), '') = ''
             )
             OR (
               ? IS NOT NULL
               AND EXISTS (
                 SELECT 1
                 FROM workspaces w
                 WHERE w.id = CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT)
                   AND w.server_url = ?
               )
             )
           )
         ORDER BY o.created_at, o.id
         LIMIT ?`,
      )
      .all(
        route.runtimeId,
        route.serverUrl,
        route.serverUrl,
        Math.max(1, Math.floor(limit)),
      ) as Array<{
      messageId: string;
      kind: "human.request.created" | "human.response.recorded";
      payloadJson: string;
    }>;
    return rows.map((row) => ({
      messageId: row.messageId,
      kind: row.kind,
      envelope: JSON.parse(row.payloadJson) as JsonObject,
    }));
  }

  acknowledgeOutbox(messageId: string): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE outbox SET status = 'acked', updated_at = ?
           WHERE id = ?
             AND kind IN ('human.request.created', 'human.response.recorded')
             AND status != 'acked'`,
        )
        .run(now, messageId).changes === 1
    );
  }

  acknowledgeOutboxForRoute(messageId: string, route: SparkDaemonHumanWaitOutboxRoute): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `UPDATE outbox AS o
           SET status = 'acked', updated_at = ?
           WHERE o.id = ?
             AND o.kind IN ('human.request.created', 'human.response.recorded')
             AND o.status != 'acked'
             AND CAST(json_extract(o.payload_json, '$.runtimeId') AS TEXT) = ?
             AND (
               (
                 COALESCE(CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT), '') = ''
               )
               OR (
                 ? IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                   FROM workspaces w
                   WHERE w.id = CAST(json_extract(o.payload_json, '$.workspaceBindingId') AS TEXT)
                     AND w.server_url = ?
                 )
               )
             )`,
        )
        .run(now, messageId, route.runtimeId, route.serverUrl, route.serverUrl).changes === 1
    );
  }

  private readByEvidenceInteraction(
    interactionRequestId: string,
  ): SparkDaemonHumanWaitRecord | null {
    const row = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         WHERE interaction_request_id = ? AND evidence_request_json IS NOT NULL`,
      )
      .get(interactionRequestId) as HumanWaitRow | undefined;
    return row ? parseHumanWaitRow(row).wait : null;
  }

  private readRow(humanRequestId: string): {
    wait: SparkDaemonHumanWaitRecord;
    response?: SparkDaemonHumanWaitResponse;
    answerEvent?: SparkEvidenceAnswerEvent;
    acceptedResponseId?: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT request_json AS requestJson, response_json AS responseJson,
                accepted_response_id AS acceptedResponseId, status, updated_at AS updatedAt
         FROM daemon_human_waits
         WHERE human_request_id = ?`,
      )
      .get(humanRequestId) as HumanWaitRow | undefined;
    if (!row) return null;
    const parsed = parseHumanWaitRow(row);
    const [answerEvent] = this.listEvidenceAnswerEvents(humanRequestId);
    return { ...parsed, ...(answerEvent ? { answerEvent } : {}) };
  }
}

function requireUniqueInteractionMatch(
  waits: SparkDaemonHumanWaitRecord[],
  input: SparkDaemonHumanWaitInteractionLookup,
  statusLabel: string,
): SparkDaemonHumanWaitRecord {
  const interactionRequestId = input.interactionRequestId.trim();
  const sessionId = input.sessionId?.trim();
  const invocationId = input.invocationId?.trim();
  const matches = waits.filter(
    (wait) =>
      wait.interactionRequestId === interactionRequestId &&
      (!sessionId || wait.sessionId === sessionId) &&
      (!invocationId || wait.invocationId === invocationId),
  );
  if (matches.length === 0) {
    throw new SparkDaemonHumanWaitLookupError(
      "human_interaction_not_found",
      `No ${statusLabel}daemon-owned human interaction matched ${interactionRequestId || "(empty)"}.`,
    );
  }
  if (matches.length > 1) {
    throw new SparkDaemonHumanWaitLookupError(
      "human_interaction_ambiguous",
      `Multiple ${statusLabel}daemon-owned human interactions matched ${interactionRequestId}; include sessionId or invocationId.`,
    );
  }
  return matches[0]!;
}

function parseHumanWaitRow(row: HumanWaitRow): {
  wait: SparkDaemonHumanWaitRecord;
  response?: SparkDaemonHumanWaitResponse;
  acceptedResponseId?: string;
} {
  const stored = JSON.parse(row.requestJson) as SparkDaemonHumanWaitRecord;
  const wait: SparkDaemonHumanWaitRecord = {
    ...stored,
    delivery: stored.delivery ?? "blocking",
    interactionRequestId: stored.interactionRequestId ?? "",
    sessionId: stored.sessionId ?? "",
    status: row.status,
    updatedAt: row.updatedAt,
  };
  const storedResponse = row.responseJson
    ? (JSON.parse(row.responseJson) as SparkDaemonHumanWaitResponse)
    : undefined;
  const response = storedResponse
    ? { ...storedResponse, provenance: storedResponse.provenance ?? "system" }
    : undefined;
  return {
    wait,
    ...(response ? { response } : {}),
    ...(row.acceptedResponseId ? { acceptedResponseId: row.acceptedResponseId } : {}),
  };
}

function createEvidenceAnswerEvent(
  wait: SparkDaemonHumanWaitRecord,
  input: {
    humanResponseId: string;
    status: Exclude<HumanWaitStatus, "pending">;
    provenance: SparkDirectAnswerProvenance;
    answers: JsonObject;
    acceptedAt: string;
  },
): SparkEvidenceAnswerEvent | undefined {
  const canonicalAnswers = canonicalEvidenceOwnerAnswer(wait, input.answers);
  if (
    wait.delivery !== "async" ||
    !wait.evidenceRequest ||
    input.status !== "answered" ||
    input.provenance !== "direct_user" ||
    !canonicalAnswers
  ) {
    return undefined;
  }
  const answerEventId = `answer-event:${createHash("sha256")
    .update(`${input.humanResponseId}\0${wait.interactionRequestId}`)
    .digest("hex")}`;
  return sparkEvidenceAnswerEventSchema.parse({
    schema: "spark.evidence-answer-event/v1",
    answerEventId,
    humanRequestId: wait.humanRequestId,
    interactionRequestId: wait.interactionRequestId,
    humanResponseId: input.humanResponseId,
    provenance: "direct_user",
    binding: wait.evidenceRequest,
    answers: canonicalAnswers,
    acceptedAt: input.acceptedAt,
  });
}

function requireEvidenceOwnerQuestion(
  binding: SparkEvidenceRequestBinding,
  questions: readonly HumanQuestion[],
): HumanQuestion {
  const ownerQuestions = questions.filter((question) => question.id === binding.ownerQuestionId);
  if (ownerQuestions.length !== 1) {
    throw new Error("evidence-bound human interaction must contain exactly one owner question");
  }
  const owner = ownerQuestions[0]!;
  const expectedTypes =
    binding.expectedAnswerKind === "approval"
      ? new Set(["single"])
      : binding.expectedAnswerKind === "single"
        ? new Set(["single", "preview"])
        : new Set([binding.expectedAnswerKind]);
  if (!expectedTypes.has(owner.type)) {
    throw new Error("evidence-bound human interaction owner question kind does not match binding");
  }
  return owner;
}

function canonicalEvidenceOwnerAnswer(
  wait: SparkDaemonHumanWaitRecord,
  answers: JsonObject,
): JsonObject | undefined {
  const binding = wait.evidenceRequest;
  if (!binding) return undefined;
  const knownQuestions = new Map(wait.questions.map((question) => [question.id, question]));
  if (Object.keys(answers).some((questionId) => !knownQuestions.has(questionId))) return undefined;
  try {
    requireEvidenceOwnerQuestion(binding, wait.questions);
  } catch {
    return undefined;
  }
  const normalized = new Map<string, JsonObject>();
  for (const question of wait.questions) {
    const rawAnswer = answers[question.id];
    if (!hasNonEmptySparkHumanAnswer(rawAnswer)) {
      if (question.required) return undefined;
      continue;
    }
    const answer = canonicalQuestionAnswer(question, rawAnswer);
    if (!answer) return undefined;
    normalized.set(question.id, answer);
  }
  const ownerAnswer = normalized.get(binding.ownerQuestionId);
  if (!ownerAnswer) return undefined;
  const values = ownerAnswer.values as string[];
  const customText =
    typeof ownerAnswer.customText === "string" ? ownerAnswer.customText : undefined;
  switch (binding.expectedAnswerKind) {
    case "approval":
    case "single":
      if (values.length !== 1 || customText) return undefined;
      break;
    case "multi":
      if (values.length === 0 || customText) return undefined;
      break;
    case "freeform":
      if (values.length > 0 || !customText) return undefined;
      break;
    default: {
      const exhaustive: never = binding.expectedAnswerKind;
      return exhaustive;
    }
  }
  return { [binding.ownerQuestionId]: ownerAnswer };
}

function canonicalQuestionAnswer(
  question: HumanQuestion,
  rawAnswer: unknown,
): JsonObject | undefined {
  const record = recordValue(rawAnswer);
  if (record?.questionId !== undefined && record.questionId !== question.id) return undefined;
  const stringFreeform =
    question.type === "freeform" && typeof rawAnswer === "string" && rawAnswer.trim()
      ? rawAnswer.trim()
      : undefined;
  const values = stringFreeform ? [] : evidenceAnswerValues(rawAnswer);
  if (new Set(values).size !== values.length) return undefined;
  const customText = stringFreeform ?? evidenceFreeformText(rawAnswer);
  const optionValues = new Set((question.options ?? []).map((option) => option.value));
  switch (question.type) {
    case "single":
    case "preview":
      if (values.length !== 1 || customText || !optionValues.has(values[0]!)) return undefined;
      break;
    case "multi":
      if (values.length === 0 || customText || values.some((value) => !optionValues.has(value))) {
        return undefined;
      }
      break;
    case "freeform":
      if (values.length > 0 || !customText) return undefined;
      break;
    default: {
      const exhaustive: never = question.type;
      return exhaustive;
    }
  }
  return {
    questionId: question.id,
    values,
    ...(customText ? { customText } : {}),
  };
}

function evidenceAnswerValues(answer: unknown): string[] {
  if (typeof answer === "string") return answer.trim() ? [answer.trim()] : [];
  if (Array.isArray(answer)) {
    return answer.flatMap((value) =>
      typeof value === "string" && value.trim() ? [value.trim()] : [],
    );
  }
  const record = recordValue(answer);
  if (!record) return [];
  if (Array.isArray(record.values)) return evidenceAnswerValues(record.values);
  return typeof record.value === "string" && record.value.trim() ? [record.value.trim()] : [];
}

function evidenceFreeformText(answer: unknown): string | undefined {
  if (typeof answer === "string") return undefined;
  const record = recordValue(answer);
  if (!record) return undefined;
  for (const value of [record.customText, record.notes, record.comment]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function unknownRequest(message: string): SparkDaemonHumanWaitDeliveryResult {
  return {
    outcome: "unknown_request",
    retryable: false,
    returnedToTool: false,
    message,
  };
}

function nullable(value: string): string | null {
  return value ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
