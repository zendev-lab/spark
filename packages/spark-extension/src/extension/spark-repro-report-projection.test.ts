import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import type { EvidenceRef } from "@zendev-lab/spark-core";
import type { SparkTokenUsageAggregate } from "@zendev-lab/spark-protocol/token-usage";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproWorkStage,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";

import type { SparkDaemonUsageControl } from "./spark-daemon-usage-client.ts";
import {
  projectSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
} from "./spark-repro-report-projection.ts";
import {
  renderSparkReproReportMarkdown,
  sparkReproReportArtifactRef,
  SPARK_REPRO_REPORT_SOURCE_PATH,
} from "./spark-repro-report.ts";

const temporaryDirectories: string[] = [];
const evidence = (id: string) => `evidence:${id}` as EvidenceRef;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }),
      ),
  );
});

describe("canonical Repro report runtime projection", () => {
  it("derives work facts, joins daemon usage, and atomically writes the renderer input", async () => {
    const cwd = await temporaryDirectory();
    const usageControl = fixedUsageControl(usage("repro-42"));

    const projected = await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-42",
      workSummaryInput: workInput("repro-42"),
      usageControl,
      evidenceLookup: acceptAllEvidenceLookup,
    });

    expect(projected.warning).toBeUndefined();
    expect(projected.usageIncluded).toBe(true);
    expect(projected.work.status).toBe("active");
    expect(projected.work.progress).toMatchObject({ quantified: false, percent: null });
    expect(projected.work.reportArtifactRef).toBe(sparkReproReportArtifactRef("repro-42"));
    expect(usageControl.requests).toEqual([{ scope: { kind: "repro", reproId: "repro-42" } }]);

    const stored = JSON.parse(
      await readFile(join(cwd, SPARK_REPRO_REPORT_SUMMARY_PATH), "utf8"),
    ) as typeof projected.summary;
    expect(stored).toEqual(projected.summary);
    expect(stored.tokenUsage?.totalTokens).toBe(10);
    expect(await readFile(join(cwd, SPARK_REPRO_REPORT_SOURCE_PATH), "utf8")).toBe(
      renderSparkReproReportMarkdown(projected.summary),
    );
  });

  it("rejects facts for another Repro before querying usage or writing", async () => {
    const cwd = await temporaryDirectory();
    const usageControl = fixedUsageControl(usage("repro-current"));

    await expect(
      projectSparkReproReportSummary({
        cwd,
        currentReproId: "repro-current",
        workSummaryInput: workInput("repro-other"),
        usageControl,
        evidenceLookup: acceptAllEvidenceLookup,
      }),
    ).rejects.toThrow(
      "work summary reproId repro-other does not match current Repro run repro-current",
    );
    expect(usageControl.requests).toEqual([]);
    await expect(readFile(join(cwd, SPARK_REPRO_REPORT_SUMMARY_PATH), "utf8")).rejects.toThrow();
  });

  it("writes technical facts with a warning when usage projection is unavailable", async () => {
    const cwd = await temporaryDirectory();
    const usageControl: SparkDaemonUsageControl = {
      async summary() {
        throw new Error("daemon unavailable");
      },
    };

    const projected = await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-42",
      workSummaryInput: workInput("repro-42"),
      usageControl,
      evidenceLookup: acceptAllEvidenceLookup,
    });

    expect(projected.usageIncluded).toBe(false);
    expect(projected.warning).toContain("daemon unavailable");
    expect(projected.summary.tokenUsage).toBeUndefined();
    expect(projected.work.progress).toMatchObject({ quantified: false, percent: null });
    const stored = JSON.parse(
      await readFile(join(cwd, SPARK_REPRO_REPORT_SUMMARY_PATH), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty("tokenUsage");
  });

  it("does not let an invalid usage scope block the technical projection", async () => {
    const cwd = await temporaryDirectory();
    const projected = await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-42",
      workSummaryInput: workInput("repro-42"),
      usageControl: fixedUsageControl(usage("repro-other")),
      evidenceLookup: acceptAllEvidenceLookup,
    });

    expect(projected.warning).toContain(
      "token usage scope repro-other does not match work summary repro-42",
    );
    expect(projected.summary.tokenUsage).toBeUndefined();
    expect(projected.work.progress).toMatchObject({ quantified: false, percent: null });
  });

  it("rejects a non-stable report Artifact binding", async () => {
    const cwd = await temporaryDirectory();
    await expect(
      projectSparkReproReportSummary({
        cwd,
        currentReproId: "repro-42",
        workSummaryInput: {
          ...workInput("repro-42"),
          reportArtifactRef: "artifact:not-the-run-report",
        },
        usageControl: fixedUsageControl(usage("repro-42")),
        evidenceLookup: acceptAllEvidenceLookup,
      }),
    ).rejects.toThrow("workSummary.reportArtifactRef must be the stable report binding");
  });

  it("rejects accepted formal gates whose evidence is absent from durable storage", async () => {
    const cwd = await temporaryDirectory();
    const usageControl = fixedUsageControl(usage("repro-42"));

    await expect(
      projectSparkReproReportSummary({
        cwd,
        currentReproId: "repro-42",
        workSummaryInput: workInput("repro-42"),
        usageControl,
      }),
    ).rejects.toThrow("report work evidence not found: evidence:contract");
    expect(usageControl.requests).toEqual([]);
  });

  it("accepts formal gate refs resolved through the durable evidence store", async () => {
    const cwd = await temporaryDirectory();
    const store = defaultEvidenceStore(cwd);
    for (const id of ["contract", "reference", "target"]) {
      await store.put({
        ref: evidence(id),
        kind: "record",
        title: id,
        format: "json",
        body: { passed: true },
        provenance: { producer: "spark" },
      });
    }

    const projected = await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-42",
      workSummaryInput: workInput("repro-42"),
      usageControl: fixedUsageControl(usage("repro-42")),
    });

    expect(projected.work.progress).toMatchObject({ quantified: false, percent: null });
    expect(projected.summary.work.gates.filter((gate) => gate.status === "accepted")).toHaveLength(
      3,
    );
  });
});

function workInput(reproId: string): SparkReproWorkSummaryInput {
  return {
    reproId,
    title: "Minimum-complete alignment",
    stage: "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 10,
      referenceStrategies: [],
      validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    },
    profile: profile(1),
    gates: [
      gate("contract", "contract", "accepted"),
      gate("reference", "reference", "accepted", profile(1), ["reference_ready"]),
      gate("target", "target", "accepted", profile(1), ["target_ready"]),
      gate("alignment", "alignment", "open", profile(1)),
      gate("delivery", "delivery", "open"),
    ],
  };
}

function gate(
  id: string,
  stage: SparkReproWorkStage,
  status: SparkReproEvidenceGate["status"],
  gateProfile?: SparkReproProfile,
  establishes?: SparkReproEvidenceGate["establishes"],
): SparkReproEvidenceGate {
  return {
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status,
    weight: 1,
    evidenceRefs: status === "accepted" ? [evidence(id)] : [],
    ...(gateProfile ? { profile: gateProfile } : {}),
    ...(establishes ? { establishes } : {}),
  };
}

function profile(completed: number): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed, target: 10 },
    topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
  };
}

function usage(reproId: string): SparkTokenUsageAggregate {
  const reported = {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 10,
  };
  const zero = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  return {
    scope: { kind: "repro", reproId },
    reported,
    estimated: zero,
    totalTokens: 10,
    responseCount: 1,
    missingResponseCount: 0,
    activeExecutionCount: 0,
    quality: "exact",
    byExecutionKind: { root_session: reported },
    byModel: { model: reported },
    asOf: "2026-08-03T12:00:00.000Z",
  };
}

function fixedUsageControl(value: SparkTokenUsageAggregate): SparkDaemonUsageControl & {
  requests: unknown[];
} {
  const requests: unknown[] = [];
  return {
    requests,
    async summary(input) {
      requests.push(input);
      return value;
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "spark-repro-report-projection-"));
  temporaryDirectories.push(directory);
  return directory;
}

const acceptAllEvidenceLookup = {
  async tryGet(ref: EvidenceRef) {
    return { ref };
  },
};
