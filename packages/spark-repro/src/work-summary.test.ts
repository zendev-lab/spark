import { describe, expect, it } from "vitest";

import type { ArtifactRef, AskRef, EvidenceRef } from "@zendev-lab/spark-core";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  SPARK_REPRO_STAGE_WEIGHTS,
  SPARK_REPRO_WORK_STAGES,
  buildSparkReproWorkSummary,
  type SparkReproDecisionRequest,
  type SparkReproEvidenceGate,
  type SparkReproProfile,
  type SparkReproTopology,
  type SparkReproWorkSummaryInput,
  type SparkReproWorkStage,
} from "./work-summary.ts";

const evidence = (id: string) => `evidence:${id}` as EvidenceRef;
const artifact = (id: string) => `artifact:${id}` as ArtifactRef;

describe("Spark Repro work summary", () => {
  it("uses the canonical stage order and fixed value weights", () => {
    expect(SPARK_REPRO_WORK_STAGES).toEqual([
      "contract",
      "reference",
      "target",
      "alignment",
      "delivery",
    ]);
    expect(SPARK_REPRO_STAGE_WEIGHTS).toEqual({
      contract: 5,
      reference: 10,
      target: 25,
      alignment: 55,
      delivery: 5,
    });
  });

  it("derives active, waiting_decision, and complete without an unbound status flag", () => {
    const active = buildSparkReproWorkSummary(baseInput());
    expect(active.status).toBe("active");
    expect(active.progress.percent).toBe(95);
    expect(active.technicalGoal).toMatchObject({
      achieved: true,
      checks: {
        minimumCompleteReferenceReady: true,
        minimumCompleteTargetReady: true,
        requiredStepsAligned: true,
        referenceParity: true,
      },
      alignedSteps: 100,
      validatedReferenceStrategies: ["pp", "ep"],
    });

    const waiting = buildSparkReproWorkSummary({
      ...baseInput(),
      pendingDecisions: [pendingDecision("keep-patch")],
    });
    expect(waiting.status).toBe("waiting_decision");
    expect(waiting.pendingDecisions).toHaveLength(1);

    const completedInput = baseInput();
    completedInput.stage = "delivery";
    completedInput.gates = completedInput.gates.map((gate) =>
      gate.stage === "delivery"
        ? { ...gate, status: "accepted", evidenceRefs: [evidence("delivery")] }
        : gate,
    );
    const complete = buildSparkReproWorkSummary(completedInput);
    expect(complete.status).toBe("complete");
    expect(complete.progress.percent).toBe(100);

    const completeGatesButWaiting = buildSparkReproWorkSummary({
      ...completedInput,
      pendingDecisions: [pendingDecision("publish")],
    });
    expect(completeGatesButWaiting.status).toBe("waiting_decision");
  });

  it("counts only accepted formal minimum-complete gates", () => {
    const input = baseInput();
    input.gates = [
      ...input.gates.map((gate) =>
        gate.stage === "target" || gate.stage === "alignment" ? { ...gate, weight: 1 } : gate,
      ),
      formalGate("target-open", "target", "open", minimumProfile()),
      formalGate("alignment-open", "alignment", "open", minimumProfile()),
      {
        ...formalGate("reduced-accepted", "alignment", "accepted", {
          ...minimumProfile(),
          id: "reduced-moe",
          model: "reduced",
        }),
        weight: 100,
      },
      {
        ...formalGate("probe-diagnostic", "alignment", "accepted", {
          ...minimumProfile(),
          id: "router-probe",
          model: "probe",
        }),
        evidenceClass: "diagnostic",
        weight: 100,
      },
    ];
    input.frontier = {
      stage: "alignment",
      profile: minimumProfile(),
      activeExperiment: {
        id: "exp-order",
        status: "running",
        profile: { ...minimumProfile(), id: "router-probe", model: "probe" },
        hypothesis: "Accumulation order causes the first divergence",
        singleVariable: "accumulation order",
        expectedOutcome: "ON is exact",
        falsificationOutcome: "ON still diverges",
        evidenceRefs: [evidence("experiment-1"), evidence("experiment-2")],
      },
    };

    const summary = buildSparkReproWorkSummary(input);
    expect(summary.progress.percent).toBe(55);
    expect(summary.progress.stages.find((stage) => stage.stage === "target")).toMatchObject({
      acceptedGateIds: ["target-ready"],
      percent: 50,
      contribution: 12.5,
    });
    expect(summary.progress.stages.find((stage) => stage.stage === "alignment")).toMatchObject({
      acceptedGateIds: ["required-alignment"],
      percent: 50,
      contribution: 27.5,
    });
  });

  it("keeps technical completion limited to minimum-complete steps and reference parity", () => {
    const input = baseInput();
    input.gates = input.gates.map((gate) =>
      gate.id === "required-alignment" && gate.profile
        ? {
            ...gate,
            profile: {
              ...gate.profile,
              topology: topology({ pp: 2 }),
            },
          }
        : gate,
    );
    expect(() => buildSparkReproWorkSummary(input)).toThrow(
      "gates[3] cannot establish reference_parity outside validationTopology",
    );

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        target: {
          ...baseInput().target,
          validationTopology: topology({ pp: 2 }),
        },
      }),
    ).toThrow("target.validationTopology must activate exactly target.referenceStrategies");

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        profile: { ...minimumProfile(), topology: topology({ tp: 2 }) },
      }),
    ).toThrow("profile.topology expands beyond reference parity: tp");
  });

  it("keeps Artifact bindings separate from Evidence refs", () => {
    const input = baseInput();
    input.reportArtifactRef = artifact("report");
    input.artifactRefs = [artifact("other"), artifact("report")];
    input.tasks = [
      { id: "task-align", title: "Align optimizer", stage: "alignment", status: "running" },
    ];
    input.todos = [
      {
        id: "todo-rerun",
        taskId: "task-align",
        content: "Run the third ON repetition",
        status: "in_progress",
      },
    ];
    const summary = buildSparkReproWorkSummary(input);
    expect(summary.reportArtifactRef).toBe("artifact:report");
    expect(summary.artifactRefs).toEqual(["artifact:report", "artifact:other"]);
    expect(summary.gates.flatMap((gate) => gate.evidenceRefs)).not.toContain("artifact:report");
    expect(summary.tasks[0]?.id).toBe("task-align");
    expect(summary.todos[0]?.taskId).toBe("task-align");

    const invalidEvidence = baseInput();
    invalidEvidence.gates[0]!.evidenceRefs = [artifact("not-evidence") as unknown as EvidenceRef];
    expect(() => buildSparkReproWorkSummary(invalidEvidence)).toThrow(
      "gates[0].evidenceRefs[0] must be an evidence: ref",
    );
    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        artifactRefs: [evidence("not-artifact") as unknown as ArtifactRef],
      }),
    ).toThrow("artifactRefs[0] must be an artifact: ref");
  });

  it("fails closed on malformed decisions and unsupported formal acceptance", () => {
    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        pendingDecisions: [{ ...pendingDecision("bad"), options: [] }],
      }),
    ).toThrow("pendingDecisions[0].options must contain two or three choices");

    const missingEvidence = baseInput();
    missingEvidence.gates[0]!.evidenceRefs = [];
    expect(() => buildSparkReproWorkSummary(missingEvidence)).toThrow(
      "gates[0] cannot accept a formal gate without evidence",
    );

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        todos: [{ id: "orphan", taskId: "missing", content: "Orphan", status: "pending" }],
      }),
    ).toThrow("todos[0].taskId does not reference a summary task");

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        pendingDecisions: [
          {
            ...pendingDecision("untyped"),
            kind: "agent_guess" as unknown as SparkReproDecisionRequest["kind"],
          },
        ],
      }),
    ).toThrow("pendingDecisions[0].kind has an unsupported value: agent_guess");

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        pendingDecisions: [
          { ...pendingDecision("missing-ask"), askRef: undefined as unknown as AskRef },
        ],
      }),
    ).toThrow("pendingDecisions[0].askRef must be an ask: ref");

    expect(() =>
      buildSparkReproWorkSummary({
        ...baseInput(),
        conclusions: [
          {
            id: "bad-ref",
            claim: "This must not alias an Artifact as evidence",
            verdict: "confirmed",
            profile: minimumProfile(),
            evidenceRefs: [artifact("report") as unknown as EvidenceRef],
          },
        ],
      }),
    ).toThrow("conclusions[0].evidenceRefs[0] must be an evidence: ref");
  });
});

function baseInput(): SparkReproWorkSummaryInput {
  return {
    reproId: "repro:minimax-m25",
    title: "MiniMax-M2.5 reproduction",
    stage: "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: ["pp", "ep"],
      validationTopology: topology({ pp: 2, ep: 4 }),
    },
    profile: minimumProfile(),
    gates: [
      formalGate("contract-frozen", "contract", "accepted"),
      {
        ...formalGate("reference-ready", "reference", "accepted", minimumProfile()),
        establishes: ["reference_ready"],
      },
      {
        ...formalGate("target-ready", "target", "accepted", minimumProfile()),
        establishes: ["target_ready"],
      },
      {
        ...formalGate("required-alignment", "alignment", "accepted", {
          ...minimumProfile(),
          steps: { completed: 100, target: 100 },
          topology: topology({ pp: 2, ep: 4 }),
        }),
        establishes: ["required_steps_aligned", "reference_parity"],
      },
      formalGate("delivery-ready", "delivery", "open"),
    ],
  };
}

function formalGate(
  id: string,
  stage: SparkReproWorkStage,
  status: SparkReproEvidenceGate["status"],
  profile?: SparkReproProfile,
): SparkReproEvidenceGate {
  return {
    id,
    title: id,
    stage,
    evidenceClass: "formal",
    status,
    weight: 1,
    evidenceRefs: status === "accepted" ? [evidence(id)] : [],
    ...(profile ? { profile } : {}),
  };
}

function minimumProfile(): SparkReproProfile {
  return {
    id: "minimum-complete",
    model: "minimum_complete",
    compute: "optimizer",
    steps: { completed: 1, target: 1 },
    topology: topology(),
  };
}

function topology(overrides: Partial<SparkReproTopology> = {}): SparkReproTopology {
  return { ...SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY, ...overrides };
}

function pendingDecision(id: string): SparkReproDecisionRequest {
  return {
    id,
    status: "pending",
    kind: "global_behavior_change",
    question: "Keep the stable accumulation patch?",
    options: [
      { value: "keep", label: "Keep patch", recommended: true },
      { value: "remove", label: "Continue localization" },
    ],
    blockedTransition: { from: "alignment", to: "alignment" },
    evidenceRefs: [evidence("patch-ablation")],
    askRef: `ask:${id}` as AskRef,
  };
}
