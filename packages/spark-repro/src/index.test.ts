import { describe, expect, it } from "vitest";

import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  createSparkSessionRepro,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  recordReproRequirementProof,
  reviseReproPlan,
  settleReproTick,
  updateReproStep,
  type SparkReproStepDefinition,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
} from "./index.ts";

const ref = (id: string) => `evidence:${id}` as EvidenceRef;

describe("spark-repro", () => {
  it("starts with a draft Goal Contract and a typed plan seeded from fixed gates", () => {
    const repro = createSparkSessionRepro("session:test", undefined, {
      objective: "Reproduce target logits",
    });

    expect(repro.version).toBe(4);
    expect(repro.goalContract).toMatchObject({
      status: "draft",
      objective: "Reproduce target logits",
    });
    expect(repro.plan.currentRevision).toBe(1);
    expect(repro.plan).toMatchObject({ difficulty: 8, minimumStepCount: 11 });
    expect(repro.plan.steps[0]).toMatchObject({
      id: "repro-contract-frozen",
      stage: "setup",
      authority: "safe_local",
      status: "pending",
    });
    expect(
      repro.plan.steps.find((step) => step.id === "implementation-strategy-approved"),
    ).toMatchObject({ authority: "ask_decision" });
  });

  it("requires research, explicit decisions, and a passing probe during setup", () => {
    let repro = createSparkSessionRepro("session:test");
    const proofs: Array<[string, SparkReproRequirementProof]> = [
      ["repro-contract-frozen", { kind: "evidence", evidenceRefs: [ref("contract")] }],
      [
        "competitor-baseline-availability-researched",
        { kind: "evidence", evidenceRefs: [ref("baseline-availability")] },
      ],
      [
        "baseline-construction-strategy-approved",
        {
          kind: "decision",
          decisionRef: ref("baseline-construction-ask"),
          selectedValue: "reuse-existing",
        },
      ],
      [
        "implementation-landscape-researched",
        { kind: "evidence", evidenceRefs: [ref("implementation-research")] },
      ],
      [
        "alignment-paths-researched",
        { kind: "evidence", evidenceRefs: [ref("alignment-research")] },
      ],
      [
        "implementation-strategy-approved",
        { kind: "decision", decisionRef: ref("implementation-ask"), selectedValue: "reuse" },
      ],
      [
        "alignment-strategy-approved",
        { kind: "decision", decisionRef: ref("alignment-ask"), selectedValue: "real-module" },
      ],
    ];

    for (const [id, proof] of proofs) {
      repro = recordReproRequirementProof(repro, id, proof)!;
    }
    expect(isPhaseComplete(repro)).toBe(false);

    repro = recordReproRequirementProof(repro, "baseline-probe-passed", {
      kind: "validation",
      command: "run baseline probe",
      resultRef: ref("baseline-result"),
      passed: true,
    })!;
    expect(isPhaseComplete(repro)).toBe(true);
  });

  it("derives a gate failure and clears a stale evaluation when proof changes", () => {
    let repro: SparkSessionRepro = {
      ...createSparkSessionRepro("session:test"),
      currentStageIndex: 2,
      currentPhase: "implement" as const,
    };
    repro = evaluateStageGate(repro).repro;
    expect(repro.stages[2]?.gate?.evaluation?.passed).toBe(false);

    repro = recordReproRequirementProof(repro, "bitwise-pass-20", {
      kind: "validation",
      command: "run 20",
      resultRef: ref("20-result"),
      passed: true,
    })!;
    expect(repro.stages[2]?.gate?.evaluation).toBeUndefined();
  });

  it("appends plan revisions, preserves unchanged progress, and reopens a changed contract", () => {
    let repro = createSparkSessionRepro("session:test", undefined, {
      objective: "Original objective",
    });
    repro = recordReproRequirementProof(repro, "repro-contract-frozen", {
      kind: "evidence",
      evidenceRefs: [ref("contract")],
    })!;
    repro = recordReproRequirementProof(repro, "competitor-baseline-availability-researched", {
      kind: "evidence",
      evidenceRefs: [ref("baseline")],
    })!;
    const steps = repro.plan.steps.map(stepDefinition);

    repro = reviseReproPlan(repro, {
      reason: "Clarify the reproduction target",
      goalContract: {
        objective: "Revised objective",
        constraints: ["Use official weights"],
        nonGoals: ["Performance tuning"],
        successCriteria: ["20-step bitwise parity"],
        evidenceRequired: ["Command output"],
      },
      steps,
    });

    expect(repro.plan.currentRevision).toBe(2);
    expect(repro.plan.revisions).toHaveLength(2);
    expect(repro.goalContract.status).toBe("draft");
    expect(repro.goalContract.evidenceRefs).toEqual([]);
    expect(
      isReproRequirementSatisfied(
        repro.stages[0]!.acceptance.find(
          (requirement) => requirement.id === "repro-contract-frozen",
        )!,
      ),
    ).toBe(false);
    expect(repro.plan.steps.find((step) => step.id === "repro-contract-frozen")).toMatchObject({
      status: "pending",
      evidenceRefs: [],
    });
    expect(
      repro.plan.steps.find((step) => step.id === "competitor-baseline-availability-researched"),
    ).toMatchObject({ status: "done", evidenceRefs: [ref("baseline")] });
  });

  it("rejects incomplete or cyclic plan revisions", () => {
    const repro = createSparkSessionRepro("session:test");
    const steps = repro.plan.steps.map(stepDefinition);

    expect(() =>
      reviseReproPlan(repro, {
        reason: "Introduce a cycle",
        steps: steps.map((step, index) =>
          index === 0
            ? { ...step, dependsOn: [steps[1]!.id] }
            : index === 1
              ? { ...step, dependsOn: [steps[0]!.id] }
              : step,
        ),
      }),
    ).toThrow(/dependency cycle/u);
    expect(() =>
      reviseReproPlan(repro, {
        reason: "Drop a stage",
        steps: steps.filter((step) => step.stage !== "deliver"),
      }),
    ).toThrow(/requires at least one step for stage deliver/u);
    expect(() =>
      reviseReproPlan(repro, {
        reason: "Under-split a hard task",
        difficulty: 10,
        steps: steps.filter(
          (step) =>
            ![
              "competitor-baseline-availability-researched",
              "implementation-landscape-researched",
              "alignment-paths-researched",
              "alignment-strategy-approved",
            ].includes(step.id),
        ),
      }),
    ).toThrow(/difficulty 10 requires at least 13 plan steps/u);
    expect(() =>
      reviseReproPlan(repro, {
        reason: "Depend on future-stage work",
        steps: steps.map((step) =>
          step.id === "repro-contract-frozen" ? { ...step, dependsOn: ["pr-submitted"] } : step,
        ),
      }),
    ).toThrow(/cannot depend on later-stage step/u);
  });

  it("requires evidence for done steps and asks after three unchanged settlements", () => {
    let repro = createSparkSessionRepro("session:test");
    expect(() => updateReproStep(repro, "repro-contract-frozen", { status: "done" })).toThrow(
      /requires evidence/u,
    );

    expect(settleReproTick(repro).decision).toBe("continue");
    repro = settleReproTick(repro).repro;
    repro = settleReproTick(repro).repro;
    const third = settleReproTick(repro);
    expect(third.decision).toBe("ask");
    expect(third.repro.stopGuard.stagnationCount).toBe(3);

    const progressed = updateReproStep(third.repro, "repro-contract-frozen", {
      status: "in_progress",
    })!;
    const reset = settleReproTick(progressed);
    expect(reset.decision).toBe("continue");
    expect(reset.repro.stopGuard.stagnationCount).toBe(0);
  });

  it("does not start a step before its dependencies finish", () => {
    let repro = createSparkSessionRepro("session:test");
    repro = reviseReproPlan(repro, {
      reason: "Make setup ordering explicit",
      steps: repro.plan.steps.map((step) =>
        step.id === "competitor-baseline-availability-researched"
          ? { ...stepDefinition(step), dependsOn: ["repro-contract-frozen"] }
          : stepDefinition(step),
      ),
    });

    expect(() =>
      updateReproStep(repro, "competitor-baseline-availability-researched", {
        status: "done",
        evidenceRefs: [ref("baseline")],
      }),
    ).toThrow(/incomplete dependencies: repro-contract-frozen/u);
  });
});

function stepDefinition(
  step: SparkSessionRepro["plan"]["steps"][number],
): SparkReproStepDefinition {
  return {
    id: step.id,
    stage: step.stage,
    goal: step.goal,
    doneWhen: step.doneWhen,
    evidenceRequired: step.evidenceRequired,
    authority: step.authority,
    ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
  };
}
