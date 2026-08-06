import { z } from "zod";

export const SPARK_AGENT_OBSERVABILITY_SCHEMA_VERSION = 1 as const;

const sparkObservationIdSchema = z.string().trim().min(1).max(256);
const sparkObservationLabelSchema = z.string().trim().min(1).max(256);
const sparkObservationIsoDateTimeSchema = z.string().datetime({ offset: true });
const sparkObservationFingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{16,64}$/u, "must be a lowercase opaque fingerprint");
const sparkObservationSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 digest");
const sparkObservationEvidenceRefSchema = z
  .string()
  .regex(/^evidence:.+$/u, "must be an evidence: ref");

export const SPARK_AGENT_TRACE_EVENT_KINDS = [
  "agent.run.started",
  "agent.run.finished",
  "model.roundtrip.started",
  "model.roundtrip.finished",
  "skill.selection.finished",
  "tool.call.started",
  "tool.call.finished",
] as const;

export const sparkAgentTraceEventKindSchema = z.enum(SPARK_AGENT_TRACE_EVENT_KINDS);

export const SPARK_AGENT_RUN_SOURCES = [
  "user_submit",
  "trigger_turn",
  "restart_resume",
  "loop_tick",
  "role_run",
  "unknown",
] as const;

export const sparkAgentRunSourceSchema = z.enum(SPARK_AGENT_RUN_SOURCES);

export const SPARK_AGENT_TRACE_OUTCOMES = ["completed", "aborted", "failed"] as const;
export const sparkAgentTraceOutcomeSchema = z.enum(SPARK_AGENT_TRACE_OUTCOMES);

export const SPARK_AGENT_TOOL_EFFECTS = [
  "read",
  "local_write",
  "external_write",
  "destructive",
  "unknown",
] as const;
export const sparkAgentToolEffectSchema = z.enum(SPARK_AGENT_TOOL_EFFECTS);

export const SPARK_AGENT_TOOL_STATUSES = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed_out",
] as const;
export const sparkAgentToolStatusSchema = z.enum(SPARK_AGENT_TOOL_STATUSES);

export const SPARK_AGENT_TOOL_FAILURE_STAGES = [
  "resolution",
  "argument_validation",
  "availability",
  "policy",
  "approval",
  "execution",
  "timeout",
  "cancellation",
  "result_processing",
] as const;
export const sparkAgentToolFailureStageSchema = z.enum(SPARK_AGENT_TOOL_FAILURE_STAGES);

export const SPARK_AGENT_TOOL_FAILURE_TYPES = [
  "unknown_tool",
  "invalid_arguments",
  "inactive_tool",
  "policy_denied",
  "approval_rejected",
  "dependency_failure",
  "tool_returned_error",
  "uncaught_exception",
  "timeout",
  "cancelled",
  "invalid_result",
  "unknown",
] as const;
export const sparkAgentToolFailureTypeSchema = z.enum(SPARK_AGENT_TOOL_FAILURE_TYPES);

const sparkAgentTraceBaseSchema = z.object({
  schemaVersion: z.literal(SPARK_AGENT_OBSERVABILITY_SCHEMA_VERSION),
  traceId: sparkObservationIdSchema,
  spanId: sparkObservationIdSchema,
  parentSpanId: sparkObservationIdSchema.optional(),
  occurredAt: sparkObservationIsoDateTimeSchema,
});

export const sparkAgentRunStartedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("agent.run.started"),
    source: sparkAgentRunSourceSchema,
    sessionFingerprint: sparkObservationFingerprintSchema,
    phase: z.enum(["plan", "implement"]).optional(),
  })
  .strict();

export const sparkAgentRunFinishedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("agent.run.finished"),
    outcome: sparkAgentTraceOutcomeSchema,
    roundtrips: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    errorCode: sparkObservationLabelSchema.optional(),
    evidenceRefs: z.array(sparkObservationEvidenceRefSchema).max(64).default([]),
  })
  .strict();

const sparkAgentTraceModelSchema = z
  .object({
    provider: sparkObservationLabelSchema,
    id: sparkObservationLabelSchema,
    api: sparkObservationLabelSchema.optional(),
    reasoning: sparkObservationLabelSchema.optional(),
  })
  .strict();

export const sparkAgentModelRoundtripStartedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("model.roundtrip.started"),
    roundtrip: z.number().int().positive(),
    model: sparkAgentTraceModelSchema,
    promptVersion: sparkObservationLabelSchema,
    stablePromptHash: sparkObservationSha256Schema,
    dynamicPromptHash: sparkObservationSha256Schema,
    toolProfileFingerprint: sparkObservationFingerprintSchema,
  })
  .strict();

export const sparkAgentModelRoundtripFinishedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("model.roundtrip.finished"),
    roundtrip: z.number().int().positive(),
    outcome: sparkAgentTraceOutcomeSchema,
    stopReason: sparkObservationLabelSchema.optional(),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    errorCode: sparkObservationLabelSchema.optional(),
  })
  .strict();

export const sparkAgentSkillSelectionTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("skill.selection.finished"),
    roundtrip: z.number().int().positive(),
    selectedSkills: z.array(sparkObservationLabelSchema).max(64),
    selectorVersion: sparkObservationLabelSchema.optional(),
    selectionFingerprint: sparkObservationFingerprintSchema.optional(),
  })
  .strict();

export const sparkAgentToolCallStartedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("tool.call.started"),
    roundtrip: z.number().int().positive(),
    toolCallId: sparkObservationIdSchema,
    toolName: sparkObservationLabelSchema,
    effect: sparkAgentToolEffectSchema,
    executionMode: z.enum(["parallel", "sequential"]),
    approval: z.enum(["none", "required"]),
    argumentFingerprint: sparkObservationFingerprintSchema.optional(),
    argumentBytes: z.number().int().nonnegative().optional(),
    parallelBatchId: sparkObservationIdSchema.optional(),
  })
  .strict();

export const sparkAgentToolCallFinishedTraceEventSchema = sparkAgentTraceBaseSchema
  .extend({
    kind: z.literal("tool.call.finished"),
    roundtrip: z.number().int().positive(),
    toolCallId: sparkObservationIdSchema,
    toolName: sparkObservationLabelSchema,
    status: sparkAgentToolStatusSchema,
    durationMs: z.number().int().nonnegative(),
    resultBytes: z.number().int().nonnegative().optional(),
    failureStage: sparkAgentToolFailureStageSchema.optional(),
    failureType: sparkAgentToolFailureTypeSchema.optional(),
    errorCode: sparkObservationLabelSchema.optional(),
    retryable: z.boolean().optional(),
    evidenceRefs: z.array(sparkObservationEvidenceRefSchema).max(64).default([]),
  })
  .strict();

export const sparkAgentTraceEventSchema = z.discriminatedUnion("kind", [
  sparkAgentRunStartedTraceEventSchema,
  sparkAgentRunFinishedTraceEventSchema,
  sparkAgentModelRoundtripStartedTraceEventSchema,
  sparkAgentModelRoundtripFinishedTraceEventSchema,
  sparkAgentSkillSelectionTraceEventSchema,
  sparkAgentToolCallStartedTraceEventSchema,
  sparkAgentToolCallFinishedTraceEventSchema,
]);

export const sparkAgentFeedbackTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("trace"),
      traceId: sparkObservationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("span"),
      traceId: sparkObservationIdSchema,
      spanId: sparkObservationIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      sessionFingerprint: sparkObservationFingerprintSchema,
      messageId: sparkObservationIdSchema,
    })
    .strict(),
]);

export const sparkAgentFeedbackSchema = z
  .object({
    schemaVersion: z.literal(SPARK_AGENT_OBSERVABILITY_SCHEMA_VERSION),
    feedbackId: sparkObservationIdSchema,
    target: sparkAgentFeedbackTargetSchema,
    source: z.enum(["user", "reviewer", "evaluator", "implicit"]),
    sentiment: z.enum(["positive", "negative", "neutral"]).optional(),
    score: z.number().min(-1).max(1).optional(),
    label: sparkObservationLabelSchema.optional(),
    commentRef: sparkObservationEvidenceRefSchema.optional(),
    expectedBehaviorRef: sparkObservationEvidenceRefSchema.optional(),
    createdAt: sparkObservationIsoDateTimeSchema,
  })
  .strict()
  .superRefine((feedback, context) => {
    if (
      feedback.sentiment === undefined &&
      feedback.score === undefined &&
      feedback.label === undefined &&
      feedback.commentRef === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "feedback requires sentiment, score, label, or commentRef",
      });
    }
  });

export const sparkAgentEvaluationSchema = z
  .object({
    schemaVersion: z.literal(SPARK_AGENT_OBSERVABILITY_SCHEMA_VERSION),
    evaluationId: sparkObservationIdSchema,
    traceId: sparkObservationIdSchema,
    spanId: sparkObservationIdSchema.optional(),
    evaluator: z
      .object({
        kind: z.enum(["deterministic", "model", "human"]),
        name: sparkObservationLabelSchema,
        version: sparkObservationLabelSchema.optional(),
      })
      .strict(),
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    score: z.number().finite().optional(),
    labels: z.array(sparkObservationLabelSchema).max(64).default([]),
    metrics: z
      .record(z.string().trim().min(1).max(128), z.number().finite())
      .default({}),
    evidenceRefs: z.array(sparkObservationEvidenceRefSchema).max(64).default([]),
    createdAt: sparkObservationIsoDateTimeSchema,
  })
  .strict();

export type SparkAgentTraceEventKind = z.infer<typeof sparkAgentTraceEventKindSchema>;
export type SparkAgentRunSource = z.infer<typeof sparkAgentRunSourceSchema>;
export type SparkAgentTraceOutcome = z.infer<typeof sparkAgentTraceOutcomeSchema>;
export type SparkAgentToolEffect = z.infer<typeof sparkAgentToolEffectSchema>;
export type SparkAgentToolStatus = z.infer<typeof sparkAgentToolStatusSchema>;
export type SparkAgentToolFailureStage = z.infer<typeof sparkAgentToolFailureStageSchema>;
export type SparkAgentToolFailureType = z.infer<typeof sparkAgentToolFailureTypeSchema>;
export type SparkAgentTraceEvent = z.infer<typeof sparkAgentTraceEventSchema>;
export type SparkAgentFeedbackTarget = z.infer<typeof sparkAgentFeedbackTargetSchema>;
export type SparkAgentFeedback = z.infer<typeof sparkAgentFeedbackSchema>;
export type SparkAgentEvaluation = z.infer<typeof sparkAgentEvaluationSchema>;
