import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  defaultArtifactStore,
  defaultEvidenceStore,
  syncDocumentArtifactFile,
  type Artifact,
  type ArtifactRef,
  type DocumentArtifactBody,
} from "@zendev-lab/spark-artifacts";
import type { SparkReproWorkSummary } from "@zendev-lab/spark-repro/work-summary";

import {
  parseSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
} from "../repro-report-summary.ts";
import { readJsonFileOptional } from "./json-store.ts";
import { resolveAcceptedFormalEvidence } from "./spark-repro-report-evidence.ts";

export const SPARK_REPRO_REPORT_SOURCE_PATH = "outputs/report.md";

export interface SparkReproReportSyncResult {
  artifact: Artifact<DocumentArtifactBody>;
  reportArtifactRef: ArtifactRef;
  work: SparkReproWorkSummary;
  changed: boolean;
  created: boolean;
}

/** A deterministic workspace-local binding: one report Document per Repro run. */
export function sparkReproReportArtifactRef(reproId: string): ArtifactRef {
  const normalized = reproId.trim();
  if (!normalized) throw new Error("reproId is required");
  const suffix = createHash("sha256")
    .update(`spark.repro.report/v1\0${normalized}`)
    .digest("hex")
    .slice(0, 32);
  return `artifact:repro-report-${suffix}` as ArtifactRef;
}

export async function syncSparkReproReportArtifact(
  cwd: string,
  currentReproIdValue: string,
): Promise<SparkReproReportSyncResult> {
  const currentReproId = currentReproIdValue.trim();
  if (!currentReproId) throw new Error("current Repro id is required");
  const reportArtifactRef = sparkReproReportArtifactRef(currentReproId);
  const work = await readCanonicalReportWork(cwd, currentReproId, reportArtifactRef);
  const result = await syncDocumentArtifactFile({
    cwd,
    sourcePath: SPARK_REPRO_REPORT_SOURCE_PATH,
    artifactRef: reportArtifactRef,
    title: `Repro report · ${work.title}`,
    mediaType: "text/markdown",
    progress: {
      stage: work.stage,
      label: `${work.stage} · ${work.status}`,
      percent: work.progress.percent,
    },
    store: defaultArtifactStore(cwd),
  });
  return { ...result, reportArtifactRef, work };
}

async function readCanonicalReportWork(
  cwd: string,
  currentReproId: string,
  reportArtifactRef: ArtifactRef,
): Promise<SparkReproWorkSummary> {
  const path = resolve(cwd, SPARK_REPRO_REPORT_SUMMARY_PATH);
  const raw = await readJsonFileOptional<Record<string, unknown>>(path);
  if (!raw) {
    throw new Error(
      `sync_report requires ${SPARK_REPRO_REPORT_SUMMARY_PATH}; run project_report first`,
    );
  }
  let summary: ReturnType<typeof parseSparkReproReportSummary>;
  try {
    summary = parseSparkReproReportSummary(raw);
  } catch (error) {
    throw new Error(
      `invalid ${SPARK_REPRO_REPORT_SUMMARY_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (summary.work.reproId !== currentReproId) {
    throw new Error(
      `${SPARK_REPRO_REPORT_SUMMARY_PATH} belongs to Repro ${summary.work.reproId}, not ${currentReproId}`,
    );
  }
  if (summary.work.reportArtifactRef !== reportArtifactRef) {
    throw new Error(
      `${SPARK_REPRO_REPORT_SUMMARY_PATH} must bind stable report Artifact ${reportArtifactRef}`,
    );
  }
  await resolveAcceptedFormalEvidence(summary.work, defaultEvidenceStore(cwd));
  return summary.work;
}
