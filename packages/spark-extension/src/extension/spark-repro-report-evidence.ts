import type { EvidenceRecord } from "@zendev-lab/spark-artifacts";
import type { EvidenceRef } from "@zendev-lab/spark-core";
import type { SparkSessionRepro } from "@zendev-lab/spark-repro";
import {
  sparkReproCompletionEvidenceRefs,
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  validateSparkReproCurrentRetirementAuthority,
  type SparkReproWorkSummary,
} from "@zendev-lab/spark-repro/work-summary";

import type { SparkDaemonReproFormalEvidenceControl } from "./spark-daemon-repro-formal-evidence-client.ts";

export interface SparkReproEvidenceLookup {
  tryGet(ref: EvidenceRef): Promise<unknown>;
}

/** Resolve every accepted gate/Matrix/retirement/discharge ref before trusted projection. */
export async function resolveAcceptedFormalEvidence(
  work: SparkReproWorkSummary,
  evidenceLookup: SparkReproEvidenceLookup,
): Promise<void> {
  const refs = [
    ...new Set([
      ...sparkReproCompletionEvidenceRefs(work),
      ...work.gates
        .filter((gate) => gate.status === "accepted")
        .flatMap((gate) => gate.evidenceRefs),
      ...work.validationMatrix.rows
        .filter((row) => row.verdict === "accepted")
        .flatMap((row) => row.evidenceRefs),
    ]),
  ];
  const resolved = await Promise.all(refs.map((ref) => evidenceLookup.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    if (!resolved[index]) {
      throw new Error(`report work evidence not found: ${refs[index]}`);
    }
  }
}

/** Revalidate current retirement StepVerifiers and daemon formal receipts. */
export async function verifyCurrentReproReportAuthority(input: {
  cwd: string;
  work: SparkReproWorkSummary;
  repro?: SparkSessionRepro;
  evidenceLookup: SparkReproEvidenceLookup;
  control?: SparkDaemonReproFormalEvidenceControl;
  signal?: AbortSignal;
}): Promise<void> {
  const currentBound =
    input.work.normativeCursor.orderedStepIds.length > 0 ||
    input.work.validationMatrix.rows.some((row) => row.ownerStepId !== undefined);
  if (
    currentBound &&
    (!input.repro ||
      input.repro.reproId !== input.work.reproId ||
      input.repro.plan.currentRevision !== input.work.normativeCursor.planRevision)
  ) {
    throw new Error("report work is stale against the current durable Repro plan revision");
  }
  validateSparkReproCurrentRetirementAuthority(input.work, input.repro);
  const rows = input.work.validationMatrix.rows.filter(
    (row) =>
      row.evidenceClass === "entrypoint" &&
      row.invocationClass === "owning_entrypoint" &&
      row.verdict === "accepted" &&
      row.ownerStepId !== undefined &&
      input.work.gates.find((gate) => gate.id === row.gateId)?.status === "accepted",
  );
  if (rows.length === 0) return;
  if (!input.control) {
    throw new Error(
      "accepted formal Evidence requires daemon registered-verifier receipt authority",
    );
  }
  if (!input.repro || input.repro.reproId !== input.work.reproId) {
    throw new Error(
      "accepted formal Evidence requires the current durable Repro StepVerifier state",
    );
  }
  const profile = input.work.acceptanceProfile;
  const topology = profile.validationTopology ?? profile.topology;
  for (const row of rows) {
    const stepId = row.ownerStepId!;
    const step = input.repro.plan.steps.find((candidate) => candidate.id === stepId);
    const verification = step?.verification;
    const expectedDefinitionDigest = input.work.normativeCursor.stepDefinitionDigests?.[stepId];
    if (
      !step ||
      step.status !== "done" ||
      !verification ||
      verification.verdict !== "Pass" ||
      verification.stepId !== stepId ||
      verification.planRevision !== input.work.normativeCursor.planRevision ||
      !expectedDefinitionDigest ||
      verification.definitionDigest !== expectedDefinitionDigest
    ) {
      throw new Error(`formal Evidence row ${row.id} lacks a current passing StepVerifier`);
    }
    for (const evidenceRef of row.evidenceRefs) {
      if (!verification.evidenceRefs.includes(evidenceRef)) {
        throw new Error(`formal Evidence ${evidenceRef} is outside StepVerifier ${stepId}`);
      }
      const evidence = await input.evidenceLookup.tryGet(evidenceRef);
      if (!isHashBoundEvidenceRecord(evidence, evidenceRef)) {
        throw new Error(`formal Evidence ${evidenceRef} lacks an immutable Evidence hash`);
      }
      if (
        evidence.curation?.status === "superseded" ||
        (evidence.curation?.supersededBy?.length ?? 0) > 0
      ) {
        throw new Error(`formal Evidence ${evidenceRef} is superseded`);
      }
      const candidate = {
        workspaceCwd: input.cwd,
        evidenceRef,
        evidenceHash: evidence.hash,
        reproId: input.work.reproId,
        requirementId: row.gateId,
        stepId,
        planRevision: verification.planRevision,
        stepDefinitionDigest: verification.definitionDigest,
        invocationClass: "owning_entrypoint" as const,
        evidenceClass: "entrypoint" as const,
        profileDigest: sparkReproProfileDigest(profile),
        topologyDigest: sparkReproTopologyDigest(topology),
      };
      const recorded = await input.control.verifyAndRecord(
        { workspaceCwd: input.cwd, candidate },
        input.signal ? { signal: input.signal } : undefined,
      );
      if (
        recorded.receipt.verdict !== "accepted" ||
        recorded.receipt.stale ||
        recorded.receipt.superseded ||
        !sameFormalCandidate(recorded.receipt, candidate)
      ) {
        throw new Error(`daemon registered verifier did not accept formal Evidence ${evidenceRef}`);
      }
    }
  }
}

function sameFormalCandidate(
  receipt: Record<string, unknown>,
  candidate: Record<string, unknown>,
): boolean {
  return Object.entries(candidate).every(([key, value]) => receipt[key] === value);
}

function isHashBoundEvidenceRecord(
  value: unknown,
  expectedRef: EvidenceRef,
): value is EvidenceRecord & { hash: string } {
  return (
    isRecord(value) &&
    value.ref === expectedRef &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{64}$/u.test(value.hash)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
