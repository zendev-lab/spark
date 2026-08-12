import { z } from "zod";

export const SPARK_AGENT_TRACE_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1).max(256);
const labelSchema = z.string().trim().min(1).max(256);
const occurredAtSchema = z.string().datetime({ offset: true });
const fingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{16,64}$/u, "must be a lowercase opaque fingerprint");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 digest");
const evidenceRefSchema = z.string().regex(/^evidence:.+$/u, "must be an evidence: ref");

export const SPARK_AGENT_TRACE_EVENT_KINDS = [
  "agent.run.started",
  "agent.run.finished",
  "model.roundtrip.started",
  "model.roundtrip.finished",
  "skill.routing.finished",
  "skill.load.started",
  "skill.load.finished",
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
  "network_read",
  "control",
  "local_write",
  "external_write",
  "destructive",
  "unknown",
] as const;

export const sparkAgentToolEffectSchema = z.enum(SPARK_AGENT_TOOL_EFFECTS);

export const SPARK_AGENT_TRACE_TOOL_APPROVALS = ["none", "required", "unknown"] as const;

export const sparkAgentTraceToolApprovalSchema = z.enum(SPARK_AGENT_TRACE_TOOL_APPROVALS);

const sparkAgentTraceToolApprovalProjectionInputSchema = z.enum([
  "none",
  "manual_only",
  "required",
  "unknown",
]);

/**
 * Projection contract for Trace producers: convert contextual `manual_only`
 * policy into the effective Agent Trace v1 approval requirement without
 * widening the version-1 wire enum. This does not decide execution authority.
 */
export function projectSparkAgentTraceToolApproval(
  value: unknown,
  options: { driverOwned: boolean },
): z.infer<typeof sparkAgentTraceToolApprovalSchema> {
  const approval = sparkAgentTraceToolApprovalProjectionInputSchema.parse(value);
  if (approval !== "manual_only") return approval;
  return options.driverOwned ? "none" : "required";
}

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

export const SPARK_AGENT_SKILL_ROUTING_MODES = [
  "explicit",
  "automatic",
  "inherited",
  "none",
] as const;

export const sparkAgentSkillRoutingModeSchema = z.enum(SPARK_AGENT_SKILL_ROUTING_MODES);

export const SPARK_AGENT_SKILL_LOAD_STATUSES = ["succeeded", "failed", "blocked"] as const;

export const sparkAgentSkillLoadStatusSchema = z.enum(SPARK_AGENT_SKILL_LOAD_STATUSES);

export const SPARK_AGENT_SKILL_LOAD_FAILURE_TYPES = [
  "not_found",
  "invalid_manifest",
  "read_failed",
  "budget_exceeded",
  "policy_denied",
  "unknown",
] as const;

export const sparkAgentSkillLoadFailureTypeSchema = z.enum(SPARK_AGENT_SKILL_LOAD_FAILURE_TYPES);

export const sparkAgentArgumentFingerprintSchema = z
  .object({
    scheme: z.literal("hmac-sha256-v1"),
    value: sha256Schema,
    keyScope: z.literal("installation"),
  })
  .strict();

export const sparkAgentTraceSkillSchema = z
  .object({
    name: labelSchema,
    version: labelSchema.optional(),
    contentHash: sha256Schema.optional(),
  })
  .strict();

export const sparkAgentToolModelOriginSchema = z
  .object({
    roundtrip: z.number().int().positive(),
    spanId: idSchema,
  })
  .strict();

const rootEventSchema = z.object({
  schemaVersion: z.literal(SPARK_AGENT_TRACE_SCHEMA_VERSION),
  eventId: idSchema,
  traceId: idSchema,
  spanId: idSchema,
  occurredAt: occurredAtSchema,
});

const childEventSchema = rootEventSchema.extend({
  parentSpanId: idSchema,
});

export const sparkAgentRunStartedTraceEventSchema = rootEventSchema
  .extend({
    kind: z.literal("agent.run.started"),
    source: sparkAgentRunSourceSchema,
    sessionFingerprint: fingerprintSchema,
    phase: z.enum(["plan", "implement"]).optional(),
  })
  .strict();

export const sparkAgentRunFinishedTraceEventSchema = rootEventSchema
  .extend({
    kind: z.literal("agent.run.finished"),
    outcome: sparkAgentTraceOutcomeSchema,
    roundtrips: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    errorCode: labelSchema.optional(),
    evidenceRefs: z.array(evidenceRefSchema).max(64).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.outcome === "completed" && event.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "completed runs cannot carry errorCode",
      });
    }
  });

const modelSchema = z
  .object({
    provider: labelSchema,
    id: labelSchema,
    api: labelSchema.optional(),
    reasoning: labelSchema.optional(),
  })
  .strict();

export const sparkAgentModelRoundtripStartedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("model.roundtrip.started"),
    roundtrip: z.number().int().positive(),
    model: modelSchema,
    promptVersion: labelSchema,
    stablePromptHash: sha256Schema,
    dynamicPromptHash: sha256Schema,
    toolProfileFingerprint: fingerprintSchema,
  })
  .strict();

export const sparkAgentModelRoundtripFinishedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("model.roundtrip.finished"),
    roundtrip: z.number().int().positive(),
    outcome: sparkAgentTraceOutcomeSchema,
    stopReason: labelSchema.optional(),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    errorCode: labelSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.outcome === "completed" && event.stopReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["stopReason"],
        message: "completed roundtrips require stopReason",
      });
    }
    if (event.outcome === "completed" && event.errorCode !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "completed roundtrips cannot carry errorCode",
      });
    }
  });

export const sparkAgentSkillRoutingTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("skill.routing.finished"),
    appliesFromRoundtrip: z.number().int().positive(),
    mode: sparkAgentSkillRoutingModeSchema,
    skills: z.array(sparkAgentTraceSkillSchema).max(64),
    candidateCount: z.number().int().nonnegative().optional(),
    selectorVersion: labelSchema.optional(),
    routingFingerprint: fingerprintSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const names = event.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "selected Skill names must be unique",
      });
    }
    if (event.mode === "none" && event.skills.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "selection mode none cannot contain Skills",
      });
    }
    if (event.candidateCount !== undefined && event.candidateCount < event.skills.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateCount"],
        message: "candidateCount cannot be smaller than selected Skills",
      });
    }
  });

export const sparkAgentSkillLoadStartedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("skill.load.started"),
    appliesFromRoundtrip: z.number().int().positive().optional(),
    skill: sparkAgentTraceSkillSchema,
  })
  .strict();

export const sparkAgentSkillLoadFinishedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("skill.load.finished"),
    appliesFromRoundtrip: z.number().int().positive().optional(),
    skill: sparkAgentTraceSkillSchema,
    status: sparkAgentSkillLoadStatusSchema,
    durationMs: z.number().int().nonnegative(),
    failureType: sparkAgentSkillLoadFailureTypeSchema.optional(),
    errorCode: labelSchema.optional(),
    evidenceRefs: z.array(evidenceRefSchema).max(64).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.status === "succeeded") {
      if (event.failureType !== undefined || event.errorCode !== undefined) {
        context.addIssue({
          code: "custom",
          message: "succeeded Skill loads cannot carry failure fields",
        });
      }
      return;
    }
    if (event.failureType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureType"],
        message: "non-succeeded Skill loads require failureType",
      });
    }
    if (
      event.status === "blocked" &&
      event.failureType !== undefined &&
      event.failureType !== "budget_exceeded" &&
      event.failureType !== "policy_denied"
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureType"],
        message: "blocked Skill loads require budget_exceeded or policy_denied",
      });
    }
  });

export const sparkAgentToolCallStartedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("tool.call.started"),
    toolCallId: idSchema,
    toolName: labelSchema,
    modelOrigin: sparkAgentToolModelOriginSchema.optional(),
    effect: sparkAgentToolEffectSchema,
    executionMode: z.enum(["parallel", "sequential", "unknown"]),
    approval: sparkAgentTraceToolApprovalSchema,
    argumentFingerprint: sparkAgentArgumentFingerprintSchema.optional(),
    argumentBytes: z.number().int().nonnegative().optional(),
    parallelBatchId: idSchema.optional(),
  })
  .strict();

export const sparkAgentToolCallFinishedTraceEventSchema = childEventSchema
  .extend({
    kind: z.literal("tool.call.finished"),
    toolCallId: idSchema,
    toolName: labelSchema,
    modelOrigin: sparkAgentToolModelOriginSchema.optional(),
    status: sparkAgentToolStatusSchema,
    durationMs: z.number().int().nonnegative(),
    resultBytes: z.number().int().nonnegative().optional(),
    failureStage: sparkAgentToolFailureStageSchema.optional(),
    failureType: sparkAgentToolFailureTypeSchema.optional(),
    errorCode: labelSchema.optional(),
    retryable: z.boolean().optional(),
    evidenceRefs: z.array(evidenceRefSchema).max(64).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.status === "succeeded") {
      if (
        event.failureStage !== undefined ||
        event.failureType !== undefined ||
        event.errorCode !== undefined ||
        event.retryable !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "succeeded Tool calls cannot carry failure fields",
        });
      }
      return;
    }
    if (event.failureStage === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureStage"],
        message: "non-succeeded Tool calls require failureStage",
      });
    }
    if (event.failureType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureType"],
        message: "non-succeeded Tool calls require failureType",
      });
    }
    if (
      event.status === "timed_out" &&
      (event.failureStage !== "timeout" || event.failureType !== "timeout")
    ) {
      context.addIssue({
        code: "custom",
        message: "timed_out Tool calls require timeout stage and type",
      });
    }
    if (
      event.status === "cancelled" &&
      (event.failureStage !== "cancellation" || event.failureType !== "cancelled")
    ) {
      context.addIssue({
        code: "custom",
        message: "cancelled Tool calls require cancellation stage and type",
      });
    }
    if (
      event.status === "blocked" &&
      event.failureStage !== undefined &&
      !["resolution", "argument_validation", "availability", "policy", "approval"].includes(
        event.failureStage,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureStage"],
        message: "blocked Tool calls must stop before execution",
      });
    }
  });

export const sparkAgentTraceEventSchema = z.discriminatedUnion("kind", [
  sparkAgentRunStartedTraceEventSchema,
  sparkAgentRunFinishedTraceEventSchema,
  sparkAgentModelRoundtripStartedTraceEventSchema,
  sparkAgentModelRoundtripFinishedTraceEventSchema,
  sparkAgentSkillRoutingTraceEventSchema,
  sparkAgentSkillLoadStartedTraceEventSchema,
  sparkAgentSkillLoadFinishedTraceEventSchema,
  sparkAgentToolCallStartedTraceEventSchema,
  sparkAgentToolCallFinishedTraceEventSchema,
]);

export type SparkAgentTraceEventKind = z.infer<typeof sparkAgentTraceEventKindSchema>;
export type SparkAgentRunSource = z.infer<typeof sparkAgentRunSourceSchema>;
export type SparkAgentTraceOutcome = z.infer<typeof sparkAgentTraceOutcomeSchema>;
export type SparkAgentToolEffect = z.infer<typeof sparkAgentToolEffectSchema>;
export type SparkAgentTraceToolApproval = z.infer<typeof sparkAgentTraceToolApprovalSchema>;
export type SparkAgentToolStatus = z.infer<typeof sparkAgentToolStatusSchema>;
export type SparkAgentToolFailureStage = z.infer<typeof sparkAgentToolFailureStageSchema>;
export type SparkAgentToolFailureType = z.infer<typeof sparkAgentToolFailureTypeSchema>;
export type SparkAgentSkillRoutingMode = z.infer<typeof sparkAgentSkillRoutingModeSchema>;
export type SparkAgentSkillLoadStatus = z.infer<typeof sparkAgentSkillLoadStatusSchema>;
export type SparkAgentSkillLoadFailureType = z.infer<typeof sparkAgentSkillLoadFailureTypeSchema>;
export type SparkAgentArgumentFingerprint = z.infer<typeof sparkAgentArgumentFingerprintSchema>;
export type SparkAgentTraceSkill = z.infer<typeof sparkAgentTraceSkillSchema>;
export type SparkAgentToolModelOrigin = z.infer<typeof sparkAgentToolModelOriginSchema>;
export type SparkAgentTraceEvent = z.infer<typeof sparkAgentTraceEventSchema>;
