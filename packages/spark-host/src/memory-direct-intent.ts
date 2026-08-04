import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

import {
  parseSparkMemoryDirectIntentReceipt,
  prepareSparkMemoryDirectIntentReceipt,
  sparkMemoryDirectIntentReceiptSchema,
  sparkMemoryDirectIntentReceiptSigningPayload,
  sparkMemoryDirectIntentSha256,
  verifySparkMemoryDirectIntentReceipt,
  type PrepareSparkMemoryDirectIntentReceiptInput,
  type SparkMemoryDirectIntentReceipt,
} from "@zendev-lab/spark-protocol";

export interface SparkMemoryDirectIntentTurnAuthority {
  readonly keyId: string;
  issue(
    input: PrepareSparkMemoryDirectIntentReceiptInput,
  ): Promise<SparkMemoryDirectIntentReceipt | undefined>;
  currentReceipt(): SparkMemoryDirectIntentReceipt | undefined;
  verifyCurrent(value: unknown): Promise<boolean>;
  clear(): void;
}

/**
 * Host-private one-turn authority. The private key and exact prompt binding stay
 * inside this closure; only the signed public receipt reaches capability code.
 */
export function createSparkMemoryDirectIntentTurnAuthority(): SparkMemoryDirectIntentTurnAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(publicKeyDer).digest("hex");
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
    clear() {
      current = undefined;
    },
  };
}

function canonicalReceipt(value: unknown): string {
  return JSON.stringify(parseSparkMemoryDirectIntentReceipt(value));
}
