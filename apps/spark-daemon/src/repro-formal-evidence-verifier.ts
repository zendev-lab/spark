import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  sparkReproFormalEvidenceAttestationPayload,
  sparkReproFormalEvidenceAttestationSchema,
  type SparkReproFormalEvidenceCandidate,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";

interface SparkReproFormalEvidenceVerifierResult {
  verifierId: string;
  verifierVersion: string;
  verifiedAt: string;
  verdict: "accepted";
}

export interface SparkReproFormalEvidenceVerifier {
  verify(
    candidate: SparkReproFormalEvidenceCandidate,
    evidenceBody: unknown,
  ): Promise<SparkReproFormalEvidenceVerifierResult>;
}

/**
 * Production formal Evidence verifier backed by daemon-configured Ed25519 keys.
 * The private key stays with the independent validation system; Spark stores
 * only public SPKI DER bytes and therefore cannot mint an accepted attestation.
 */
export function createEd25519ReproFormalEvidenceVerifier(
  publicKeys: Readonly<Record<string, string>>,
): SparkReproFormalEvidenceVerifier {
  const keys = new Map(
    Object.entries(publicKeys).map(([id, encoded]) => {
      const verifierId = id.trim();
      if (!verifierId) throw new Error("formal Evidence verifier id must not be empty");
      if (!isCanonicalBase64(encoded)) {
        throw new Error(
          `formal Evidence verifier ${verifierId} public key must be canonical base64`,
        );
      }
      const key = createPublicKey({
        key: Buffer.from(encoded, "base64"),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ed25519") {
        throw new Error(`formal Evidence verifier ${verifierId} must use an Ed25519 public key`);
      }
      return [verifierId, key] as const;
    }),
  );

  return {
    async verify(candidate, evidenceBody) {
      const attestation = sparkReproFormalEvidenceAttestationSchema.parse(evidenceBody);
      const key = keys.get(attestation.verifierId);
      if (!key) {
        throw new Error(`formal Evidence verifier is not registered: ${attestation.verifierId}`);
      }
      if (!sameBinding(attestation.binding, candidate)) {
        throw new Error("formal Evidence attestation binding does not match the current candidate");
      }
      if (!isCanonicalBase64(attestation.signature)) {
        throw new Error("formal Evidence attestation signature must be canonical base64");
      }
      const { signature, ...unsigned } = attestation;
      const accepted = verifySignature(
        null,
        Buffer.from(sparkReproFormalEvidenceAttestationPayload(unsigned)),
        key,
        Buffer.from(signature, "base64"),
      );
      if (!accepted) throw new Error("formal Evidence attestation signature is invalid");
      return {
        verifierId: attestation.verifierId,
        verifierVersion: attestation.verifierVersion,
        verifiedAt: attestation.verifiedAt,
        verdict: "accepted",
      };
    },
  };
}

export function parseReproFormalEvidencePublicKeys(
  encoded: string | undefined,
): Readonly<Record<string, string>> {
  if (!encoded?.trim()) return {};
  const parsed: unknown = JSON.parse(encoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("reproFormalEvidencePublicKeysJson must encode an object");
  }
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`formal Evidence verifier ${id} public key must be a non-empty string`);
    }
    result[id] = value.trim();
  }
  return result;
}

function sameBinding(
  actual: Record<string, unknown>,
  candidate: SparkReproFormalEvidenceCandidate,
): boolean {
  return (
    actual.workspaceCwd === candidate.workspaceCwd &&
    actual.reproId === candidate.reproId &&
    actual.requirementId === candidate.requirementId &&
    actual.stepId === candidate.stepId &&
    actual.planRevision === candidate.planRevision &&
    actual.stepDefinitionDigest === candidate.stepDefinitionDigest &&
    actual.invocationClass === candidate.invocationClass &&
    actual.evidenceClass === candidate.evidenceClass &&
    actual.profileDigest === candidate.profileDigest &&
    actual.topologyDigest === candidate.topologyDigest
  );
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}
