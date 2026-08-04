import { z } from "zod";
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
export type SparkLoopView = z.infer<typeof sparkLoopViewSchema>;
export type SparkLoopStartRequest = z.infer<typeof sparkLoopStartRequestSchema>;
export type SparkLoopStatusRequest = z.infer<typeof sparkLoopStatusRequestSchema>;
export type SparkLoopMutationRequest = z.infer<typeof sparkLoopMutationRequestSchema>;
export type SparkLoopWakeRequest = z.infer<typeof sparkLoopWakeRequestSchema>;
export type SparkLoopScheduleRequest = z.infer<typeof sparkLoopScheduleRequestSchema>;
export type SparkLoopListResult = z.infer<typeof sparkLoopListResultSchema>;
export type SparkLoopMutationResult = z.infer<typeof sparkLoopMutationResultSchema>;
