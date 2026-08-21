import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import {
  parseSparkMemoryDirectIntentReceipt,
  parseSparkMemoryFeedbackReceipt,
  prepareSparkMemoryDirectIntentReceipt,
  prepareSparkMemoryFeedbackReceipt,
  sparkMemoryDirectIntentReceiptSchema,
  sparkMemoryDirectIntentReceiptSigningPayload,
  sparkMemoryDirectIntentSha256,
  sparkMemoryFeedbackReceiptSchema,
  sparkMemoryFeedbackReceiptSigningPayload,
  verifySparkMemoryDirectIntentReceipt,
  verifySparkMemoryFeedbackReceipt,
  type PrepareSparkMemoryDirectIntentReceiptInput,
  type SparkMemoryDirectIntentReceipt,
  type SparkMemoryFeedbackReceipt,
  type SparkMemoryFeedbackVerificationResult,
} from "@zendev-lab/spark-protocol";

export interface SparkMemoryDirectIntentTurnAuthority {
  readonly keyId: string;
  issue(
    input: PrepareSparkMemoryDirectIntentReceiptInput,
  ): Promise<SparkMemoryDirectIntentReceipt | undefined>;
  currentReceipt(): SparkMemoryDirectIntentReceipt | undefined;
  verifyCurrent(value: unknown): Promise<boolean>;
  issueFeedback(
    input: PrepareSparkMemoryDirectIntentReceiptInput,
  ): Promise<SparkMemoryFeedbackReceipt | undefined>;
  currentFeedbackReceipt(): SparkMemoryFeedbackReceipt | undefined;
  verifyCurrentFeedback(value: unknown): Promise<SparkMemoryFeedbackVerificationResult>;
  commitCurrentFeedback(value: unknown): boolean;
  releaseCurrentFeedback(value: unknown): boolean;
  clear(): void;
}

/**
 * Memory-owned one-turn authority. The private key and exact prompt binding stay
 * inside this closure; only the signed public receipt reaches capability code.
 */
export function createSparkMemoryDirectIntentTurnAuthority(): SparkMemoryDirectIntentTurnAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(publicKeyDer).digest("hex");
  let currentFeedback:
    | {
        receipt: SparkMemoryFeedbackReceipt;
        prompt: string;
        state: "pending" | "reserved" | "committed";
      }
    | undefined;
  let current:
    | {
        receipt: SparkMemoryDirectIntentReceipt;
        prompt: string;
      }
    | undefined;

  return {
    keyId,
    async issue(input) {
      const payload = await prepareSparkMemoryDirectIntentReceipt(input);
      if (!payload) {
        current = undefined;
        return undefined;
      }
      const unsigned = sparkMemoryDirectIntentReceiptSchema.parse({
        ...payload,
        keyId,
        signature: "pending",
      });
      const signingPayload = sparkMemoryDirectIntentReceiptSigningPayload(unsigned);
      const signature = sign(null, Buffer.from(signingPayload), privateKey).toString("base64url");
      const receipt = sparkMemoryDirectIntentReceiptSchema.parse({ ...payload, keyId, signature });
      current = { receipt, prompt: input.prompt };
      return receipt;
    },
    currentReceipt() {
      return current?.receipt;
    },
    async verifyCurrent(value) {
      if (!current) return false;
      const parsed = sparkMemoryDirectIntentReceiptSchema.safeParse(value);
      if (!parsed.success) return false;
      const receipt = parsed.data;
      if (canonicalReceipt(receipt) !== canonicalReceipt(current.receipt)) return false;
      const expectedTurnHash = await sparkMemoryDirectIntentSha256({
        workspaceId: receipt.workspaceId,
        sessionId: receipt.sessionId,
        turnId: receipt.turnId,
        messageId: receipt.messageId,
        prompt: current.prompt,
      });
      if (receipt.turnHash !== expectedTurnHash) return false;
      return await verifySparkMemoryDirectIntentReceipt(receipt, {
        trustedKeyId: keyId,
        verifySignature: (payload, signature) =>
          verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url")),
      });
    },
    async issueFeedback(input) {
      const payload = await prepareSparkMemoryFeedbackReceipt(input);
      if (!payload) {
        currentFeedback = undefined;
        return undefined;
      }
      const unsigned = sparkMemoryFeedbackReceiptSchema.parse({
        ...payload,
        keyId,
        signature: "pending",
      });
      const signature = sign(
        null,
        Buffer.from(sparkMemoryFeedbackReceiptSigningPayload(unsigned)),
        privateKey,
      ).toString("base64url");
      const receipt = sparkMemoryFeedbackReceiptSchema.parse({ ...payload, keyId, signature });
      currentFeedback = { receipt, prompt: input.prompt, state: "pending" };
      return receipt;
    },
    currentFeedbackReceipt() {
      return currentFeedback?.receipt;
    },
    async verifyCurrentFeedback(value) {
      if (!currentFeedback) return { ok: false, code: "MEMORY_FEEDBACK_AMBIGUOUS" };
      let receipt: SparkMemoryFeedbackReceipt;
      try {
        receipt = parseSparkMemoryFeedbackReceipt(value);
      } catch {
        return { ok: false, code: "MEMORY_FEEDBACK_INVALID" };
      }
      if (
        receipt.sessionId !== currentFeedback.receipt.sessionId ||
        receipt.turnId !== currentFeedback.receipt.turnId
      ) {
        return { ok: false, code: "MEMORY_FEEDBACK_CROSS_TURN" };
      }
      if (receipt.messageId !== currentFeedback.receipt.messageId) {
        return { ok: false, code: "MEMORY_FEEDBACK_STALE_MESSAGE" };
      }
      if (
        receipt.memoryRef !== currentFeedback.receipt.memoryRef ||
        receipt.outcome !== currentFeedback.receipt.outcome ||
        receipt.feedbackDigest !== currentFeedback.receipt.feedbackDigest
      ) {
        return { ok: false, code: "MEMORY_FEEDBACK_PROPOSAL_DRIFT" };
      }
      if (currentFeedback.state !== "pending") {
        return { ok: false, code: "MEMORY_FEEDBACK_REPLAYED" };
      }
      currentFeedback.state = "reserved";
      const expectedTurnHash = await sparkMemoryDirectIntentSha256({
        workspaceId: receipt.workspaceId,
        sessionId: receipt.sessionId,
        turnId: receipt.turnId,
        messageId: receipt.messageId,
        prompt: currentFeedback.prompt,
      });
      if (receipt.turnHash !== expectedTurnHash) {
        return { ok: false, code: "MEMORY_FEEDBACK_STALE_MESSAGE" };
      }
      const verified = await verifySparkMemoryFeedbackReceipt(receipt, {
        trustedKeyId: keyId,
        verifySignature: (payload, signature) =>
          verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url")),
      });
      if (!verified.ok) currentFeedback.state = "pending";
      return verified;
    },
    commitCurrentFeedback(value) {
      if (!currentFeedback || currentFeedback.state !== "reserved") return false;
      const parsed = sparkMemoryFeedbackReceiptSchema.safeParse(value);
      if (!parsed.success) return false;
      if (
        canonicalFeedbackReceipt(parsed.data) !== canonicalFeedbackReceipt(currentFeedback.receipt)
      ) {
        return false;
      }
      currentFeedback.state = "committed";
      return true;
    },
    releaseCurrentFeedback(value) {
      if (!currentFeedback || currentFeedback.state !== "reserved") return false;
      const parsed = sparkMemoryFeedbackReceiptSchema.safeParse(value);
      if (!parsed.success) return false;
      if (
        canonicalFeedbackReceipt(parsed.data) !== canonicalFeedbackReceipt(currentFeedback.receipt)
      ) {
        return false;
      }
      currentFeedback.state = "pending";
      return true;
    },
    clear() {
      current = undefined;
      currentFeedback = undefined;
    },
  };
}

function canonicalFeedbackReceipt(value: unknown): string {
  return JSON.stringify(parseSparkMemoryFeedbackReceipt(value));
}

function canonicalReceipt(value: unknown): string {
  return JSON.stringify(parseSparkMemoryDirectIntentReceipt(value));
}
