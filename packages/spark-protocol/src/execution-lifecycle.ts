import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const EXECUTION_TERMINAL_IMMUTABLE = "EXECUTION_TERMINAL_IMMUTABLE" as const;
export const EXECUTION_FENCE_MISMATCH = "EXECUTION_FENCE_MISMATCH" as const;

export const executionRunStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "blocked",
  "recovery_required",
]);

export const executionAttemptStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "blocked",
  "recovery_required",
  "cancelled",
]);

export const executionPauseReasonSchema = z.enum([
  "session_shutdown",
  "daemon_restart",
  "launchagent_handoff",
  "process_interrupted",
  "lease_expired",
  "owner_detached",
]);

export const executionRecoveryReasonSchema = z.enum([
  "side_effect_uncertain",
  "checkpoint_invalid",
  "model_unavailable",
  "stale_generation",
  "missing_owner",
  "manual_reconcile",
]);

export const executionFenceSchema = z.object({
  daemonGeneration: z.number().int().positive(),
  stateRevision: z.number().int().nonnegative(),
  leaseToken: z.string().min(1),
});

export const executionRunSchema = z.object({
  runRef: z.string().regex(/^run:[^:]+$/u),
  invocationId: z.string().min(1).optional(),
  taskRef: z
    .string()
    .regex(/^task:[^:]+$/u)
    .optional(),
  projectRef: z
    .string()
    .regex(/^proj:[^:]+$/u)
    .optional(),
  workspaceId: z.string().min(1).optional(),
  status: executionRunStatusSchema,
  stateRevision: z.number().int().nonnegative(),
  pauseReason: executionPauseReasonSchema.optional(),
  recoveryReason: executionRecoveryReasonSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional(),
  finishedAt: isoDateTimeSchema.optional(),
});

export const executionAttemptSchema = z.object({
  attemptId: z.string().regex(/^attempt:[^:]+$/u),
  runRef: z.string().regex(/^run:[^:]+$/u),
  attempt: z.number().int().positive(),
  parentAttemptId: z
    .string()
    .regex(/^attempt:[^:]+$/u)
    .optional(),
  status: executionAttemptStatusSchema,
  daemonGeneration: z.number().int().positive(),
  stateRevision: z.number().int().nonnegative(),
  leaseToken: z.string().min(1),
  checkpointRevision: z.number().int().nonnegative(),
  startedAt: isoDateTimeSchema.optional(),
  finishedAt: isoDateTimeSchema.optional(),
});

export const executionCheckpointSchema = z.object({
  checkpointId: z.string().min(1),
  runRef: z.string().regex(/^run:[^:]+$/u),
  attemptId: z.string().regex(/^attempt:[^:]+$/u),
  revision: z.number().int().positive(),
  payload: z.unknown(),
  createdAt: isoDateTimeSchema,
});

export const executionProjectionSchema = z.object({
  runRef: z.string().regex(/^run:[^:]+$/u),
  taskRef: z
    .string()
    .regex(/^task:[^:]+$/u)
    .optional(),
  projectRef: z
    .string()
    .regex(/^proj:[^:]+$/u)
    .optional(),
  workspaceId: z.string().min(1).optional(),
  status: executionRunStatusSchema,
  stateRevision: z.number().int().nonnegative(),
  activeAttempt: executionAttemptSchema.optional(),
  pauseReason: executionPauseReasonSchema.optional(),
  recoveryReason: executionRecoveryReasonSchema.optional(),
  updatedAt: isoDateTimeSchema,
});

export type ExecutionRunWire = z.infer<typeof executionRunSchema>;
export type ExecutionAttemptWire = z.infer<typeof executionAttemptSchema>;
export type ExecutionCheckpointWire = z.infer<typeof executionCheckpointSchema>;
export type ExecutionProjectionWire = z.infer<typeof executionProjectionSchema>;
