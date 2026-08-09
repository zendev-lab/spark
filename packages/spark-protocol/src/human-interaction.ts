import { z } from "zod";

export const SPARK_HUMAN_INTERACTION_DELIVERY_OUTCOMES = [
  "accepted",
  "replayed",
  "already_resolved",
  "orphaned",
  "unknown_request",
  "transient",
] as const;

export type SparkHumanInteractionDeliveryOutcome =
  (typeof SPARK_HUMAN_INTERACTION_DELIVERY_OUTCOMES)[number];

export const sparkHumanInteractionDeliveryOutcomeSchema = z.enum(
  SPARK_HUMAN_INTERACTION_DELIVERY_OUTCOMES,
);

export function isTerminalSparkHumanInteractionDelivery(
  outcome: SparkHumanInteractionDeliveryOutcome,
): boolean {
  return (
    outcome === "accepted" ||
    outcome === "replayed" ||
    outcome === "already_resolved" ||
    outcome === "orphaned"
  );
}

export function hasNonEmptySparkHumanAnswer(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasNonEmptySparkHumanAnswer);
  if (!value || typeof value !== "object") return value !== undefined && value !== null;
  return Object.values(value as Record<string, unknown>).some(hasNonEmptySparkHumanAnswer);
}

export const sparkEvidenceRequestModeScopeSchema = z.enum(["goal", "repro"]);

export type SparkEvidenceRequestModeScope = z.infer<typeof sparkEvidenceRequestModeScopeSchema>;

export const sparkEvidenceExpectedAnswerKindSchema = z.enum([
  "single",
  "multi",
  "freeform",
  "approval",
]);

export type SparkEvidenceExpectedAnswerKind = z.infer<typeof sparkEvidenceExpectedAnswerKindSchema>;

/**
 * Revision-fenced binding for one detached autonomous evidence request.
 * It is copied unchanged from the interaction request into daemon durable
 * state and every surface projection; rendered copy never reconstructs it.
 */
export const sparkEvidenceRequestBindingSchema = z.object({
  schema: z.literal("spark.evidence-request/v1"),
  askRef: z.string().regex(/^ask:.+/u),
  ownerSessionId: z.string().min(1),
  goalOrReproId: z.string().min(1),
  modeScope: sparkEvidenceRequestModeScopeSchema,
  planRevision: z.number().int().positive(),
  ownerStepOrUnresolvedId: z.string().min(1),
  stepDefinitionDigest: z.string().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  ownerQuestionId: z.string().min(1),
  expectedAnswerKind: sparkEvidenceExpectedAnswerKindSchema,
});

export type SparkEvidenceRequestBinding = z.infer<typeof sparkEvidenceRequestBindingSchema>;

export const sparkDirectAnswerProvenanceSchema = z.enum(["direct_user", "system"]);

export type SparkDirectAnswerProvenance = z.infer<typeof sparkDirectAnswerProvenanceSchema>;

/**
 * One accepted direct-user answer candidate. Cancellation, archive, empty
 * answers, stale bindings, and synthetic/system responses never satisfy this
 * schema and remain only human-interaction diagnostics.
 */
export const sparkEvidenceAnswerEventSchema = z.object({
  schema: z.literal("spark.evidence-answer-event/v1"),
  answerEventId: z.string().regex(/^answer-event:.+/u),
  humanRequestId: z.string().min(1),
  interactionRequestId: z.string().min(1),
  humanResponseId: z.string().min(1),
  provenance: z.literal("direct_user"),
  binding: sparkEvidenceRequestBindingSchema,
  answers: z
    .record(z.string(), z.unknown())
    .refine(
      (answers) => Object.values(answers).some(hasNonEmptySparkHumanAnswer),
      "direct-user answer event must contain a non-empty answer",
    ),
  acceptedAt: z.iso.datetime(),
});

export type SparkEvidenceAnswerEvent = z.infer<typeof sparkEvidenceAnswerEventSchema>;

/**
 * Canonical human-interaction lifecycle owned by the daemon wait registry.
 * Hub `human_requests` / inbox rows project from this vocabulary and must
 * not invent additional terminal states.
 */
export const SPARK_HUMAN_INTERACTION_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "archived",
] as const;

export type SparkHumanInteractionStatus = (typeof SPARK_HUMAN_INTERACTION_STATUSES)[number];

export const sparkHumanInteractionStatusSchema = z.enum(SPARK_HUMAN_INTERACTION_STATUSES);

/** Response payloads delivered back to the daemon (no `pending`). */
export const SPARK_HUMAN_RESPONSE_STATUSES = ["answered", "cancelled", "archived"] as const;

export type SparkHumanResponseStatus = (typeof SPARK_HUMAN_RESPONSE_STATUSES)[number];

export const sparkHumanResponseStatusSchema = z.enum(SPARK_HUMAN_RESPONSE_STATUSES);

/**
 * Hub outbox delivery of an operator response toward the daemon.
 * Orthogonal to the interaction lifecycle above.
 */
export const SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES = ["delivering", "acked", "failed"] as const;

export type SparkHumanResponseDeliveryStatus =
  (typeof SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES)[number];

export const sparkHumanResponseDeliveryStatusSchema = z.enum(
  SPARK_HUMAN_RESPONSE_DELIVERY_STATUSES,
);

/**
 * Inbox item projection status. `resolved` means the underlying interaction is
 * no longer pending (answered / cancelled / archived).
 */
export const SPARK_INBOX_ITEM_STATUSES = ["pending", "resolved", "archived"] as const;

export type SparkInboxItemStatus = (typeof SPARK_INBOX_ITEM_STATUSES)[number];

export const sparkInboxItemStatusSchema = z.enum(SPARK_INBOX_ITEM_STATUSES);

export const SPARK_HUMAN_CORRELATION_FIELDS = [
  "humanRequestId",
  "interactionRequestId",
  "humanResponseId",
] as const;

export type SparkHumanCorrelationField = (typeof SPARK_HUMAN_CORRELATION_FIELDS)[number];

export function isSparkHumanInteractionStatus(value: string): value is SparkHumanInteractionStatus {
  return (SPARK_HUMAN_INTERACTION_STATUSES as readonly string[]).includes(value);
}

export function isSparkHumanResponseStatus(value: string): value is SparkHumanResponseStatus {
  return (SPARK_HUMAN_RESPONSE_STATUSES as readonly string[]).includes(value);
}

export function projectInboxItemStatus(
  interactionStatus: SparkHumanInteractionStatus,
): SparkInboxItemStatus {
  switch (interactionStatus) {
    case "pending":
      return "pending";
    case "answered":
    case "cancelled":
      return "resolved";
    case "archived":
      return "archived";
    default: {
      const _exhaustive: never = interactionStatus;
      return _exhaustive;
    }
  }
}
