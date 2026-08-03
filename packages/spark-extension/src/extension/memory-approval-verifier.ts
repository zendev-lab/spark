import { join, resolve } from "node:path";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { verifyCanonicalAskEvidence } from "@zendev-lab/spark-ask";
import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  createFileMemoryApprovalProofCommitter,
  createFileMemoryApprovalProofReserver,
  createMemoryApprovalVerifier,
  type MemoryApprovalVerifier,
} from "@zendev-lab/spark-memory";
import type { SparkMemoryApprovalProof } from "@zendev-lab/spark-protocol";

const verifierByWorkspace = new Map<string, MemoryApprovalVerifier>();

export function createAskBackedMemoryApprovalVerifier(cwd: string): MemoryApprovalVerifier {
  const workspaceRoot = resolve(cwd);
  const existing = verifierByWorkspace.get(workspaceRoot);
  if (existing) return existing;
  const verifier = createMemoryApprovalVerifier({
    authenticateProof: async (proof) => await proofMatchesCanonicalAsk(workspaceRoot, proof),
    reserveProof: createFileMemoryApprovalProofReserver(
      join(workspaceRoot, ".spark", "memory", "approval-consumptions.json"),
    ),
    commitProof: createFileMemoryApprovalProofCommitter(
      join(workspaceRoot, ".spark", "memory", "approval-consumptions.json"),
    ),
  });
  verifierByWorkspace.set(workspaceRoot, verifier);
  return verifier;
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
