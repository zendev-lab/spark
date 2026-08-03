import { z } from "zod";

export const SPARK_MEMORY_APPROVAL_ERROR_CODES = [
  "MEMORY_APPROVAL_REQUIRED",
  "MEMORY_APPROVAL_INVALID",
  "MEMORY_APPROVAL_EXPIRED",
  "MEMORY_APPROVAL_REPLAYED",
  "MEMORY_APPROVAL_SCOPE_MISMATCH",
  "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
  "MEMORY_REVISION_CONFLICT",
] as const;

export type SparkMemoryApprovalErrorCode = (typeof SPARK_MEMORY_APPROVAL_ERROR_CODES)[number];

export const sparkMemoryApprovalErrorCodeSchema = z.enum(SPARK_MEMORY_APPROVAL_ERROR_CODES);

export const sparkMemoryMutationOperationSchema = z.enum([
  "remember",
  "forget",
  "record",
  "promote",
  "reject",
  "restore",
  "stale",
  "supersede",
  "merge",
]);

export type SparkMemoryMutationOperation = z.infer<typeof sparkMemoryMutationOperationSchema>;

const sha256Schema = z.string().regex(/^[\da-f]{64}$/u);

export const sparkMemoryProposalSchema = z.object({
  schema: z.literal("spark.memory.proposal/v1"),
  proposalId: z.string().min(1),
  operation: sparkMemoryMutationOperationSchema,
  workspaceId: z.string().min(1),
  scope: z.enum(["user", "workspace", "repo", "project", "agent"]),
  recordRef: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  contentDigest: sha256Schema,
  proposalDigest: sha256Schema,
  expiresAt: z.string().datetime({ offset: true }),
});

export type SparkMemoryProposal = z.infer<typeof sparkMemoryProposalSchema>;

export const sparkMemoryApprovalBindingSchema = z.object({
  workspaceId: z.string().min(1),
  recordRef: z.string().min(1),
  proposalId: z.string().min(1),
  operation: sparkMemoryMutationOperationSchema,
  proposalDigest: sha256Schema,
  scope: z.enum(["user", "workspace", "repo", "project", "agent"]),
  expectedRevision: z.number().int().nonnegative(),
  nonce: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export type SparkMemoryApprovalBinding = z.infer<typeof sparkMemoryApprovalBindingSchema>;

export const sparkMemoryApprovalProofSchema = z.object({
  schema: z.literal("spark.memory.approval-proof/v1"),
  proofRef: z.string().min(1),
  workspaceId: z.string().min(1),
  recordRef: z.string().min(1),
  proposalId: z.string().min(1),
  operation: sparkMemoryMutationOperationSchema,
  proposalDigest: sha256Schema,
  scope: z.enum(["user", "workspace", "repo", "project", "agent"]),
  expectedRevision: z.number().int().nonnegative(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string().min(1),
  answerDigest: sha256Schema,
});

export type SparkMemoryApprovalProof = z.infer<typeof sparkMemoryApprovalProofSchema>;

export const sparkMemoryApprovalAuthorizationSchema = z
  .object({
    proposal: sparkMemoryProposalSchema,
    proof: sparkMemoryApprovalProofSchema,
  })
  .superRefine(({ proposal, proof }, context) => {
    const fields: Array<[keyof SparkMemoryProposal, keyof SparkMemoryApprovalProof]> = [
      ["workspaceId", "workspaceId"],
      ["recordRef", "recordRef"],
      ["proposalId", "proposalId"],
      ["operation", "operation"],
      ["proposalDigest", "proposalDigest"],
      ["scope", "scope"],
      ["expectedRevision", "expectedRevision"],
      ["expiresAt", "expiresAt"],
    ];
    for (const [proposalKey, proofKey] of fields) {
      if (proposal[proposalKey] !== proof[proofKey]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["proof", proofKey],
          message: `${String(proofKey)} must match proposal.${String(proposalKey)}`,
        });
      }
    }
  });

export type SparkMemoryApprovalAuthorization = z.infer<
  typeof sparkMemoryApprovalAuthorizationSchema
>;

export const sparkMemoryRevisionCommitSchema = z.object({
  schema: z.literal("spark.memory.revision-commit/v1"),
  transactionId: z.string().min(1),
  workspaceId: z.string().min(1),
  recordRef: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  revisionRef: z.string().min(1),
  proposalDigest: sha256Schema,
  proofRef: z.string().min(1),
  contentDigest: sha256Schema,
  committedAt: z.string().datetime({ offset: true }),
});

export type SparkMemoryRevisionCommit = z.infer<typeof sparkMemoryRevisionCommitSchema>;

export function parseSparkMemoryApprovalBinding(value: unknown): SparkMemoryApprovalBinding {
  return sparkMemoryApprovalBindingSchema.parse(value);
}

export function parseSparkMemoryProposal(value: unknown): SparkMemoryProposal {
  return sparkMemoryProposalSchema.parse(value);
}

export function parseSparkMemoryApprovalProof(value: unknown): SparkMemoryApprovalProof {
  return sparkMemoryApprovalProofSchema.parse(value);
}

export function parseSparkMemoryApprovalAuthorization(
  value: unknown,
): SparkMemoryApprovalAuthorization {
  return sparkMemoryApprovalAuthorizationSchema.parse(value);
}


export function parseSparkMemoryRevisionCommit(value: unknown): SparkMemoryRevisionCommit {
  return sparkMemoryRevisionCommitSchema.parse(value);
}
