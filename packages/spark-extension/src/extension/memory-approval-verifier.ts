import { join, resolve } from "node:path";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { verifyCanonicalAskEvidence } from "@zendev-lab/spark-ask";
import type { EvidenceRef, SparkHostContext } from "@zendev-lab/spark-core";
import {
  createFileMemoryApprovalProofCommitter,
  createFileMemoryApprovalProofReserver,
  createMemoryApprovalVerifier,
  type MemoryApprovalVerifier,
} from "@zendev-lab/spark-memory";
import {
  sparkMemoryDirectIntentAnswerDigest,
  sparkMemoryDirectIntentReceiptSchema,
} from "@zendev-lab/spark-protocol/daemon";
import { type SparkMemoryApprovalProof } from "@zendev-lab/spark-protocol/daemon";

const verifierByWorkspace = new Map<string, MemoryApprovalVerifier>();

export function createAskBackedMemoryApprovalVerifier(
  cwd: string,
  ctx?: SparkHostContext,
): MemoryApprovalVerifier {
  const workspaceRoot = resolve(cwd);
  const directReceipt = sparkMemoryDirectIntentReceiptSchema.safeParse(ctx?.memoryDirectIntent);
  const existing = directReceipt.success ? undefined : verifierByWorkspace.get(workspaceRoot);
  if (existing) return existing;
  const verifier = createMemoryApprovalVerifier({
    authenticateProof: async (proof) =>
      directReceipt.success && proof.proofRef === directReceipt.data.receiptId
        ? await proofMatchesDirectIntent(ctx, directReceipt.data, proof)
        : await proofMatchesCanonicalAsk(workspaceRoot, proof),
    reserveProof: createFileMemoryApprovalProofReserver(
      join(workspaceRoot, ".spark", "memory", "approval-consumptions.json"),
    ),
    commitProof: createFileMemoryApprovalProofCommitter(
      join(workspaceRoot, ".spark", "memory", "approval-consumptions.json"),
    ),
  });
  if (!directReceipt.success) verifierByWorkspace.set(workspaceRoot, verifier);
  return verifier;
}

async function proofMatchesDirectIntent(
  ctx: SparkHostContext | undefined,
  receipt: ReturnType<typeof sparkMemoryDirectIntentReceiptSchema.parse>,
  proof: SparkMemoryApprovalProof,
): Promise<boolean> {
  if (!(await ctx?.verifyMemoryDirectIntent?.(receipt))) return false;
  if (ctx?.sessionId !== receipt.sessionId) return false;
  if (ctx?.sessionSurface === "channel" && receipt.surface !== "channel") return false;
  if (ctx?.sessionSurface === "local" && receipt.surface === "channel") return false;
  if (proof.proofRef !== receipt.receiptId) return false;
  if (proof.workspaceId !== receipt.workspaceId) return false;
  if (proof.recordRef !== receipt.recordRef) return false;
  if (proof.operation !== receipt.operation) return false;
  if (proof.scope !== receipt.scope) return false;
  if (proof.nonce !== receipt.nonce) return false;
  if (proof.issuedAt !== receipt.issuedAt || proof.expiresAt !== receipt.expiresAt) return false;
  if (receipt.expectedRevision !== null && proof.expectedRevision !== receipt.expectedRevision) {
    return false;
  }
  return proof.answerDigest === (await sparkMemoryDirectIntentAnswerDigest(receipt));
}

async function proofMatchesCanonicalAsk(
  cwd: string,
  proof: SparkMemoryApprovalProof,
): Promise<boolean> {
  if (!proof.proofRef.startsWith("evidence:")) return false;
  const evidence = await defaultEvidenceStore(cwd).tryGet(proof.proofRef as EvidenceRef);
  if (!evidence) return false;
  const verified = await verifyCanonicalAskEvidence(cwd, evidence);
  return verified?.approvalProof !== undefined && sameCanonicalValue(verified.approvalProof, proof);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "<invalid-number>";
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
  return `<invalid:${typeof value}>`;
}
