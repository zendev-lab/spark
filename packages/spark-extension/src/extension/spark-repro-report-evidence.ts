import type { SparkReproWorkSummary } from "@zendev-lab/spark-repro/work-summary";
import type { EvidenceRef } from "@zendev-lab/spark-core";

export interface SparkReproEvidenceLookup {
  tryGet(ref: EvidenceRef): Promise<unknown>;
}

/** Resolve every accepted formal gate ref before projecting trusted progress. */
export async function resolveAcceptedFormalEvidence(
  work: SparkReproWorkSummary,
  evidenceLookup: SparkReproEvidenceLookup,
): Promise<void> {
  const refs = [
    ...new Set(
      work.gates
        .filter((gate) => gate.evidenceClass === "formal" && gate.status === "accepted")
        .flatMap((gate) => gate.evidenceRefs),
    ),
  ];
  const resolved = await Promise.all(refs.map((ref) => evidenceLookup.tryGet(ref)));
  for (let index = 0; index < refs.length; index += 1) {
    if (!resolved[index]) {
      throw new Error(`report work evidence not found: ${refs[index]}`);
    }
  }
}
