import { z } from "zod";
import { isoDateTimeSchema, prefixedIdSchema } from "./refs.ts";

export const workspaceDelegationStatusOptions = [
  "queued",
  "retry_wait",
  "delivering",
  "running",
  "awaiting_source",
  "cancelling",
  "completed",
  "rejected",
  "failed",
  "cancelled",
] as const;

export const workspaceDelegationStatusSchema = z.enum(workspaceDelegationStatusOptions);

export const workspaceDelegationActorSchema = z.object({
  kind: z.enum(["hub_owner", "workspace_main_session"]),
  id: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
});

export const workspaceDelegationRequestSchema = z
  .object({
    delegationId: prefixedIdSchema("dlg"),
    sourceWorkspaceId: prefixedIdSchema("ws"),
    targetWorkspaceId: prefixedIdSchema("ws"),
    goal: z.string().trim().min(1).max(16_384),
    constraints: z.array(z.string().trim().min(1).max(2_048)).max(32).default([]),
    requestedRole: z.string().trim().min(1).max(256).optional(),
    actor: workspaceDelegationActorSchema,
    lineage: z.array(prefixedIdSchema("ws")).max(3).default([]),
    hopCount: z.number().int().min(1).max(4).default(1),
    idempotencyKey: prefixedIdSchema("idem"),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((request, context) => {
    if (request.sourceWorkspaceId === request.targetWorkspaceId) {
      context.addIssue({
        code: "custom",
        path: ["targetWorkspaceId"],
        message: "A workspace cannot delegate to itself",
      });
    }
    const path = [...request.lineage, request.sourceWorkspaceId];
    if (new Set(path).size !== path.length || path.includes(request.targetWorkspaceId)) {
      context.addIssue({
        code: "custom",
        path: ["lineage"],
        message: "Delegation lineage must not repeat a workspace or include the target",
      });
    }
    if (request.hopCount !== request.lineage.length + 1) {
      context.addIssue({
        code: "custom",
        path: ["hopCount"],
        message: "Delegation hopCount must be one plus lineage length",
      });
    }
  });

export const workspaceDelegationVerificationSchema = z.object({
  label: z.string().trim().min(1).max(256),
  status: z.enum(["passed", "failed", "unknown"]),
  summary: z.string().trim().min(1).max(2_048).optional(),
});

export const workspaceDelegationArtifactRefSchema = z
  .string()
  .regex(/^artifact:.+$/u, "must be a workspace artifact: ref");

export const workspaceDelegationReceiptSchema = z.object({
  outcome: z.enum(["completed", "rejected", "needs_input", "failed", "cancelled"]),
  summary: z.string().trim().min(1).max(16_384),
  artifactRefs: z.array(workspaceDelegationArtifactRefSchema).max(32).default([]),
  verification: z.array(workspaceDelegationVerificationSchema).max(32).default([]),
});

export const workspaceDelegationMessageKindSchema = z.enum([
  "request",
  "question",
  "reply",
  "receipt",
  "cancel",
]);

export const workspaceDelegationDeliverySchema = z
  .object({
    delegationId: prefixedIdSchema("dlg"),
    messageSequence: z.number().int().positive(),
    kind: workspaceDelegationMessageKindSchema,
    sourceWorkspaceId: prefixedIdSchema("ws"),
    targetWorkspaceId: prefixedIdSchema("ws"),
    request: workspaceDelegationRequestSchema.optional(),
    text: z.string().trim().min(1).max(16_384).optional(),
    receipt: workspaceDelegationReceiptSchema.optional(),
  })
  .superRefine((delivery, context) => {
    if (delivery.request) {
      for (const [field, actual, expected] of [
        ["delegationId", delivery.delegationId, delivery.request.delegationId],
        ["sourceWorkspaceId", delivery.sourceWorkspaceId, delivery.request.sourceWorkspaceId],
        ["targetWorkspaceId", delivery.targetWorkspaceId, delivery.request.targetWorkspaceId],
      ] as const) {
        if (actual !== expected) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} must match the delegation request snapshot`,
          });
        }
      }
    }
    if (delivery.kind === "request" && !delivery.request) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "A delegation request delivery requires a request snapshot",
      });
    }
    if ((delivery.kind === "question" || delivery.kind === "reply") && !delivery.text) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: `${delivery.kind} requires text`,
      });
    }
    if (delivery.kind === "receipt" && !delivery.receipt) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "A receipt delivery requires a structured receipt",
      });
    }
  });

export const workspaceDelegationActionSchema = z.enum([
  "create",
  "get",
  "list",
  "ask",
  "reply",
  "complete",
  "reject",
  "cancel",
]);

export const workspaceDelegationExecuteRequestSchema = z.object({
  action: workspaceDelegationActionSchema,
  sessionId: z.string().trim().min(1),
  invocationId: prefixedIdSchema("inv").optional(),
  delegationId: prefixedIdSchema("dlg").optional(),
  targetWorkspaceId: prefixedIdSchema("ws").optional(),
  goal: z.string().trim().min(1).max(16_384).optional(),
  constraints: z.array(z.string().trim().min(1).max(2_048)).max(32).optional(),
  requestedRole: z.string().trim().min(1).max(256).optional(),
  text: z.string().trim().min(1).max(16_384).optional(),
  artifacts: z.array(workspaceDelegationArtifactRefSchema).max(32).optional(),
  verification: z.array(workspaceDelegationVerificationSchema).max(32).optional(),
  idempotencyKey: prefixedIdSchema("idem").optional(),
});

export const workspaceDelegationProjectionSchema = z.object({
  delegationId: prefixedIdSchema("dlg"),
  workspaceId: prefixedIdSchema("ws"),
  role: z.enum(["source", "target"]),
  status: workspaceDelegationStatusSchema,
  request: workspaceDelegationRequestSchema,
  receipt: workspaceDelegationReceiptSchema.optional(),
  messageSequence: z.number().int().nonnegative(),
  invocationId: prefixedIdSchema("inv").optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const workspaceDelegationExecuteResultSchema = z.object({
  action: workspaceDelegationActionSchema,
  delegation: workspaceDelegationProjectionSchema.optional(),
  delegations: z.array(workspaceDelegationProjectionSchema).optional(),
  accepted: z.boolean().optional(),
});

export type WorkspaceDelegationStatus = z.infer<typeof workspaceDelegationStatusSchema>;
export type WorkspaceDelegationActor = z.infer<typeof workspaceDelegationActorSchema>;
export type WorkspaceDelegationRequest = z.infer<typeof workspaceDelegationRequestSchema>;
export type WorkspaceDelegationVerification = z.infer<typeof workspaceDelegationVerificationSchema>;
export type WorkspaceDelegationReceipt = z.infer<typeof workspaceDelegationReceiptSchema>;
export type WorkspaceDelegationDelivery = z.infer<typeof workspaceDelegationDeliverySchema>;
export type WorkspaceDelegationAction = z.infer<typeof workspaceDelegationActionSchema>;
export type WorkspaceDelegationExecuteRequest = z.infer<
  typeof workspaceDelegationExecuteRequestSchema
>;
export type WorkspaceDelegationProjection = z.infer<typeof workspaceDelegationProjectionSchema>;
export type WorkspaceDelegationExecuteResult = z.infer<
  typeof workspaceDelegationExecuteResultSchema
>;
