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
  type SparkReproFormalEvidenceReceipt,
  type SparkReproValidationMatrix,
  type SparkReproProfile,
  type SparkReproWorkStage,
  type SparkReproWorkSummaryInput,
} from "@zendev-lab/spark-repro/work-summary";

import type { SparkSessionRepro } from "@zendev-lab/spark-repro";
import type { SparkDaemonReproFormalEvidenceControl } from "./spark-daemon-repro-formal-evidence-client.ts";
import type { SparkDaemonUsageControl } from "./spark-daemon-usage-client.ts";
import {
  projectSparkReproReportSummary,
  SPARK_REPRO_REPORT_SUMMARY_PATH,
} from "./spark-repro-report-projection.ts";
import {
  renderSparkReproReportMarkdown,
  sparkReproReportArtifactRef,
  SPARK_REPRO_REPORT_SOURCE_PATH,
  syncSparkReproReportArtifact,
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
    expect(projected.work.progress.quantified).toBe(false);
    expect(projected.work.progress).not.toHaveProperty("percent");
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
    expect(projected.work.progress.quantified).toBe(false);
    expect(projected.work.progress).not.toHaveProperty("percent");
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
    expect(projected.work.progress.quantified).toBe(false);
    expect(projected.work.progress).not.toHaveProperty("percent");
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

  it("rejects caller-asserted formal acceptance without a registered verifier", async () => {
    const cwd = await temporaryDirectory();
    const store = defaultEvidenceStore(cwd);
    await store.put({
      ref: evidence("contract"),
      kind: "record",
      title: "contract",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });

    await expect(
      projectSparkReproReportSummary({
        cwd,
        currentReproId: "repro-verified",
        reproState: strictReproState(),
        workSummaryInput: strictWorkInput(),
        usageControl: fixedUsageControl(usage("repro-verified")),
      }),
    ).rejects.toThrow("daemon registered-verifier receipt authority");
  });

  it("records hash-bound receipts only after the registered verifier accepts", async () => {
    const cwd = await temporaryDirectory();
    const store = defaultEvidenceStore(cwd);
    const evidenceRecord = await store.put({
      ref: evidence("contract"),
      kind: "record",
      title: "contract",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    const recorded: SparkReproFormalEvidenceReceipt[] = [];

    await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-verified",
      reproState: strictReproState(),
      workSummaryInput: strictWorkInput(),
      usageControl: fixedUsageControl(usage("repro-verified")),
      formalEvidenceControl: {
        async verifyAndRecord(input) {
          const receipt: SparkReproFormalEvidenceReceipt = {
            schema: "spark.repro.formal-evidence-receipt/v1",
            ...input.candidate,
            verifierId: "registered-test-verifier",
            verifierVersion: "1",
            verdict: "accepted",
            verifiedAt: "2026-08-09T00:00:00.000Z",
            stale: false,
            superseded: false,
          };
          recorded.push(receipt);
          return { recorded: true, receipt };
        },
      },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      evidenceRef: evidenceRecord.ref,
      evidenceHash: evidenceRecord.hash,
      reproId: "repro-verified",
      requirementId: "contract",
      stepId: "S1",
      planRevision: 1,
      stepDefinitionDigest: "digest:S1",
      verifierId: "registered-test-verifier",
      verdict: "accepted",
      stale: false,
      superseded: false,
    });
  });

  it("refuses to sync a report after the durable Repro plan revision changes", async () => {
    const cwd = await temporaryDirectory();
    await defaultEvidenceStore(cwd).put({
      ref: evidence("contract"),
      kind: "record",
      title: "contract",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    const formalEvidenceControl: SparkDaemonReproFormalEvidenceControl = {
      async verifyAndRecord(input) {
        return {
          recorded: true,
          receipt: {
            schema: "spark.repro.formal-evidence-receipt/v1" as const,
            ...input.candidate,
            verifierId: "registered-test-verifier",
            verifierVersion: "1",
            verdict: "accepted" as const,
            verifiedAt: "2026-08-09T00:00:00.000Z",
            stale: false,
            superseded: false,
          },
        };
      },
    };
    await projectSparkReproReportSummary({
      cwd,
      currentReproId: "repro-verified",
      reproState: strictReproState(),
      workSummaryInput: strictWorkInput(),
      usageControl: fixedUsageControl(usage("repro-verified")),
      formalEvidenceControl,
    });
    const current = strictReproState();
    current.plan.currentRevision = 2;

    await expect(
      syncSparkReproReportArtifact(cwd, "repro-verified", {
        reproState: current,
        formalEvidenceControl,
      }),
    ).rejects.toThrow("report work is stale against the current durable Repro plan revision");
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

    expect(projected.work.progress.quantified).toBe(false);
    expect(projected.work.progress).not.toHaveProperty("percent");
    expect(projected.summary.work.gates.filter((gate) => gate.status === "accepted")).toHaveLength(
      3,
    );
  });
});

function strictWorkInput(): SparkReproWorkSummaryInput {
  const acceptance = strictProfile();
  const gates: SparkReproEvidenceGate[] = [
    gate("contract", "contract", "accepted"),
    gate("reference", "reference", "open", acceptance),
    gate("target", "target", "open", acceptance),
    gate("alignment", "alignment", "open", acceptance),
    gate("delivery", "delivery", "open"),
  ];
  const validationMatrix: SparkReproValidationMatrix = {
    denominators: { contract: 1, reference: 1, target: 1, alignment: 1, delivery: 1 },
    rows: gates.map(
      (candidate) =>
        ({
          id: `entrypoint:${candidate.id}`,
          gateId: candidate.id,
          stage: candidate.stage,
          invocationClass: "owning_entrypoint",
          evidenceClass: "entrypoint",
          ownerStepId: "S1",
          verdict: candidate.status,
          profile: acceptance,
          repetitions: 1,
          exactScope: "registered verifier acceptance",
          evidenceRefs: [...candidate.evidenceRefs],
          ["artifact" + "Refs"]: [],
        }) as unknown as SparkReproValidationMatrix["rows"][number],
    ),
  };
  return {
    schema: "spark.repro.work-summary/v2",
    reproId: "repro-verified",
    title: "Verified formal projection",
    stage: "contract",
    target: {
      model: "minimum_complete",
      requiredSteps: 1,
      referenceStrategies: [],
      validationTopology: acceptance.validationTopology!,
      acceptanceProfile: acceptance,
    },
    profile: acceptance,
    gates,
    validationMatrix,
    exploreFrontier: {
      stage: "contract",
      profile: acceptance,
      planRevision: 1,
      observationId: "obs-contract",
      ownerStepId: "S1",
      stepDefinitionDigest: "digest:S1",
      evidenceRefs: [],
      unresolvedIds: [],
    },
    normativeCursor: {
      planRevision: 1,
      orderedStepIds: ["S1"],
      stepDefinitionDigests: { S1: "digest:S1" },
      stepDependencies: { S1: [] },
      currentStepId: "S1",
      retiredStepIds: [],
      candidateBuffer: [],
      retirementLog: [],
    },
    schedulerActivity: "dormant",
    independentReadyCount: 0,
    retirementBlocks: [],
    unresolved: [],
    nextAction: {
      id: "verify-reference",
      summary: "Verify the reference entrypoint",
      passCriterion: "The registered verifier accepts the next formal receipt",
    },
  };
}

function strictReproState(): SparkSessionRepro {
  return {
    reproId: "repro-verified",
    plan: {
      currentRevision: 1,
      steps: [
        {
          id: "S1",
          status: "done",
          evidenceRefs: [evidence("contract")],
          verification: {
            verdict: "Pass",
            planRevision: 1,
            stepId: "S1",
            definitionDigest: "digest:S1",
            proofKind: "evidence",
            evidenceRefs: [evidence("contract")],
            verifiedDoneWhen: ["contract accepted"],
          },
        },
      ],
    },
  } as unknown as SparkSessionRepro;
}

function strictProfile(): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    modelScope: "minimum_complete",
    computeScope: "optimizer",
    steps: { completed: 1, target: 1 },
    topology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    validationTopology: { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY },
    runtime: {
      framework: "paddle",
      device: "gpu",
      dtype: "bf16",
      hardware: "h800",
      modelRevision: "model-r1",
      configDigest: "sha256:model-config",
    },
  };
}

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
