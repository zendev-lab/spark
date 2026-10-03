import { z } from "zod";

export const SPARK_MEMORY_FEEDBACK_OUTCOMES = ["positive", "negative"] as const;
export const SPARK_MEMORY_FEEDBACK_ERROR_CODES = [
  "MEMORY_FEEDBACK_INVALID",
  "MEMORY_FEEDBACK_EXPIRED",
  "MEMORY_FEEDBACK_STALE_MESSAGE",
  "MEMORY_FEEDBACK_CROSS_TURN",
  "MEMORY_FEEDBACK_PROPOSAL_DRIFT",
  "MEMORY_FEEDBACK_AMBIGUOUS",
  "MEMORY_FEEDBACK_REPLAYED",
] as const;
export type SparkMemoryFeedbackOutcome = (typeof SPARK_MEMORY_FEEDBACK_OUTCOMES)[number];
export type SparkMemoryFeedbackErrorCode = (typeof SPARK_MEMORY_FEEDBACK_ERROR_CODES)[number];

export const sparkMemoryFeedbackReceiptSchema = z.object({
  schema: z.literal("spark.memory.feedback-receipt/v1"),
  receiptId: z.string().min(1),
  surface: z.enum(["tui", "hub", "channel", "web"]),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  memoryRef: z.string().regex(/^(?:memory|recall|learning[-:]).+/u),
  outcome: z.enum(SPARK_MEMORY_FEEDBACK_OUTCOMES),
  feedbackDigest: z.string().regex(/^[\da-f]{64}$/u),
  turnHash: z.string().regex(/^[\da-f]{64}$/u),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string().min(1),
  keyId: z.string().regex(/^[\da-f]{64}$/u),
  signature: z.string().min(1),
});
export const sparkMemoryFeedbackReceiptPayloadSchema = sparkMemoryFeedbackReceiptSchema.omit({
  keyId: true,
  signature: true,
});
export type SparkMemoryFeedbackReceipt = z.infer<typeof sparkMemoryFeedbackReceiptSchema>;
export type SparkMemoryFeedbackReceiptPayload = z.infer<
  typeof sparkMemoryFeedbackReceiptPayloadSchema
>;
export type SparkMemoryFeedbackVerificationResult =
  | { ok: true; receipt: SparkMemoryFeedbackReceipt }
  | { ok: false; code: SparkMemoryFeedbackErrorCode };

export const SPARK_MEMORY_APPROVAL_ERROR_CODES = [
  "MEMORY_APPROVAL_REQUIRED",
  "MEMORY_CANONICAL_ASK_REQUIRED",
  "MEMORY_APPROVAL_INVALID",
  "MEMORY_APPROVAL_EXPIRED",
  "MEMORY_APPROVAL_REPLAYED",
  "MEMORY_APPROVAL_SCOPE_MISMATCH",
  "MEMORY_APPROVAL_PROPOSAL_MISMATCH",
  "MEMORY_REVISION_CONFLICT",
] as const;

export type SparkMemoryApprovalErrorCode = (typeof SPARK_MEMORY_APPROVAL_ERROR_CODES)[number];

export const sparkMemoryApprovalErrorCodeSchema = z.enum(SPARK_MEMORY_APPROVAL_ERROR_CODES);

export const SPARK_MEMORY_MUTATION_OPERATIONS = [
  "remember",
  "forget",
  "record",
  "promote",
  "reject",
  "restore",
  "stale",
  "supersede",
  "merge",
  "update",
  "quarantine",
  "purge",
  "pin",
  "unpin",
] as const;

export const SPARK_MEMORY_DIRECT_INTENT_OPERATIONS = ["remember", "forget"] as const;
export const SPARK_MEMORY_DIRECT_INTENT_HIGH_RISK_OPERATIONS = [
  "update",
  "merge",
  "supersede",
  "quarantine",
  "restore",
  "purge",
  "pin",
  "unpin",
] as const;

export const sparkMemoryMutationOperationSchema = z.enum(SPARK_MEMORY_MUTATION_OPERATIONS);

export type SparkMemoryMutationOperation = z.infer<typeof sparkMemoryMutationOperationSchema>;
export type SparkMemoryDirectIntentOperation =
  (typeof SPARK_MEMORY_DIRECT_INTENT_OPERATIONS)[number];
export type SparkMemoryDirectIntentHighRiskOperation =
  (typeof SPARK_MEMORY_DIRECT_INTENT_HIGH_RISK_OPERATIONS)[number];

export const SPARK_MEMORY_DIRECT_INTENT_REASON = "Direct user intent from the current host turn.";

const sparkMemoryDirectIntentSurfaceSchema = z.enum(["tui", "hub", "channel", "web"]);

export const sparkMemoryDirectIntentReceiptSchema = z.object({
  schema: z.literal("spark.memory.direct-intent-receipt/v1"),
  receiptId: z.string().min(1),
  surface: sparkMemoryDirectIntentSurfaceSchema,
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  operation: z.enum(SPARK_MEMORY_DIRECT_INTENT_OPERATIONS),
  scope: z.enum(["user", "workspace", "repo"]),
  recordRef: z.string().regex(/^memory:.+/u),
  expectedRevision: z.number().int().nonnegative().nullable(),
  contentDigest: z
    .string()
    .regex(/^[\da-f]{64}$/u)
    .nullable(),
  intentDigest: z.string().regex(/^[\da-f]{64}$/u),
  turnHash: z.string().regex(/^[\da-f]{64}$/u),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string().min(1),
  keyId: z.string().regex(/^[\da-f]{64}$/u),
  signature: z.string().min(1),
});

export const sparkMemoryDirectIntentReceiptPayloadSchema =
  sparkMemoryDirectIntentReceiptSchema.omit({ keyId: true, signature: true });

export type SparkMemoryDirectIntentReceipt = z.infer<typeof sparkMemoryDirectIntentReceiptSchema>;
export type SparkMemoryDirectIntentReceiptPayload = z.infer<
  typeof sparkMemoryDirectIntentReceiptPayloadSchema
>;

export type SparkMemoryDirectIntentCommand =
  | {
      operation: "remember";
      text: string;
    }
  | {
      operation: "forget";
      recordRef: string;
    };

export interface PrepareSparkMemoryDirectIntentReceiptInput {
  surface: z.infer<typeof sparkMemoryDirectIntentSurfaceSchema>;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  prompt: string;
  now?: Date;
  ttlMs?: number;
  randomId?: () => string;
}

export function parseSparkMemoryFeedbackCommand(
  prompt: string,
): { memoryRef: string; outcome: SparkMemoryFeedbackOutcome } | undefined {
  const normalized = prompt.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) return undefined;
  const match =
    /^(?:memory\s+feedback|记忆反馈)\s+(positive|negative|正向|负向)\s+((?:memory|recall|learning[-:])[^\s]+)$/iu.exec(
      normalized,
    );
  if (!match) return undefined;
  return {
    outcome: match[1] === "positive" || match[1] === "正向" ? "positive" : "negative",
    memoryRef: match[2]!,
  };
}

export async function prepareSparkMemoryFeedbackReceipt(
  input: PrepareSparkMemoryDirectIntentReceiptInput,
): Promise<SparkMemoryFeedbackReceiptPayload | undefined> {
  const command = parseSparkMemoryFeedbackCommand(input.prompt);
  if (!command) return undefined;
  const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID());
  const now = input.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString();
  const feedbackDigest = await sparkMemoryDirectIntentSha256(command);
  const turnHash = await sparkMemoryDirectIntentSha256({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    messageId: input.messageId,
    prompt: input.prompt,
  });
  return sparkMemoryFeedbackReceiptPayloadSchema.parse({
    schema: "spark.memory.feedback-receipt/v1",
    receiptId: `feedback:${randomId()}`,
    surface: input.surface,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    messageId: input.messageId,
    memoryRef: command.memoryRef,
    outcome: command.outcome,
    feedbackDigest,
    turnHash,
    issuedAt,
    expiresAt,
    nonce: randomId(),
  });
}

export function sparkMemoryFeedbackReceiptSigningPayload(value: unknown): string {
  const receipt = sparkMemoryFeedbackReceiptSchema.parse(value);
  const { signature, ...unsigned } = receipt;
  return canonicalJson(unsigned);
}

export async function verifySparkMemoryFeedbackReceipt(
  value: unknown,
  options: {
    trustedKeyId: string;
    verifySignature: (payload: string, signature: string) => Promise<boolean> | boolean;
    now?: Date;
  },
): Promise<SparkMemoryFeedbackVerificationResult> {
  const parsed = sparkMemoryFeedbackReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.keyId !== options.trustedKeyId) {
    return { ok: false, code: "MEMORY_FEEDBACK_INVALID" };
  }
  const receipt = parsed.data;
  const now = (options.now ?? new Date()).getTime();
  if (
    !Number.isFinite(now) ||
    Date.parse(receipt.issuedAt) > now ||
    Date.parse(receipt.expiresAt) <= now
  ) {
    return { ok: false, code: "MEMORY_FEEDBACK_EXPIRED" };
  }
  try {
    const valid = await options.verifySignature(
      sparkMemoryFeedbackReceiptSigningPayload(receipt),
      receipt.signature,
    );
    return valid ? { ok: true, receipt } : { ok: false, code: "MEMORY_FEEDBACK_INVALID" };
  } catch {
    return { ok: false, code: "MEMORY_FEEDBACK_INVALID" };
  }
}

export function classifySparkMemoryFeedbackCurrentTurn(
  value: unknown,
  currentValue: unknown,
  options: { consumed?: boolean } = {},
): SparkMemoryFeedbackVerificationResult {
  const current = sparkMemoryFeedbackReceiptSchema.safeParse(currentValue);
  if (!current.success) return { ok: false, code: "MEMORY_FEEDBACK_AMBIGUOUS" };
  const parsed = sparkMemoryFeedbackReceiptSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "MEMORY_FEEDBACK_INVALID" };
  const receipt = parsed.data;
  if (receipt.sessionId !== current.data.sessionId || receipt.turnId !== current.data.turnId) {
    return { ok: false, code: "MEMORY_FEEDBACK_CROSS_TURN" };
  }
  if (receipt.messageId !== current.data.messageId) {
    return { ok: false, code: "MEMORY_FEEDBACK_STALE_MESSAGE" };
  }
  if (
    receipt.memoryRef !== current.data.memoryRef ||
    receipt.outcome !== current.data.outcome ||
    receipt.feedbackDigest !== current.data.feedbackDigest
  ) {
    return { ok: false, code: "MEMORY_FEEDBACK_PROPOSAL_DRIFT" };
  }
  if (options.consumed) return { ok: false, code: "MEMORY_FEEDBACK_REPLAYED" };
  return { ok: true, receipt };
}

export function parseSparkMemoryFeedbackReceipt(value: unknown): SparkMemoryFeedbackReceipt {
  return sparkMemoryFeedbackReceiptSchema.parse(value);
}

export function parseSparkMemoryDirectIntentCommand(
  prompt: string,
): SparkMemoryDirectIntentCommand | undefined {
  const normalized = prompt.trim();
  if (!normalized || /[\r\n]/u.test(normalized)) return undefined;
  const remember = /^(?:remember(?:\s+that)?|记住)\s*[:：]?\s*(.+)$/iu.exec(normalized);
  const forget = /^(?:forget|忘记)\s*[:：]?\s*(memory:[\w.:/-]+)$/iu.exec(normalized);
  if (remember && forget) return undefined;
  if (forget) return { operation: "forget", recordRef: forget[1]! };
  const text = remember?.[1]?.trim();
  if (text && /(?:\b(?:remember|forget)\b|记住|忘记)/iu.test(text)) return undefined;
  return text ? { operation: "remember", text } : undefined;
}

export function sparkMemoryDirectIntentOperationDisposition(
  operation: SparkMemoryMutationOperation,
): "allowed" | "canonical_ask" {
  return (SPARK_MEMORY_DIRECT_INTENT_OPERATIONS as readonly string[]).includes(operation)
    ? "allowed"
    : "canonical_ask";
}

export async function prepareSparkMemoryDirectIntentReceipt(
  input: PrepareSparkMemoryDirectIntentReceiptInput,
): Promise<SparkMemoryDirectIntentReceiptPayload | undefined> {
  const command = parseSparkMemoryDirectIntentCommand(input.prompt);
  if (!command) return undefined;
  const randomId = input.randomId ?? (() => globalThis.crypto.randomUUID());
  const now = input.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? 5 * 60_000)).toISOString();
  const recordRef =
    command.operation === "remember" ? `memory:direct-${randomId()}` : command.recordRef;
  const content =
    command.operation === "remember"
      ? {
          category: "insight",
          text: command.text,
          reason: SPARK_MEMORY_DIRECT_INTENT_REASON,
          evidenceRefs: [],
          tags: [],
          status: "active",
          forgottenReason: null,
        }
      : undefined;
  const contentDigest = content ? await sparkMemoryDirectIntentSha256(content) : null;
  const intentDigest = await sparkMemoryDirectIntentSha256(
    command.operation === "remember"
      ? { operation: command.operation, recordRef, scope: "workspace", contentDigest }
      : {
          operation: command.operation,
          recordRef,
          reason: SPARK_MEMORY_DIRECT_INTENT_REASON,
        },
  );
  const turnHash = await sparkMemoryDirectIntentSha256({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    messageId: input.messageId,
    prompt: input.prompt,
  });
  return sparkMemoryDirectIntentReceiptPayloadSchema.parse({
    schema: "spark.memory.direct-intent-receipt/v1",
    receiptId: `direct-intent:${randomId()}`,
    surface: input.surface,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    messageId: input.messageId,
    operation: command.operation,
    scope: "workspace",
    recordRef,
    expectedRevision: command.operation === "remember" ? 0 : null,
    contentDigest,
    intentDigest,
    turnHash,
    issuedAt,
    expiresAt,
    nonce: randomId(),
  });
}

export function sparkMemoryDirectIntentReceiptSigningPayload(value: unknown): string {
  const receipt = sparkMemoryDirectIntentReceiptSchema.parse(value);
  const { signature, ...unsigned } = receipt;
  return canonicalJson(unsigned);
}

export async function verifySparkMemoryDirectIntentReceipt(
  value: unknown,
  options: {
    trustedKeyId: string;
    verifySignature: (payload: string, signature: string) => Promise<boolean> | boolean;
    now?: Date;
  },
): Promise<boolean> {
  const parsed = sparkMemoryDirectIntentReceiptSchema.safeParse(value);
  if (!parsed.success) return false;
  const receipt = parsed.data;
  if (receipt.keyId !== options.trustedKeyId) return false;
  const now = (options.now ?? new Date()).getTime();
  if (
    !Number.isFinite(now) ||
    Date.parse(receipt.issuedAt) > now ||
    Date.parse(receipt.expiresAt) <= now
  ) {
    return false;
  }
  try {
    return await options.verifySignature(
      sparkMemoryDirectIntentReceiptSigningPayload(receipt),
      receipt.signature,
    );
  } catch {
    return false;
  }
}

export async function createSparkMemoryDirectIntentApprovalProof(
  receiptValue: unknown,
  proposalValue: unknown,
): Promise<SparkMemoryApprovalProof> {
  const receipt = parseSparkMemoryDirectIntentReceipt(receiptValue);
  const proposal = parseSparkMemoryProposal(proposalValue);
  if (sparkMemoryDirectIntentOperationDisposition(proposal.operation) !== "allowed") {
    throw new Error("MEMORY_CANONICAL_ASK_REQUIRED: operation is not eligible for direct intent");
  }
  const bindings: Array<[unknown, unknown, string]> = [
    [receipt.workspaceId, proposal.workspaceId, "workspaceId"],
    [receipt.operation, proposal.operation, "operation"],
    [receipt.scope, proposal.scope, "scope"],
    [receipt.recordRef, proposal.recordRef, "recordRef"],
    [receipt.expiresAt, proposal.expiresAt, "expiresAt"],
  ];
  if (receipt.expectedRevision !== null) {
    bindings.push([receipt.expectedRevision, proposal.expectedRevision, "expectedRevision"]);
  }
  if (receipt.contentDigest !== null) {
    bindings.push([receipt.contentDigest, proposal.contentDigest, "contentDigest"]);
  }
  for (const [receiptValueForField, proposalValueForField, field] of bindings) {
    if (receiptValueForField !== proposalValueForField) {
      throw new Error(`MEMORY_APPROVAL_PROPOSAL_MISMATCH: direct-intent ${field} mismatch`);
    }
  }
  return sparkMemoryApprovalProofSchema.parse({
    schema: "spark.memory.approval-proof/v1",
    proofRef: receipt.receiptId,
    workspaceId: proposal.workspaceId,
    recordRef: proposal.recordRef,
    proposalId: proposal.proposalId,
    operation: proposal.operation,
    proposalDigest: proposal.proposalDigest,
    scope: proposal.scope,
    expectedRevision: proposal.expectedRevision,
    issuedAt: receipt.issuedAt,
    expiresAt: receipt.expiresAt,
    nonce: receipt.nonce,
    answerDigest: await sparkMemoryDirectIntentSha256({
      receiptId: receipt.receiptId,
      turnHash: receipt.turnHash,
      intentDigest: receipt.intentDigest,
      keyId: receipt.keyId,
      signature: receipt.signature,
    }),
  });
}

export async function sparkMemoryDirectIntentAnswerDigest(receiptValue: unknown): Promise<string> {
  const receipt = parseSparkMemoryDirectIntentReceipt(receiptValue);
  return await sparkMemoryDirectIntentSha256({
    receiptId: receipt.receiptId,
    turnHash: receipt.turnHash,
    intentDigest: receipt.intentDigest,
    keyId: receipt.keyId,
    signature: receipt.signature,
  });
}

export async function sparkMemoryDirectIntentSha256(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseSparkMemoryDirectIntentReceipt(
  value: unknown,
): SparkMemoryDirectIntentReceipt {
  return sparkMemoryDirectIntentReceiptSchema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("direct-intent payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`direct-intent payload contains unsupported ${typeof value}`);
}

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
