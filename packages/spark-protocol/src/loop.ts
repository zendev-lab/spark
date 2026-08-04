import { z } from "zod";
import { sparkProtocolJsonObjectSchema, sparkProtocolJsonValueSchema } from "./command-events.ts";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkLoopStatusOptions = [
  "scheduled",
  "running",
  "retry_wait",
  "dormant",
  "paused",
  "blocked",
  "completed",
  "stopped",
] as const;

export const sparkLoopCycleStepOptions = ["before_tick", "invoke", "after_tick", "settle"] as const;
export const sparkLoopContinuityOptions = ["session", "fresh"] as const;

export const sparkLoopStatusSchema = z.enum(sparkLoopStatusOptions);
export const sparkLoopCycleStepSchema = z.enum(sparkLoopCycleStepOptions);
export const sparkLoopContinuitySchema = z.enum(sparkLoopContinuityOptions);

export const sparkLoopEvaluatorSelectorSchema = z.string().regex(/^(builtin|extension):[^:]+$/u);

export const sparkLoopBooleanExpressionSchema: z.ZodType<SparkLoopBooleanExpression> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("literal"), value: z.boolean() }),
    z.object({ op: z.literal("not"), value: sparkLoopBooleanExpressionSchema }),
    z.object({ op: z.literal("and"), values: z.array(sparkLoopBooleanExpressionSchema).min(1) }),
    z.object({ op: z.literal("or"), values: z.array(sparkLoopBooleanExpressionSchema).min(1) }),
    z.object({
      op: z.literal("eq"),
      path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/u),
      value: sparkProtocolJsonValueSchema,
    }),
    z.object({
      op: z.literal("exists"),
      path: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/u),
    }),
  ]),
);

export type SparkLoopBooleanExpression =
  | { op: "literal"; value: boolean }
  | { op: "not"; value: SparkLoopBooleanExpression }
  | { op: "and" | "or"; values: SparkLoopBooleanExpression[] }
  | { op: "eq"; path: string; value: unknown }
  | { op: "exists"; path: string };

export const sparkLoopConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expression"), expression: sparkLoopBooleanExpressionSchema }),
  z.object({
    kind: z.literal("evaluator"),
    selector: sparkLoopEvaluatorSelectorSchema,
    input: sparkProtocolJsonObjectSchema.default({}),
  }),
]);

const loopDelayMsSchema = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 60 * 60_000);

export const sparkLoopBeforeTickRuleSchema = z.object({
  id: z.string().min(1),
  when: sparkLoopConditionSchema,
  then: z.discriminatedUnion("action", [
    z.object({ action: z.literal("skip"), delayMs: loopDelayMsSchema }),
    z.object({ action: z.literal("pause") }),
    z.object({ action: z.literal("block") }),
    z.object({ action: z.literal("proceed") }),
  ]),
});

export const sparkLoopAfterTickRuleSchema = z.object({
  id: z.string().min(1),
  when: sparkLoopConditionSchema,
  then: z.discriminatedUnion("action", [
    z.object({ action: z.literal("schedule"), delayMs: loopDelayMsSchema }),
    z.object({ action: z.literal("pause") }),
    z.object({ action: z.literal("block") }),
    z.object({ action: z.literal("complete") }),
  ]),
});

export const sparkLoopCompletionEvaluatorSchema = z.object({
  selector: sparkLoopEvaluatorSelectorSchema,
  input: sparkProtocolJsonObjectSchema.default({}),
});

export const sparkLoopPolicySchema = z.object({
  cadenceMs: loopDelayMsSchema.default(30_000),
  retry: z
    .object({
      maxAttempts: z.number().int().min(0).max(20).default(3),
      delaysMs: z.array(loopDelayMsSchema).min(1).default([30_000, 60_000, 120_000]),
    })
    .default({ maxAttempts: 3, delaysMs: [30_000, 60_000, 120_000] }),
  beforeTick: z.array(sparkLoopBeforeTickRuleSchema).default([]),
  afterTick: z.array(sparkLoopAfterTickRuleSchema).default([]),
  completion: sparkLoopCompletionEvaluatorSchema.optional(),
});

export const sparkLoopConditionReceiptVerdictSchema = z.enum([
  "matched",
  "not_matched",
  "achieved",
  "not_achieved",
  "cannot_progress",
  "error",
]);

export const sparkLoopConditionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  checkpoint: sparkLoopCycleStepSchema,
  selector: z.string().min(1),
  inputSummary: sparkProtocolJsonObjectSchema.default({}),
  definitionDigest: z.string().min(1),
  verdict: sparkLoopConditionReceiptVerdictSchema,
  reason: z.string().min(1),
  remainingWork: z.string().min(1).optional(),
  blockers: z.array(z.string().min(1)).default([]),
  evidenceRefs: z
    .array(
      z
        .string()
        .regex(/^evidence:.+/u)
        .transform((value) => value as `evidence:${string}`),
    )
    .default([]),
  evaluatedAt: isoDateTimeSchema,
});

export const sparkLoopCycleCheckpointSchema = z.object({
  cycleId: z.string().min(1),
  generation: z.number().int().positive(),
  step: sparkLoopCycleStepSchema,
  startedAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  workflowDefinitionDigest: z.string().min(1).optional(),
  tick: z
    .object({
      invocationId: z.string().min(1),
      status: z.enum(["succeeded", "failed", "cancelled"]),
      resultDigest: z.string().min(1).optional(),
      completedAt: isoDateTimeSchema,
    })
    .optional(),
  requestedSchedule: z
    .object({
      dueAt: isoDateTimeSchema,
      reason: z.string().optional(),
      prompt: z.string().optional(),
    })
    .optional(),
  nextTickContext: z
    .object({
      remainingWork: z.string().min(1).optional(),
      blockers: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  receipts: z.array(sparkLoopConditionReceiptSchema).default([]),
  beforeAttempt: z.number().int().nonnegative().default(0),
  afterAttempt: z.number().int().nonnegative().default(0),
});

export const sparkLoopCountersSchema = z.object({
  tickCount: z.number().int().nonnegative().default(0),
  skippedCount: z.number().int().nonnegative().default(0),
  llmRequestsAvoided: z.number().int().nonnegative().default(0),
  conditionRetryCount: z.number().int().nonnegative().default(0),
});

/**
 * A Loop may be related to domain state without becoming a different runtime
 * kind. These refs describe ownership; they do not select another executor.
 */
export const sparkLoopBindingSchema = z
  .object({
    goalId: z.string().min(1).optional(),
    workflowRunId: z.string().min(1).optional(),
    reproId: z.string().min(1).optional(),
  })
  .default({});

export const sparkLoopViewSchema = z.object({
  loopId: z.string().min(1),
  ownerSessionId: z.string().min(1),
  status: sparkLoopStatusSchema,
  continuity: sparkLoopContinuitySchema,
  generation: z.number().int().positive(),
  cycleStep: sparkLoopCycleStepSchema.optional(),
  binding: sparkLoopBindingSchema,
  policy: sparkLoopPolicySchema,
  checkpoint: sparkLoopCycleCheckpointSchema.optional(),
  counters: sparkLoopCountersSchema,
  dueAt: isoDateTimeSchema.optional(),
  attempt: z.number().int().nonnegative(),
  lastInvocationId: z.string().min(1).optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

const loopRouteSchema = z.object({
  cwd: z.string().min(1),
  workspaceBindingId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export const sparkLoopStartRequestSchema = loopRouteSchema.extend({
  loopId: z.string().min(1).optional(),
  ownerSessionId: z.string().min(1),
  continuity: sparkLoopContinuitySchema.default("session"),
  binding: sparkLoopBindingSchema.optional(),
  policy: sparkLoopPolicySchema.optional(),
  prompt: z.string().min(1),
  dueAt: isoDateTimeSchema.optional(),
  reason: z.string().optional(),
  domainStateDigest: z.string().min(1).optional(),
});

export const sparkLoopStatusRequestSchema = z.object({
  loopId: z.string().min(1).optional(),
  ownerSessionId: z.string().min(1).optional(),
  includeTerminal: z.boolean().default(false),
});

export const sparkLoopMutationRequestSchema = z.object({
  loopId: z.string().min(1),
  reason: z.string().optional(),
});

export const sparkLoopWakeRequestSchema = sparkLoopMutationRequestSchema.extend({
  prompt: z.string().min(1).optional(),
});

/** The generation is a daemon-issued compare-and-swap token. */
export const sparkLoopScheduleRequestSchema = z
  .object({
    loopId: z.string().min(1),
    generation: z.number().int().positive(),
    dueAt: isoDateTimeSchema.optional(),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60 * 60_000)
      .optional(),
    reason: z.string().optional(),
    prompt: z.string().min(1).optional(),
  })
  .refine((request) => request.dueAt !== undefined || request.delayMs !== undefined, {
    message: "dueAt or delayMs is required",
    path: ["dueAt"],
  });

export const sparkLoopListResultSchema = z.object({
  loops: z.array(sparkLoopViewSchema),
  observedAt: isoDateTimeSchema,
});

export const sparkLoopMutationResultSchema = z.object({
  loop: sparkLoopViewSchema,
  observedAt: isoDateTimeSchema,
});

export type SparkLoopStatus = z.infer<typeof sparkLoopStatusSchema>;
export type SparkLoopCycleStep = z.infer<typeof sparkLoopCycleStepSchema>;
export type SparkLoopContinuity = z.infer<typeof sparkLoopContinuitySchema>;
export type SparkLoopBinding = z.infer<typeof sparkLoopBindingSchema>;
export type SparkLoopCondition = z.infer<typeof sparkLoopConditionSchema>;
export type SparkLoopBeforeTickRule = z.infer<typeof sparkLoopBeforeTickRuleSchema>;
export type SparkLoopAfterTickRule = z.infer<typeof sparkLoopAfterTickRuleSchema>;
export type SparkLoopPolicyInput = z.input<typeof sparkLoopPolicySchema>;
export type SparkLoopPolicy = z.infer<typeof sparkLoopPolicySchema>;
export type SparkLoopConditionReceipt = z.infer<typeof sparkLoopConditionReceiptSchema>;
export type SparkLoopCycleCheckpoint = z.infer<typeof sparkLoopCycleCheckpointSchema>;
export type SparkLoopCounters = z.infer<typeof sparkLoopCountersSchema>;
export type SparkLoopView = z.infer<typeof sparkLoopViewSchema>;
export type SparkLoopStartRequest = z.input<typeof sparkLoopStartRequestSchema>;
export type SparkLoopStatusRequest = z.infer<typeof sparkLoopStatusRequestSchema>;
export type SparkLoopMutationRequest = z.infer<typeof sparkLoopMutationRequestSchema>;
export type SparkLoopWakeRequest = z.infer<typeof sparkLoopWakeRequestSchema>;
export type SparkLoopScheduleRequest = z.infer<typeof sparkLoopScheduleRequestSchema>;
export type SparkLoopListResult = z.infer<typeof sparkLoopListResultSchema>;
export type SparkLoopMutationResult = z.infer<typeof sparkLoopMutationResultSchema>;
