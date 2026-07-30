import { z } from "zod";
import { isoDateTimeSchema } from "./refs.ts";

export const sparkTaskClaimLeaseIdentitySchema = z.object({
  workspaceId: z.string().min(1),
  clientId: z.string().min(1),
  leaseFence: z.string().min(1),
  sessionId: z.string().min(1),
});

export const sparkTaskClaimAcquireRequestSchema = sparkTaskClaimLeaseIdentitySchema.extend({
  taskRef: z.string().startsWith("task:"),
  status: z.enum(["pending", "ready", "running", "blocked"]).optional(),
  roleRef: z.string().startsWith("role:").optional(),
  recovery: z
    .object({
      previousSessionId: z.string().min(1),
      reason: z.enum(["claim_expired", "review_needs_changes_owner_inactive"]),
      evidenceRef: z.string().startsWith("evidence:"),
    })
    .optional(),
});

export const sparkTaskClaimReleaseRequestSchema = sparkTaskClaimLeaseIdentitySchema.extend({
  taskRef: z.string().startsWith("task:"),
  disposition: z.enum(["release", "done", "failed", "cancelled"]),
});

export const sparkTaskClaimRecoverRequestSchema = sparkTaskClaimLeaseIdentitySchema.extend({
  taskRef: z.string().startsWith("task:"),
  previousSessionId: z.string().min(1),
  reason: z.enum(["claim_expired", "review_needs_changes_owner_inactive"]),
  evidenceRef: z.string().startsWith("evidence:"),
});

export const sparkTaskClaimMutationResultSchema = z.object({
  taskRef: z.string().startsWith("task:"),
  projectRef: z.string().startsWith("proj:"),
  sessionId: z.string().min(1),
  outcome: z.enum(["acquired", "released", "recovered"]),
  changed: z.boolean(),
  observedAt: isoDateTimeSchema,
  claim: z
    .object({
      claimedAt: isoDateTimeSchema,
      heartbeatAt: isoDateTimeSchema,
      expiresAt: isoDateTimeSchema,
    })
    .optional(),
});

export type SparkTaskClaimLeaseIdentity = z.infer<typeof sparkTaskClaimLeaseIdentitySchema>;
export type SparkTaskClaimAcquireRequest = z.infer<typeof sparkTaskClaimAcquireRequestSchema>;
export type SparkTaskClaimRecoverRequest = z.infer<typeof sparkTaskClaimRecoverRequestSchema>;
export type SparkTaskClaimMutationResult = z.infer<typeof sparkTaskClaimMutationResultSchema>;
