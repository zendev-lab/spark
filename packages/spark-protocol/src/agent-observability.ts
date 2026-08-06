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

export const SPARK_AGENT_SKILL_SELECTION_MODES = [
  "explicit",
  "automatic",
  "inherited",
  "none",
] as const;
export const sparkAgentSkillSelectionModeSchema = z.enum(SPARK_AGENT_SKILL_SELECTION_MODES);

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
export const sparkAgentSkillLoadFailureTypeSchema = z.enum(
  SPARK_AGENT_SKILL_LOAD_FAILURE_TYPES,
);

export const sparkAgentArgumentFingerprintSchema = z
  .object({
    scheme: z.literal("hmac-sha256-v1"),
    value: sparkObservationSha256Schema,
    keyScope: z.literal("installation"),
  })
  .strict();

export const sparkAgentTraceSkillSchema = z
  .object({
    name: sparkObservationLabelSchema,
    version: sparkObservationLabelSchema.optional(),
    contentHash: sparkObservationSha256Schema.optional(),
  })
  .strict();

const sparkAgentTraceRootBaseSchema = z.object({
  schemaVersion: z.literal(SPARK_AGENT_OBSERVABILITY_SCHEMA_VERSION),
  eventId: sparkObservationIdSchema,
  traceId: sparkObservationIdSchema,
  spanId: sparkObservationIdSchema,
  occurredAt: sparkObservationIsoDateTimeSchema,
});

const sparkAgentTraceChildBaseSchema = sparkAgentTraceRootBaseSchema.extend({
  parentSpanId: sparkObservationIdSchema,
});

export const sparkAgentRunStartedTraceEventSchema = sparkAgentTraceRootBaseSchema
  .extend({
    kind: z.literal("agent.run.started"),
    source: sparkAgentRunSourceSchema,
    sessionFingerprint: sparkObservationFingerprintSchema,
    phase: z.enum(["plan", "implement"]).optional(),
  })
  .strict();

export const sparkAgentRunFinishedTraceEventSchema = sparkAgentTraceRootBaseSchema
  .extend({
    kind: z.literal("agent.run.finished"),
    outcome: sparkAgentTraceOutcomeSchema,
    roundtrips: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    errorCode: sparkObservationLabelSchema.optional(),
    evidenceRefs: z.array(sparkObservationEvidenceRefSchema).max(64).default([]),
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

const sparkAgentTraceModelSchema = z
  .object({
    provider: sparkObservationLabelSchema,
    id: sparkObservationLabelSchema,
    api: sparkObservationLabelSchema.optional(),
    reasoning: sparkObservationLabelSchema.optional(),
  })
  .strict();

export const sparkAgentModelRoundtripStartedTraceEventSchema = sparkAgentTraceChildBaseSchema
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

export const sparkAgentModelRoundtripFinishedTraceEventSchema = sparkAgentTraceChildBaseSchema
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

export const sparkAgentSkillSelectionTraceEventSchema = sparkAgentTraceChildBaseSchema
  .extend({
    kind: z.literal("skill.selection.finished"),
    appliesFromRoundtrip: z.number().int().positive(),
    mode: sparkAgentSkillSelectionModeSchema,
    skills: z.array(sparkAgentTraceSkillSchema).max(64),
    candidateCount: z.number().int().nonnegative().optional(),
    selectorVersion: sparkObservationLabelSchema.optional(),
    selectionFingerprint: sparkObservationFingerprintSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const names = event.skills.map((skill) => skill.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "selected skill names must be unique",
      });
    }
    if (event.mode === "none" && event.skills.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["skills"],
        message: "selection mode none cannot contain skills",
      });
    }
    if (event.candidateCount !== undefined && event.candidateCount < event.skills.length) {
      context.addIssue({
        code: "custom",
        path: ["candidateCount"],
        message: "candidateCount cannot be smaller than selected skills",
      });
    }
  });

export const sparkAgentSkillLoadStartedTraceEventSchema = sparkAgentTraceChildBaseSchema
  .extend({
    kind: z.literal("skill.load.started"),
    appliesFromRoundtrip: z.number().int().positive(),
    skill: sparkAgentTraceSkillSchema,
  })
  .strict();

export const sparkAgentSkillLoadFinishedTraceEventSchema = sparkAgentTraceChildBaseSchema
  .extend({
    kind: z.literal("skill.load.finished"),
    appliesFromRoundtrip: z.number().int().positive(),
    skill: sparkAgentTraceSkillSchema,
    status: sparkAgentSkillLoadStatusSchema,
    durationMs: z.number().int().nonnegative(),
    failureType: sparkAgentSkillLoadFailureTypeSchema.optional(),
    errorCode: sparkObservationLabelSchema.optional(),
    evidenceRefs: z.array(sparkObservationEvidenceRefSchema).max(64).default([]),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.status === "succeeded") {
      if (event.failureType !== undefined || event.errorCode !== undefined) {
        context.addIssue({
          code: "custom",
          message: "succeeded skill loads cannot carry failure fields",
        });
      }
      return;
    }
    if (event.failureType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureType"],
        message: "non-succeeded skill loads require failureType",
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
        message: "blocked skill loads require budget_exceeded or policy_denied",
      });
    }
  });

export const sparkAgentToolCallStartedTraceEventSchema = sparkAgentTraceChildBaseSchema
  .extend({
    kind: z.literal("tool.call.started"),
    roundtrip: z.number().int().positive(),
    toolCallId: sparkObservationIdSchema,
    toolName: sparkObservationLabelSchema,
    effect: sparkAgentToolEffectSchema,
    executionMode: z.enum(["parallel", "sequential", "unknown"]),
    approval: z.enum(["none", "required", "unknown"]),
    argumentFingerprint: sparkAgentArgumentFingerprintSchema.optional(),
    argumentBytes: z.number().int().nonnegative().optional(),
    parallelBatchId: sparkObservationIdSchema.optional(),
  })
  .strict();

export const sparkAgentToolCallFinishedTraceEventSchema = sparkAgentTraceChildBaseSchema
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
          message: "succeeded tool calls cannot carry failure fields",
        });
      }
      return;
    }
    if (event.failureStage === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureStage"],
        message: "non-succeeded tool calls require failureStage",
      });
    }
    if (event.failureType === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureType"],
        message: "non-succeeded tool calls require failureType",
      });
    }
    if (
      event.status === "timed_out" &&
      (event.failureStage !== "timeout" || event.failureType !== "timeout")
    ) {
      context.addIssue({
        code: "custom",
        message: "timed_out tool calls require timeout stage and type",
      });
    }
    if (
      event.status === "cancelled" &&
      (event.failureStage !== "cancellation" || event.failureType !== "cancelled")
    ) {
      context.addIssue({
        code: "custom",
        message: "cancelled tool calls require cancellation stage and cancelled type",
      });
    }
    if (
      event.status === "blocked" &&
      event.failureStage !== undefined &&
      ![
        "resolution",
        "argument_validation",
        "availability",
        "policy",
        "approval",
      ].includes(event.failureStage)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureStage"],
        message: "blocked tool calls must stop before execution",
      });
    }
  });

export const sparkAgentTraceEventSchema = z.discriminatedUnion("kind", [
  sparkAgentRunStartedTraceEventSchema,
  sparkAgentRunFinishedTraceEventSchema,
  sparkAgentModelRoundtripStartedTraceEventSchema,
  sparkAgentModelRoundtripFinishedTraceEventSchema,
  sparkAgentSkillSelectionTraceEventSchema,
  sparkAgentSkillLoadStartedTraceEventSchema,
  sparkAgentSkillLoadFinishedTraceEventSchema,
  sparkAgentToolCallStartedTraceEventSchema,
  sparkAgentToolCallFinishedTraceEventSchema,
]);

export interface SparkAgentTraceValidationIssue {
  code:
    | "duplicate_event"
    | "trace_mismatch"
    | "root_order"
    | "duplicate_span"
    | "missing_parent"
    | "invalid_parent"
    | "orphan_finish"
    | "finish_kind_mismatch"
    | "duplicate_finish"
    | "span_metadata_mismatch"
    | "unclosed_span"
    | "roundtrip_count_mismatch";
  message: string;
  eventIndex?: number;
  eventId?: string;
}

export interface SparkAgentTraceValidationResult {
  valid: boolean;
  issues: SparkAgentTraceValidationIssue[];
}

type StartedTraceEvent =
  | z.infer<typeof sparkAgentRunStartedTraceEventSchema>
  | z.infer<typeof sparkAgentModelRoundtripStartedTraceEventSchema>
  | z.infer<typeof sparkAgentSkillLoadStartedTraceEventSchema>
  | z.infer<typeof sparkAgentToolCallStartedTraceEventSchema>;

type OpenSpan = {
  started: StartedTraceEvent;
  finished: boolean;
};

/** Validate a terminal trace after daemon event ordering and deduplication. */
export function validateCompletedSparkAgentTrace(
  events: readonly SparkAgentTraceEvent[],
): SparkAgentTraceValidationResult {
  const issues: SparkAgentTraceValidationIssue[] = [];
  const eventIds = new Set<string>();
  const spans = new Map<string, OpenSpan>();
  const instantSpanIds = new Set<string>();
  let traceId: string | undefined;
  let runSpanId: string | undefined;
  let runFinishedIndex: number | undefined;
  let observedRoundtrips = 0;
  let reportedRoundtrips: number | undefined;

  const issue = (
    code: SparkAgentTraceValidationIssue["code"],
    message: string,
    event: SparkAgentTraceEvent | undefined,
    eventIndex?: number,
  ) => {
    issues.push({
      code,
      message,
      ...(eventIndex !== undefined ? { eventIndex } : {}),
      ...(event ? { eventId: event.eventId } : {}),
    });
  };

  const expectedParentKind = (event: SparkAgentTraceEvent): StartedTraceEvent["kind"] | undefined => {
    switch (event.kind) {
      case "model.roundtrip.started":
      case "model.roundtrip.finished":
      case "skill.selection.finished":
      case "skill.load.started":
      case "skill.load.finished":
        return "agent.run.started";
      case "tool.call.started":
      case "tool.call.finished":
        return "model.roundtrip.started";
      default:
        return undefined;
    }
  };

  const registerStart = (event: StartedTraceEvent, eventIndex: number) => {
    if (spans.has(event.spanId) || instantSpanIds.has(event.spanId)) {
      issue("duplicate_span", `span ${event.spanId} was already registered`, event, eventIndex);
      return;
    }
    spans.set(event.spanId, { started: event, finished: false });
  };

  for (const [eventIndex, event] of events.entries()) {
    if (eventIds.has(event.eventId)) {
      issue("duplicate_event", `event ${event.eventId} appears more than once`, event, eventIndex);
    }
    eventIds.add(event.eventId);

    traceId ??= event.traceId;
    if (event.traceId !== traceId) {
      issue(
        "trace_mismatch",
        `expected trace ${traceId}, observed ${event.traceId}`,
        event,
        eventIndex,
      );
    }

    if (runFinishedIndex !== undefined) {
      issue("root_order", "events cannot appear after agent.run.finished", event, eventIndex);
    }

    if ("parentSpanId" in event) {
      const parent = spans.get(event.parentSpanId);
      if (!parent) {
        issue(
          "missing_parent",
          `parent span ${event.parentSpanId} has not started`,
          event,
          eventIndex,
        );
      } else {
        const expected = expectedParentKind(event);
        if (expected !== undefined && parent.started.kind !== expected) {
          issue(
            "invalid_parent",
            `${event.kind} requires parent ${expected}, observed ${parent.started.kind}`,
            event,
            eventIndex,
          );
        }
      }
    }

    switch (event.kind) {
      case "agent.run.started":
        if (eventIndex !== 0 || runSpanId !== undefined) {
          issue("root_order", "agent.run.started must be the unique first event", event, eventIndex);
        }
        runSpanId ??= event.spanId;
        registerStart(event, eventIndex);
        break;
      case "model.roundtrip.started":
        observedRoundtrips += 1;
        registerStart(event, eventIndex);
        break;
      case "skill.load.started":
      case "tool.call.started":
        registerStart(event, eventIndex);
        break;
      case "skill.selection.finished":
        if (spans.has(event.spanId) || instantSpanIds.has(event.spanId)) {
          issue("duplicate_span", `span ${event.spanId} was already registered`, event, eventIndex);
        }
        instantSpanIds.add(event.spanId);
        break;
      case "agent.run.finished":
      case "model.roundtrip.finished":
      case "skill.load.finished":
      case "tool.call.finished": {
        const span = spans.get(event.spanId);
        if (!span) {
          issue("orphan_finish", `span ${event.spanId} finished without a start`, event, eventIndex);
          break;
        }
        const expectedStartKind = {
          "agent.run.finished": "agent.run.started",
          "model.roundtrip.finished": "model.roundtrip.started",
          "skill.load.finished": "skill.load.started",
          "tool.call.finished": "tool.call.started",
        }[event.kind] as StartedTraceEvent["kind"];
        if (span.started.kind !== expectedStartKind) {
          issue(
            "finish_kind_mismatch",
            `${event.kind} cannot finish ${span.started.kind}`,
            event,
            eventIndex,
          );
        }
        if (span.finished) {
          issue("duplicate_finish", `span ${event.spanId} finished more than once`, event, eventIndex);
        }
        span.finished = true;

        if (
          event.kind === "model.roundtrip.finished" &&
          span.started.kind === "model.roundtrip.started" &&
          event.roundtrip !== span.started.roundtrip
        ) {
          issue("span_metadata_mismatch", "roundtrip finish does not match start", event, eventIndex);
        }
        if (
          event.kind === "skill.load.finished" &&
          span.started.kind === "skill.load.started" &&
          (event.appliesFromRoundtrip !== span.started.appliesFromRoundtrip ||
            event.skill.name !== span.started.skill.name ||
            event.skill.version !== span.started.skill.version ||
            event.skill.contentHash !== span.started.skill.contentHash)
        ) {
          issue("span_metadata_mismatch", "skill load finish does not match start", event, eventIndex);
        }
        if (
          event.kind === "tool.call.finished" &&
          span.started.kind === "tool.call.started" &&
          (event.roundtrip !== span.started.roundtrip ||
            event.toolCallId !== span.started.toolCallId ||
            event.toolName !== span.started.toolName)
        ) {
          issue("span_metadata_mismatch", "tool call finish does not match start", event, eventIndex);
        }
        if (event.kind === "agent.run.finished") {
          if (event.spanId !== runSpanId) {
            issue("span_metadata_mismatch", "run finish does not match run start", event, eventIndex);
          }
          reportedRoundtrips = event.roundtrips;
          runFinishedIndex = eventIndex;
        }
        break;
      }
    }
  }

  if (events.length === 0 || events[0]?.kind !== "agent.run.started") {
    issue("root_order", "completed trace requires agent.run.started", events[0], 0);
  }
  if (runFinishedIndex === undefined) {
    issue("root_order", "completed trace requires agent.run.finished", events.at(-1));
  } else if (runFinishedIndex !== events.length - 1) {
    issue("root_order", "agent.run.finished must be the final event", events[runFinishedIndex]);
  }

  for (const [spanId, span] of spans) {
    if (!span.finished) {
      issue("unclosed_span", `span ${spanId} has no terminal event`, span.started);
    }
  }

  if (reportedRoundtrips !== undefined && reportedRoundtrips !== observedRoundtrips) {
    issue(
      "roundtrip_count_mismatch",
      `run reported ${reportedRoundtrips} roundtrips, observed ${observedRoundtrips}`,
      events[runFinishedIndex!],
      runFinishedIndex,
    );
  }

  return { valid: issues.length === 0, issues };
}

export type SparkAgentTraceEventKind = z.infer<typeof sparkAgentTraceEventKindSchema>;
export type SparkAgentRunSource = z.infer<typeof sparkAgentRunSourceSchema>;
export type SparkAgentTraceOutcome = z.infer<typeof sparkAgentTraceOutcomeSchema>;
export type SparkAgentToolEffect = z.infer<typeof sparkAgentToolEffectSchema>;
export type SparkAgentToolStatus = z.infer<typeof sparkAgentToolStatusSchema>;
export type SparkAgentToolFailureStage = z.infer<typeof sparkAgentToolFailureStageSchema>;
export type SparkAgentToolFailureType = z.infer<typeof sparkAgentToolFailureTypeSchema>;
export type SparkAgentSkillSelectionMode = z.infer<typeof sparkAgentSkillSelectionModeSchema>;
export type SparkAgentSkillLoadStatus = z.infer<typeof sparkAgentSkillLoadStatusSchema>;
export type SparkAgentSkillLoadFailureType = z.infer<
  typeof sparkAgentSkillLoadFailureTypeSchema
>;
export type SparkAgentArgumentFingerprint = z.infer<
  typeof sparkAgentArgumentFingerprintSchema
>;
export type SparkAgentTraceSkill = z.infer<typeof sparkAgentTraceSkillSchema>;
export type SparkAgentTraceEvent = z.infer<typeof sparkAgentTraceEventSchema>;
