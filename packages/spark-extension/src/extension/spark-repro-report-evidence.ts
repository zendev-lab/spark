import {
  sparkReproCompletionEvidenceRefs,
  type SparkReproWorkSummary,
} from "@zendev-lab/spark-repro/work-summary";
import type { EvidenceRef } from "@zendev-lab/spark-core";

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
