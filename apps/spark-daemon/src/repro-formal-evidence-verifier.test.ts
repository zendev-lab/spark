import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  sparkReproFormalEvidenceAttestationPayload,
  type SparkReproFormalEvidenceAttestation,
  type SparkReproFormalEvidenceCandidate,
} from "@zendev-lab/spark-protocol/repro-formal-evidence";
import { createEd25519ReproFormalEvidenceVerifier } from "./repro-formal-evidence-verifier.ts";

const candidate: SparkReproFormalEvidenceCandidate = {
  workspaceCwd: "/workspace",
  evidenceRef: "evidence:formal-proof",
  evidenceHash: "a".repeat(64),
  reproId: "repro-1",
  requirementId: "alignment",
  stepId: "S1",
  planRevision: 3,
  stepDefinitionDigest: "digest:S1",
  invocationClass: "owning_entrypoint",
  evidenceClass: "entrypoint",
  profileDigest: "b".repeat(64),
  topologyDigest: "c".repeat(64),
};

describe("registered Ed25519 formal Evidence verifier", () => {
  it("accepts only an independently signed exact candidate binding", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned = {
      schema: "spark.repro.formal-evidence-attestation/v1" as const,
      verifierId: "external-validator",
      verifierVersion: "2026.08",
      verifiedAt: "2026-08-09T00:00:00.000Z",
      binding: {
        workspaceCwd: candidate.workspaceCwd,
        reproId: candidate.reproId,
        requirementId: candidate.requirementId,
        stepId: candidate.stepId,
        planRevision: candidate.planRevision,
        stepDefinitionDigest: candidate.stepDefinitionDigest,
        invocationClass: candidate.invocationClass,
        evidenceClass: candidate.evidenceClass,
        profileDigest: candidate.profileDigest,
        topologyDigest: candidate.topologyDigest,
      },
      verdict: "accepted" as const,
      resultDigest: "d".repeat(64),
    };
    const attestation: SparkReproFormalEvidenceAttestation = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(sparkReproFormalEvidenceAttestationPayload(unsigned)),
        privateKey,
      ).toString("base64"),
    };
    const verifier = createEd25519ReproFormalEvidenceVerifier({
      "external-validator": publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    });

    await expect(verifier.verify(candidate, attestation)).resolves.toEqual({
      verifierId: "external-validator",
      verifierVersion: "2026.08",
      verifiedAt: "2026-08-09T00:00:00.000Z",
      verdict: "accepted",
    });
    await expect(verifier.verify({ ...candidate, planRevision: 4 }, attestation)).rejects.toThrow(
      "binding does not match",
    );
    await expect(
      verifier.verify(candidate, {
        ...attestation,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    ).rejects.toThrow("signature is invalid");
  });
});
