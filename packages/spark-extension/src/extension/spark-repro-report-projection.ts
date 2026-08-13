import { resolve } from "node:path";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { writeTextFileAtomic } from "@zendev-lab/spark-core";
import {
  buildSparkReproWorkSummary,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";
import type { SparkSessionRepro } from "@zendev-lab/spark-repro";
import {
  migrateSparkReproWorkSummaryV2,
  projectSparkReproWorkSummaryV3,
  type SparkReproWorkSummaryV3,
} from "@zendev-lab/spark-repro/three-lane-work-summary";

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
  verifyCurrentReproReportAuthority,
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
  work: SparkReproWorkSummaryV3;
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
  taskStatusByRef?: Readonly<Record<string, string | undefined>>;
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

  const formalWork = buildSparkReproWorkSummary({
    ...(input.workSummaryInput as unknown as SparkReproWorkSummaryInput),
    reportArtifactRef,
  });
  if (formalWork.reproId !== currentReproId) {
    throw new Error(
      `work summary reproId ${formalWork.reproId} does not match current Repro run ${currentReproId}`,
    );
  }

  const evidenceLookup = input.evidenceLookup ?? defaultEvidenceStore(input.cwd);
  await resolveAcceptedFormalEvidence(formalWork, evidenceLookup);
  await verifyCurrentReproReportAuthority({
    cwd: input.cwd,
    work: formalWork,
    repro: input.reproState,
    taskStatusByRef: input.taskStatusByRef,
    evidenceLookup,
    control: input.formalEvidenceControl,
    signal: input.signal,
  });
  const work = input.reproState
    ? projectSparkReproWorkSummaryV3({ work: formalWork, state: input.reproState.threeLane })
    : migrateSparkReproWorkSummaryV2(formalWork);

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
