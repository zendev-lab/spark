import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ARTIFACT_TRUSTED_SYNC_FILE_MAX_BYTES,
  defaultArtifactStore,
  defaultEvidenceStore,
  syncDocumentArtifactFile,
  type Artifact,
  type ArtifactRef,
  type DocumentArtifactBody,
} from "@zendev-lab/spark-artifacts";
import type { SparkSessionRepro } from "@zendev-lab/spark-repro";
import type { SparkReproWorkSummary } from "@zendev-lab/spark-repro/work-summary";

import {
  parseSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
  type SparkReproReportSummary,
} from "../repro-report-summary.ts";
import { readJsonFileOptional } from "./json-store.ts";
import type { SparkDaemonReproFormalEvidenceControl } from "./spark-daemon-repro-formal-evidence-client.ts";
import {
  resolveAcceptedFormalEvidence,
  verifyCurrentReproReportAuthority,
} from "./spark-repro-report-evidence.ts";

export const SPARK_REPRO_REPORT_SOURCE_PATH = "outputs/report.md";

/** Deterministic Markdown projection of the typed report summary. */
export function renderSparkReproReportMarkdown(summary: SparkReproReportSummary): string {
  const work = summary.work;
  const completedTasks = work.tasks.filter((task) => task.status === "done").length;
  const acceptedGates = work.gates.filter((gate) => gate.status === "accepted").length;
  const lines = [
    "# Spark Reproduction Report",
    "",
    "This file is generated from `outputs/spark-summary.json`. Edit the typed summary inputs and regenerate it instead of editing this file.",
    "",
    "## Run",
    "",
    `- Title: ${inlineCode(work.title)}`,
    `- Repro: ${inlineCode(work.reproId)}`,
    `- Status: ${inlineCode(work.status)}`,
    `- Stage: ${inlineCode(work.stage)}`,
    `- Progress: ${work.progress.quantified ? `${work.progress.percent}%` : "unquantified"}`,
    `- Technical goal: ${work.technicalGoal.achieved ? "achieved" : "not achieved"}`,
    `- Gates: ${acceptedGates}/${work.gates.length} accepted`,
    `- Tasks: ${completedTasks}/${work.tasks.length} done`,
    `- Pending decisions: ${work.pendingDecisions.length}`,
    ...(summary.tokenUsage
      ? [
          `- Token usage: ${summary.tokenUsage.totalTokens} total (${inlineCode(summary.tokenUsage.quality)})`,
        ]
      : ["- Token usage: unavailable"]),
    "",
    "## Canonical facts",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}

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
  options: {
    reproState?: SparkSessionRepro;
    taskStatusByRef?: Readonly<Record<string, string | undefined>>;
    formalEvidenceControl?: SparkDaemonReproFormalEvidenceControl;
    signal?: AbortSignal;
  } = {},
): Promise<SparkReproReportSyncResult> {
  const currentReproId = currentReproIdValue.trim();
  if (!currentReproId) throw new Error("current Repro id is required");
  const reportArtifactRef = sparkReproReportArtifactRef(currentReproId);
  const work = await readCanonicalReportWork(cwd, currentReproId, reportArtifactRef, options);
  const result = await syncDocumentArtifactFile({
    cwd,
    sourcePath: SPARK_REPRO_REPORT_SOURCE_PATH,
    artifactRef: reportArtifactRef,
    title: `Repro report · ${work.title}`,
    mediaType: "text/markdown",
    progress: {
      stage: work.stage,
      label: `${work.stage} · ${work.status}`,
      ...(work.progress.quantified ? { percent: work.progress.percent } : {}),
    },
    maxBytes: ARTIFACT_TRUSTED_SYNC_FILE_MAX_BYTES,
    store: defaultArtifactStore(cwd),
  });
  return { ...result, reportArtifactRef, work };
}

async function readCanonicalReportWork(
  cwd: string,
  currentReproId: string,
  reportArtifactRef: ArtifactRef,
  options: {
    reproState?: SparkSessionRepro;
    taskStatusByRef?: Readonly<Record<string, string | undefined>>;
    formalEvidenceControl?: SparkDaemonReproFormalEvidenceControl;
    signal?: AbortSignal;
  },
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
  const evidenceLookup = defaultEvidenceStore(cwd);
  await resolveAcceptedFormalEvidence(summary.work, evidenceLookup);
  await verifyCurrentReproReportAuthority({
    cwd,
    work: summary.work,
    repro: options.reproState,
    taskStatusByRef: options.taskStatusByRef,
    evidenceLookup,
    control: options.formalEvidenceControl,
    signal: options.signal,
  });
  const reportPath = resolve(cwd, SPARK_REPRO_REPORT_SOURCE_PATH);
  let report: string;
  try {
    report = await readFile(reportPath, "utf8");
  } catch (error) {
    throw new Error(
      `sync_report requires ${SPARK_REPRO_REPORT_SOURCE_PATH}; run project_report first`,
      { cause: error },
    );
  }
  if (report !== renderSparkReproReportMarkdown(summary)) {
    throw new Error(
      `${SPARK_REPRO_REPORT_SOURCE_PATH} does not match ${SPARK_REPRO_REPORT_SUMMARY_PATH}; run project_report again`,
    );
  }
  return summary.work;
}

function inlineCode(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  const longestBacktickRun = Math.max(
    0,
    ...[...normalized.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence} ${normalized} ${fence}`;
}
