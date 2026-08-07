import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AskRef, EvidenceRef } from "@zendev-lab/spark-core";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  buildSparkReproWorkSummary,
  type SparkReproDecisionRequest,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproWorkStage,
} from "@zendev-lab/spark-repro/work-summary";

import {
  composeSparkReproReportSummary,
  serializeSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
} from "../repro-report-summary.ts";
import { createSparkSessionRepro } from "./spark-session-repro.ts";
import {
  renderSparkReproReportMarkdown,
  sparkReproReportArtifactRef,
  SPARK_REPRO_REPORT_SOURCE_PATH,
  syncSparkReproReportArtifact,
} from "./spark-repro-report.ts";

describe("stable Repro report Artifact", () => {
  it("keeps one ref and revision while content is unchanged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-repro-report-"));
    await mkdir(join(cwd, "outputs"), { recursive: true });
    const repro = createSparkSessionRepro("session:report");
    await writeReportSummary(cwd, repro.reproId, "contract");

    const first = await syncSparkReproReportArtifact(cwd, repro.reproId);
    const second = await syncSparkReproReportArtifact(cwd, repro.reproId);

    expect(first.reportArtifactRef).toBe(sparkReproReportArtifactRef(repro.reproId));
    expect(first.created).toBe(true);
    expect(first.artifact.body.revision).toBe(1);
    expect(first.artifact.body.progress).toEqual({
      stage: "contract",
      label: "contract · active",
    });
    expect(second.changed).toBe(false);
    expect(second.reportArtifactRef).toBe(first.reportArtifactRef);
    expect(second.artifact.body.revision).toBe(1);

    await writeReportSummary(cwd, repro.reproId, "reference", true);
    const stageChanged = await syncSparkReproReportArtifact(cwd, repro.reproId);
    expect(stageChanged.changed).toBe(true);
    expect(stageChanged.reportArtifactRef).toBe(first.reportArtifactRef);
    expect(stageChanged.artifact.body).toMatchObject({
      revision: 2,
      progress: { stage: "reference", label: "reference · active" },
    });
    expect(Date.parse(stageChanged.artifact.updatedAt)).toBeGreaterThan(
      Date.parse(first.artifact.updatedAt),
    );
  });

  it("rejects report content that does not match the typed projection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-repro-report-change-"));
    const repro = createSparkSessionRepro("session:report-change");
    await writeReportSummary(cwd, repro.reproId, "alignment", true);
    await syncSparkReproReportArtifact(cwd, repro.reproId);

    await writeFile(join(cwd, SPARK_REPRO_REPORT_SOURCE_PATH), "# Forged report\n", "utf8");

    await expect(syncSparkReproReportArtifact(cwd, repro.reproId)).rejects.toThrow(
      "outputs/report.md does not match outputs/spark-summary.json",
    );
  });

  it("uses canonical waiting-decision status and progress for Artifact metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-repro-report-waiting-"));
    const repro = createSparkSessionRepro("session:report-waiting");
    await writeReportSummary(cwd, repro.reproId, "alignment", true, [pendingDecision()]);

    const synced = await syncSparkReproReportArtifact(cwd, repro.reproId);

    expect(repro.status).toBe("active");
    expect(synced.work.status).toBe("waiting_decision");
    expect(synced.artifact.title).toBe("Repro report · Canonical report title");
    expect(synced.artifact.body.progress).toEqual({
      stage: "alignment",
      label: "alignment · waiting_decision",
    });
  });

  it("requires a canonical projection for the current Repro run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-repro-report-summary-required-"));
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "report.md"), "# Report\n", "utf8");

    await expect(syncSparkReproReportArtifact(cwd, "current-run")).rejects.toThrow(
      "run project_report first",
    );
    await writeReportSummary(cwd, "another-run", "alignment", true);
    await expect(syncSparkReproReportArtifact(cwd, "current-run")).rejects.toThrow(
      "belongs to Repro another-run, not current-run",
    );
  });

  it("rejects agent-written accepted gates without durable evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-repro-report-forged-progress-"));
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "report.md"), "# Forged report\n", "utf8");
    await writeReportSummary(cwd, "current-run", "alignment", true, [], false);

    await expect(syncSparkReproReportArtifact(cwd, "current-run")).rejects.toThrow(
      "report work evidence not found: evidence:contract",
    );
  });

  it("derives different stable refs for different Repro runs", () => {
    const first = createSparkSessionRepro("session:first");
    const second = createSparkSessionRepro("session:second");
    expect(sparkReproReportArtifactRef(first.reproId)).not.toBe(
      sparkReproReportArtifactRef(second.reproId),
    );
    expect(sparkReproReportArtifactRef(first.reproId)).toBe(
      sparkReproReportArtifactRef(first.reproId),
    );
  });
});

async function writeReportSummary(
  cwd: string,
  reproId: string,
  stage: SparkReproWorkStage,
  contractAccepted = false,
  pendingDecisions: SparkReproDecisionRequest[] = [],
  persistAcceptedEvidence = true,
): Promise<void> {
  const work = buildSparkReproWorkSummary({
    reproId,
    title: "Canonical report title",
    stage,
    target: {
      model: "minimum_complete",
      requiredSteps: 10,
      referenceStrategies: [],
      validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    },
    profile: profile(),
    gates: [
      gate("contract", "contract", contractAccepted ? "accepted" : "open"),
      gate("reference", "reference", "open", profile()),
      gate("target", "target", "open", profile()),
      gate("alignment", "alignment", "open", profile()),
      gate("delivery", "delivery", "open"),
    ],
    pendingDecisions,
    reportArtifactRef: sparkReproReportArtifactRef(reproId),
  });
  if (contractAccepted && persistAcceptedEvidence) {
    await defaultEvidenceStore(cwd).put({
      ref: "evidence:contract" as EvidenceRef,
      kind: "record",
      title: "contract",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
  }
  const summary = composeSparkReproReportSummary({ work });
  await mkdir(join(cwd, "outputs"), { recursive: true });
  await writeFile(
    join(cwd, SPARK_REPRO_REPORT_SUMMARY_PATH),
    serializeSparkReproReportSummary(summary),
    "utf8",
  );
  await writeFile(
    join(cwd, SPARK_REPRO_REPORT_SOURCE_PATH),
    renderSparkReproReportMarkdown(summary),
    "utf8",
  );
}

function gate(
  id: string,
  stage: SparkReproWorkStage,
  status: SparkReproEvidenceGate["status"],
  gateProfile?: SparkReproProfile,
): SparkReproEvidenceGate {
  return {
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status,
    weight: 1,
    evidenceRefs: status === "accepted" ? ([`evidence:${id}`] as EvidenceRef[]) : [],
    ...(gateProfile ? { profile: gateProfile } : {}),
  };
}

function profile(): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed: 1, target: 10 },
    topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
  };
}

function pendingDecision(): SparkReproDecisionRequest {
  return {
    id: "resource-change",
    status: "pending",
    kind: "resource_change",
    question: "Increase the resource allocation?",
    options: [
      { value: "increase", label: "Increase", recommended: true },
      { value: "stop", label: "Stop" },
    ],
    blockedTransition: { from: "alignment", to: "alignment" },
    evidenceRefs: [],
    askRef: "ask:resource-change" as AskRef,
  };
}
