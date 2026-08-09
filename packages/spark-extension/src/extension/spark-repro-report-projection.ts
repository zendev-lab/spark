import { resolve } from "node:path";

import { defaultEvidenceStore, type EvidenceRecord } from "@zendev-lab/spark-artifacts";
import { writeTextFileAtomic, type EvidenceRef } from "@zendev-lab/spark-core";
import {
  buildSparkReproWorkSummary,
  sparkReproProfileDigest,
  sparkReproTopologyDigest,
  type SparkReproWorkSummary,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";
import type { SparkSessionRepro } from "@zendev-lab/spark-repro";

import {
  composeSparkReproReportSummary,
  serializeSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
  type SparkReproReportSummary,
} from "../repro-report-summary.ts";
import type { SparkDaemonReproFormalEvidenceControl } from "./spark-daemon-repro-formal-evidence-client.ts";
import type { SparkDaemonUsageControl } from "./spark-daemon-usage-client.ts";
import {
  resolveAcceptedFormalEvidence,
  type SparkReproEvidenceLookup,
} from "./spark-repro-report-evidence.ts";
import {
  renderSparkReproReportMarkdown,
  sparkReproReportArtifactRef,
  SPARK_REPRO_REPORT_SOURCE_PATH,
} from "./spark-repro-report.ts";

export { SPARK_REPRO_REPORT_SUMMARY_PATH } from "../repro-report-summary.ts";

export interface SparkReproReportProjectionResult {
  path: typeof SPARK_REPRO_REPORT_SUMMARY_PATH;
  reportPath: typeof SPARK_REPRO_REPORT_SOURCE_PATH;
  summary: SparkReproReportSummary;
  work: SparkReproWorkSummary;
  usageIncluded: boolean;
  warning?: string;
}

/**
 * Project canonical Repro and daemon-owned usage facts for the Bench renderer.
 *
 * This boundary deliberately accepts facts rather than reading a transcript or
 * legacy Repro state. The caller supplies the current durable repro id, which
 * prevents an otherwise-valid summary from being attributed to another run.
 */
export async function projectSparkReproReportSummary(input: {
  cwd: string;
  currentReproId: string;
  workSummaryInput: unknown;
  usageControl: SparkDaemonUsageControl;
  reproState?: SparkSessionRepro;
  formalEvidenceControl?: SparkDaemonReproFormalEvidenceControl;
  evidenceLookup?: SparkReproEvidenceLookup;
  signal?: AbortSignal;
}): Promise<SparkReproReportProjectionResult> {
  const currentReproId = input.currentReproId.trim();
  if (!currentReproId) throw new Error("current Repro id is required");
  if (!isRecord(input.workSummaryInput)) {
    throw new Error("project_report requires a workSummary object");
  }

  const suppliedReportArtifactRef = input.workSummaryInput.reportArtifactRef;
  const reportArtifactRef = sparkReproReportArtifactRef(currentReproId);
  if (suppliedReportArtifactRef !== undefined && suppliedReportArtifactRef !== reportArtifactRef) {
    throw new Error(
      `workSummary.reportArtifactRef must be the stable report binding ${reportArtifactRef}`,
    );
  }

  const work = buildSparkReproWorkSummary({
    ...(input.workSummaryInput as unknown as SparkReproWorkSummaryInput),
    reportArtifactRef,
  });
  if (work.reproId !== currentReproId) {
    throw new Error(
      `work summary reproId ${work.reproId} does not match current Repro run ${currentReproId}`,
    );
  }

  const evidenceLookup = input.evidenceLookup ?? defaultEvidenceStore(input.cwd);
  await resolveAcceptedFormalEvidence(work, evidenceLookup);
  await recordAcceptedFormalEvidenceReceipts({
    cwd: input.cwd,
    work,
    repro: input.reproState,
    evidenceLookup,
    control: input.formalEvidenceControl,
    signal: input.signal,
  });

  let tokenUsage: Awaited<ReturnType<SparkDaemonUsageControl["summary"]>> | undefined;
  let warning: string | undefined;
  try {
    tokenUsage = await input.usageControl.summary(
      { scope: { kind: "repro", reproId: currentReproId } },
      input.signal ? { signal: input.signal } : undefined,
    );
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) throw error;
    warning = `Token usage is unavailable; projected technical facts without it: ${errorMessage(error)}`;
  }

  let summary: SparkReproReportSummary;
  try {
    summary = composeSparkReproReportSummary({
      work,
      ...(tokenUsage ? { tokenUsage } : {}),
    });
  } catch (error) {
    if (!tokenUsage) throw error;
    warning = `Token usage is unavailable; projected technical facts without it: ${errorMessage(error)}`;
    tokenUsage = undefined;
    summary = composeSparkReproReportSummary({ work });
  }
  await writeTextFileAtomic(
    resolve(input.cwd, SPARK_REPRO_REPORT_SUMMARY_PATH),
    serializeSparkReproReportSummary(summary),
  );
  await writeTextFileAtomic(
    resolve(input.cwd, SPARK_REPRO_REPORT_SOURCE_PATH),
    renderSparkReproReportMarkdown(summary),
  );

  return {
    path: SPARK_REPRO_REPORT_SUMMARY_PATH,
    reportPath: SPARK_REPRO_REPORT_SOURCE_PATH,
    summary,
    work,
    usageIncluded: tokenUsage !== undefined,
    ...(warning ? { warning } : {}),
  };
}

async function recordAcceptedFormalEvidenceReceipts(input: {
  cwd: string;
  work: SparkReproWorkSummary;
  repro?: SparkSessionRepro;
  evidenceLookup: SparkReproEvidenceLookup;
  control?: SparkDaemonReproFormalEvidenceControl;
  signal?: AbortSignal;
}): Promise<void> {
  const rows = input.work.validationMatrix.rows.filter(
    (row) =>
      row.evidenceClass === "entrypoint" &&
      row.invocationClass === "owning_entrypoint" &&
      row.verdict === "accepted" &&
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
    const stepId = row.ownerStepId;
    const step = input.repro.plan.steps.find((candidate) => candidate.id === stepId);
    const verification = step?.verification;
    const expectedDefinitionDigest = stepId
      ? input.work.normativeCursor.stepDefinitionDigests?.[stepId]
      : undefined;
    if (
      !stepId ||
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
