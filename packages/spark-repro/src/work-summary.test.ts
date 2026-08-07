import { describe, expect, it } from "vitest";

import type { ArtifactRef, AskRef, EvidenceRef } from "@zendev-lab/spark-core";
import {
  SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY,
  SPARK_REPRO_STAGE_WEIGHTS,
  SPARK_REPRO_WORK_STAGES,
  SPARK_REPRO_WORK_SUMMARY_SCHEMA,
  advanceSparkReproExploreFrontier,
  buildSparkReproWorkSummary,
  dischargeSparkReproUnresolved,
  normalizeSparkReproWorkSummary,
  reconcileSparkReproNormativeRetirement,
  recordSparkReproRetirementCandidate,
  registerSparkReproUnresolved,
  sparkReproProfileDigest,
  supersedeSparkReproUnresolved,
  validateSparkReproProfile,
  type SparkReproActiveExperiment,
  type SparkReproDecisionRequest,
  type SparkReproDualLaneState,
  type SparkReproEvidenceGate,
  type SparkReproNumericalFrontier,
  type SparkReproProfile,
  type SparkReproRetirementCandidate,
  type SparkReproTopology,
  type SparkReproUnresolvedItem,
  type SparkReproValidationMatrix,
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

  it("migrates legacy summaries without promoting gates into formal progress", () => {
    const active = buildSparkReproWorkSummary(baseInput());
    expect(active.status).toBe("active");
    expect(active.progress.quantified).toBe(false);
    expect(active.progress).not.toHaveProperty("percent");
    expect(active.technicalGoal.achieved).toBe(false);
    expect(active.migration).toEqual({
      sourceSchema: "spark.repro.work-summary/v1",
      revision: 1,
      legacyProofAuthority: "not_promoted",
    });

    const waiting = buildSparkReproWorkSummary({
      ...baseInput(),
      pendingDecisions: [pendingDecision("keep-patch")],
    });
    expect(waiting.status).toBe("waiting_decision");
    expect(waiting.pendingDecisions).toHaveLength(1);

    const legacyCompletedInput = baseInput();
    legacyCompletedInput.stage = "delivery";
    legacyCompletedInput.gates = legacyCompletedInput.gates.map((gate) =>
      gate.stage === "delivery"
        ? { ...gate, status: "accepted", evidenceRefs: [evidence("delivery")] }
        : gate,
    );
    const migrated = buildSparkReproWorkSummary(legacyCompletedInput);
    expect(migrated.status).toBe("active");
    expect(migrated.validationMatrix.rows.every((row) => row.evidenceClass === "probe")).toBe(true);
  });

  it("keeps all legacy formal and diagnostic gates outside acceptedGateIds", () => {
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
    expect(summary.progress.quantified).toBe(false);
    expect(summary.progress).not.toHaveProperty("percent");
    expect(summary.progress.stages.flatMap((stage) => stage.acceptedGateIds)).toEqual([]);
    expect(summary.validationMatrix.rows.every((row) => row.evidenceClass === "probe")).toBe(true);
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

describe("Spark Repro dual-lane work-summary/v2", () => {
  it("serializes both lanes, frozen Profile, scheduler activity, and formal state", () => {
    const input = v2Input();
    input.exploreFrontier = {
      stage: "delivery",
      profile: v2Profile({ modelScope: "probe", computeScope: "forward", completed: 1 }),
      planRevision: 7,
      observationId: "obs-delivery",
      ownerStepId: "S1-reference",
      stepDefinitionDigest: "digest-delivery-probe",
      evidenceRefs: [evidence("delivery-probe")],
      unresolvedIds: ["u-adapter"],
    };
    input.normativeCursor = {
      planRevision: 7,
      orderedStepIds: ["S1-reference", "S2-target", "S3-alignment"],
      stepDefinitionDigests: {
        "S1-reference": "digest-delivery-probe",
        "S2-target": "digest:S2-target",
        "S3-alignment": "digest:S3-alignment",
      },
      stepDependencies: {
        "S1-reference": [],
        "S2-target": ["S1-reference"],
        "S3-alignment": ["S2-target"],
      },
      currentStepId: "S1-reference",
      retiredStepIds: [],
      candidateBuffer: [],
      retirementLog: [],
    };
    input.unresolved = [
      {
        ...unresolved("u-adapter"),
        ownerStepId: "S1-reference",
        stepDefinitionDigest: "digest-delivery-probe",
      },
    ];
    input.schedulerActivity = "running";
    input.independentReadyCount = 3;
    input.activeExperiment = activeExperiment();
    input.retirementBlocks = [
      {
        id: "decision:reference",
        kind: "decision",
        ownerStepId: "S1-reference",
        reason: "Reference ownership requires a direct-user answer",
        askRef: "ask:reference" as AskRef,
      },
    ];

    const summary = buildSparkReproWorkSummary(input);
    expect(summary).toMatchObject({
      schema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
      status: "waiting_decision",
      schedulerActivity: "running",
      independentReadyCount: 3,
      retirementBlocks: 1,
      exploreFrontier: { stage: "delivery" },
      normativeCursor: { currentStepId: "S1-reference" },
      acceptanceProfile: {
        modelScope: "minimum_complete",
        computeScope: "optimizer",
        steps: { target: 100 },
        validationTopology: { pp: 2, ep: 4, etp: 1, worldSize: 8 },
      },
    });
    expect(summary.formalProgress).toEqual(summary.progress);
    expect(summary.progress).toMatchObject({ quantified: true, percent: 95 });
    expect(summary.status).not.toBe("complete");
  });

  it.each([
    ["active", "running", true],
    ["active", "dormant", true],
    ["active", "sealed", false],
    ["waiting_decision", "running", true],
    ["waiting_decision", "dormant", true],
    ["waiting_decision", "sealed", false],
    ["complete", "running", false],
    ["complete", "dormant", false],
    ["complete", "sealed", true],
  ] as const)("enforces status=%s × activity=%s legality", (status, activity, legal) => {
    const input = v2Input();
    if (status === "waiting_decision") input.retirementBlocks = 1;
    if (status === "complete") {
      input.stage = "delivery";
      delete input.activeExperiment;
      input.gates = acceptDelivery(input.gates);
      input.normativeCursor = {
        planRevision: 7,
        orderedStepIds: ["S1"],
        stepDefinitionDigests: { S1: "digest:alignment" },
        stepDependencies: { S1: [] },
        retiredStepIds: ["S1"],
        candidateBuffer: [],
        retirementLog: [
          {
            stepId: "S1",
            candidateId: "C1",
            planRevision: 7,
            stepDefinitionDigest: "digest:alignment",
            profile: input.target.acceptanceProfile!,
            profileDigest: sparkReproProfileDigest(input.target.acceptanceProfile!),
            evidenceRefs: [evidence("S1-retired")],
          },
        ],
      };
      input.validationMatrix = matrixFor(input.gates, input.target.acceptanceProfile!, {
        delivery: 1,
      });
    }
    input.schedulerActivity = activity;
    input.independentReadyCount = 0;
    const execute = () => buildSparkReproWorkSummary(input);
    if (legal) {
      expect(execute()).toMatchObject({ status, schedulerActivity: activity });
    } else {
      expect(execute).toThrow();
    }
  });

  it("accepts PP/EP as the exact frozen acceptance topology", () => {
    const summary = buildSparkReproWorkSummary(v2Input());
    expect(summary.acceptanceProfile.validationTopology).toMatchObject({
      pp: 2,
      ep: 4,
      etp: 1,
      worldSize: 8,
    });
    expect(
      summary.acceptanceProfile.validationTopology?.strategies?.map((entry) => entry.axis),
    ).toEqual(["ep", "pp"]);
    expect(summary.technicalGoal.validatedReferenceStrategies).toEqual(["pp", "ep"]);
  });

  it.each(profileInvalidCases())(
    "rejects missing or unknown Profile field: %s",
    (_name, mutate) => {
      const input = v2Input();
      const profile = structuredClone(input.profile) as SparkReproProfile;
      mutate(profile as unknown as Record<string, unknown>);
      expect(() =>
        validateSparkReproProfile(profile, input.target, {
          requireVNext: true,
          field: "profile",
        }),
      ).toThrow();
    },
  );

  it("derives 5%, 42.5%, 95%, and unquantified from frozen gate denominators", () => {
    const contractOnly = v2Input();
    contractOnly.gates = contractOnly.gates.map((gate) =>
      gate.stage === "contract"
        ? gate
        : { ...gate, status: "open", evidenceRefs: [], establishes: undefined },
    ) as SparkReproEvidenceGate[];
    contractOnly.validationMatrix = matrixFor(
      contractOnly.gates,
      contractOnly.target.acceptanceProfile!,
    );
    expect(buildSparkReproWorkSummary(contractOnly).progress).toMatchObject({
      quantified: true,
      percent: 5,
    });

    const earlyAlignment = v2Input();
    earlyAlignment.validationMatrix = matrixFor(
      earlyAlignment.gates,
      earlyAlignment.target.acceptanceProfile!,
      { alignment: 22 },
    );
    expect(buildSparkReproWorkSummary(earlyAlignment).progress).toMatchObject({
      quantified: true,
      percent: 42.5,
    });

    const deliveryPending = v2Input();
    expect(buildSparkReproWorkSummary(deliveryPending).progress).toMatchObject({
      quantified: true,
      percent: 95,
    });

    const unknown = v2Input();
    unknown.validationMatrix = matrixFor(unknown.gates, unknown.target.acceptanceProfile!, {
      alignment: null,
    });
    const unknownSummary = buildSparkReproWorkSummary(unknown);
    expect(unknownSummary.progress.quantified).toBe(false);
    expect(unknownSummary.progress).not.toHaveProperty("percent");
  });

  it("keeps probe validation diagnostic while entrypoint acceptance advances the gate", () => {
    const input = v2Input();
    const acceptance = input.target.acceptanceProfile!;
    input.validationMatrix = {
      denominators: stageDenominators(1),
      rows: input.gates.map((gate) => ({
        id: `probe:${gate.id}`,
        gateId: gate.id,
        stage: gate.stage,
        invocationClass: "owning_entrypoint",
        evidenceClass: "probe",
        verdict: gate.status,
        profile: acceptance,
        repetitions: 2,
        exactScope: "owning entrypoint diagnostic receipt",
        evidenceRefs: [...gate.evidenceRefs],
        artifactRefs: [],
      })),
    };
    const diagnostic = buildSparkReproWorkSummary(input);
    expect(diagnostic.progress).toMatchObject({ quantified: true, percent: 0 });
    expect(diagnostic.progress.stages.flatMap((stage) => stage.acceptedGateIds)).toEqual([]);

    input.validationMatrix.rows.push(
      ...input.gates.map((gate) => ({
        id: `entrypoint:${gate.id}`,
        gateId: gate.id,
        stage: gate.stage,
        invocationClass: "owning_entrypoint" as const,
        evidenceClass: "entrypoint" as const,
        verdict: gate.status,
        profile: acceptance,
        repetitions: 2,
        exactScope: "frozen acceptance entrypoint",
        evidenceRefs: [...gate.evidenceRefs],
        artifactRefs: [],
      })),
    );
    const formal = buildSparkReproWorkSummary(input);
    expect(formal.progress).toMatchObject({ quantified: true, percent: 95 });
    expect(formal.progress.stages.flatMap((stage) => stage.acceptedGateIds)).toEqual([
      "contract-frozen",
      "reference-ready",
      "target-ready",
      "required-alignment",
    ]);
  });

  it("does not let Explore, probe, experiments, tasks, or ready work alter formal progress", () => {
    const input = v2Input();
    input.exploreFrontier = {
      stage: "delivery",
      profile: v2Profile({ modelScope: "full", computeScope: "checkpoint" }),
      planRevision: 7,
      observationId: "obs-full-delivery",
      ownerStepId: "S1",
      stepDefinitionDigest: "digest:alignment",
      evidenceRefs: [evidence("full-delivery")],
      unresolvedIds: [],
    };
    input.activeExperiment = activeExperiment();
    input.tasks = [
      { id: "probe-task", title: "Run full probe", stage: "delivery", status: "done" },
    ];
    input.independentReadyCount = 3;
    input.schedulerActivity = "running";
    const summary = buildSparkReproWorkSummary(input);
    expect(summary.progress).toMatchObject({ quantified: true, percent: 95 });
    expect(summary.status).toBe("active");
  });

  it("rejects isolated diagnostics and incomplete Profiles that claim entrypoint authority", () => {
    const isolated = v2Input();
    isolated.validationMatrix!.rows[0] = {
      ...isolated.validationMatrix!.rows[0]!,
      invocationClass: "isolated_diagnostic",
      evidenceClass: "entrypoint",
    };
    expect(() => buildSparkReproWorkSummary(isolated)).toThrow(
      "entrypoint evidence requires invocationClass=owning_entrypoint",
    );

    const incomplete = v2Input();
    incomplete.validationMatrix!.rows[0] = {
      ...incomplete.validationMatrix!.rows[0]!,
      profile: v2Profile({ completed: 0, target: 100 }),
    };
    expect(() => buildSparkReproWorkSummary(incomplete)).toThrow(
      "entrypoint Profile must exactly match target.acceptanceProfile",
    );
  });

  it("rejects an accepted Normative candidate outside the frozen acceptance Profile", () => {
    const state = dualLaneState();
    expect(() =>
      recordSparkReproRetirementCandidate(state, {
        ...candidate("probe-candidate", "S1", []),
        profile: v2Profile({ modelScope: "probe", computeScope: "forward", completed: 0 }),
      }),
    ).toThrow("candidate profile does not match the frozen acceptance Profile");
  });

  it("requires a superseded unresolved chain to discharge before retirement", () => {
    let state = registerSparkReproUnresolved(dualLaneState(), unresolved("u-original"));
    state = registerSparkReproUnresolved(state, {
      ...unresolved("u-successor"),
      ownerStepId: "S2",
      stepDefinitionDigest: "digest:S2",
    });
    state = supersedeSparkReproUnresolved(state, {
      id: "u-original",
      supersededBy: "u-successor",
      planRevision: 7,
    });
    state = recordSparkReproRetirementCandidate(state, candidate("C1", "S1", []));
    expect(reconcileSparkReproNormativeRetirement(state).normativeCursor.retirementLog).toEqual([]);

    state = dischargeSparkReproUnresolved(state, {
      id: "u-successor",
      planRevision: 7,
      stepDefinitionDigest: "digest:S2",
      evidenceRefs: [evidence("u-successor-discharge")],
    });
    expect(
      reconcileSparkReproNormativeRetirement(state).normativeCursor.retirementLog.map(
        (entry) => entry.stepId,
      ),
    ).toEqual(["S1"]);
  });

  it("rejects inconsistent world size and duplicate strategy axes", () => {
    const input = v2Input();
    const wrongWorld = structuredClone(input.profile);
    wrongWorld.topology.worldSize = 7;
    wrongWorld.validationTopology!.worldSize = 7;
    expect(() =>
      validateSparkReproProfile(wrongWorld, input.target, {
        requireVNext: true,
        field: "profile",
      }),
    ).toThrow("worldSize must equal");

    const duplicateAxis = structuredClone(input.profile);
    const duplicate = {
      ...duplicateAxis.validationTopology!.strategies![0]!,
      id: "duplicate-axis",
    };
    duplicateAxis.validationTopology!.strategies!.push(duplicate);
    duplicateAxis.topology.strategies!.push(structuredClone(duplicate));
    expect(() =>
      validateSparkReproProfile(duplicateAxis, input.target, {
        requireVNext: true,
        field: "profile",
      }),
    ).toThrow("exactly one strategy per active axis");
  });

  it("buffers S3/S2 candidates and retires S1,S2,S3 only in dependency order", () => {
    let state = dualLaneState();
    state = recordSparkReproRetirementCandidate(state, candidate("C3", "S3", ["S2"]));
    state = reconcileSparkReproNormativeRetirement(state);
    expect(state.normativeCursor.currentStepId).toBe("S1");
    expect(state.normativeCursor.retirementLog).toEqual([]);

    state = recordSparkReproRetirementCandidate(state, candidate("C2", "S2", ["S1"]));
    state = reconcileSparkReproNormativeRetirement(state);
    expect(state.normativeCursor.currentStepId).toBe("S1");

    state = recordSparkReproRetirementCandidate(state, candidate("C1", "S1", []));
    state = reconcileSparkReproNormativeRetirement(state);
    expect(state.normativeCursor.currentStepId).toBeUndefined();
    expect(state.normativeCursor.retirementLog.map((entry) => entry.stepId)).toEqual([
      "S1",
      "S2",
      "S3",
    ]);
  });

  it("does not retire a step while its completion-required unresolved item remains open", () => {
    let state = registerSparkReproUnresolved(dualLaneState(), unresolved("u-owned"));
    state = recordSparkReproRetirementCandidate(state, candidate("C1", "S1", []));
    expect(reconcileSparkReproNormativeRetirement(state).normativeCursor.retirementLog).toEqual([]);

    state = dischargeSparkReproUnresolved(state, {
      id: "u-owned",
      planRevision: 7,
      stepDefinitionDigest: "digest:S1",
      evidenceRefs: [evidence("u-owned-discharge")],
    });
    expect(
      reconcileSparkReproNormativeRetirement(state).normativeCursor.retirementLog.map(
        (entry) => entry.stepId,
      ),
    ).toEqual(["S1"]);
  });

  it("rejects stale observations, candidates, bypasses, and unresolved discharge", () => {
    const state = dualLaneState();
    expect(() =>
      advanceSparkReproExploreFrontier(state, {
        id: "stale-observation",
        stage: "delivery",
        profile: v2Profile({ modelScope: "probe" }),
        planRevision: 6,
        ownerStepId: "S1",
        stepDefinitionDigest: "stale-digest",
        evidenceRefs: [evidence("stale-observation")],
        unresolvedIds: [],
      }),
    ).toThrow("stale Explore observation plan revision");
    expect(() =>
      advanceSparkReproExploreFrontier(state, {
        id: "stale-definition-observation",
        stage: "delivery",
        profile: v2Profile({ modelScope: "probe" }),
        planRevision: 7,
        ownerStepId: "S1",
        stepDefinitionDigest: "old-digest:S1",
        evidenceRefs: [evidence("stale-definition-observation")],
        unresolvedIds: [],
      }),
    ).toThrow("stale Explore observation step definition digest");
    expect(() =>
      recordSparkReproRetirementCandidate(state, {
        ...candidate("stale-definition", "S1", []),
        stepDefinitionDigest: "old-digest:S1",
      }),
    ).toThrow("stale retirement candidate step definition digest");
    expect(() =>
      recordSparkReproRetirementCandidate(state, candidate("stale", "S1", [], 6)),
    ).toThrow("stale retirement candidate plan revision");
    expect(() =>
      registerSparkReproUnresolved(state, { ...unresolved("stale-bypass"), planRevision: 6 }),
    ).toThrow("stale unresolved registration plan revision");

    const withBypass = registerSparkReproUnresolved(state, unresolved("u1"));
    expect(() =>
      dischargeSparkReproUnresolved(withBypass, {
        id: "u1",
        planRevision: 6,
        stepDefinitionDigest: "digest:S1",
        evidenceRefs: [evidence("late-answer")],
      }),
    ).toThrow("stale unresolved discharge binding");
    expect(() =>
      dischargeSparkReproUnresolved(withBypass, {
        id: "u1",
        planRevision: 7,
        stepDefinitionDigest: "digest:S1",
        evidenceRefs: [],
      }),
    ).toThrow("unresolved discharge requires formal evidence");
    const discharged = dischargeSparkReproUnresolved(withBypass, {
      id: "u1",
      planRevision: 7,
      stepDefinitionDigest: "digest:S1",
      evidenceRefs: [evidence("formal-discharge")],
    });
    expect(discharged.unresolved[0]).toMatchObject({
      status: "discharged",
      evidenceRefs: ["evidence:formal-discharge"],
    });
  });

  it("serializes unknown numerical inventory as unquantified rather than zero", () => {
    const input = v2Input();
    input.numericalFrontier = numericalFrontier();
    const summary = buildSparkReproWorkSummary(input);
    expect(summary.numericalFrontier).toMatchObject({
      claims: {
        native_module_boundary: "established",
        derived_reference_boundary: "established",
        native_internal_boundary: "not_established",
      },
      comparedInventory: { quantified: false },
      exactCoverage: {
        quantified: false,
        tensors: null,
        elements: null,
        steps: null,
      },
      activeBlocker: "native fused-kernel internals are not instrumented",
    });
  });

  it("normalizes work-summary/v1 twice without promoting legacy proof", () => {
    const legacy = buildSparkReproWorkSummary(baseInput()) as unknown as Record<string, unknown>;
    legacy.schema = "spark.repro.work-summary/v1";
    delete legacy.validationMatrix;
    delete legacy.exploreFrontier;
    delete legacy.normativeCursor;
    delete legacy.unresolved;
    delete legacy.retirementBlockers;
    delete legacy.formalProgress;

    const first = normalizeSparkReproWorkSummary(legacy);
    const second = normalizeSparkReproWorkSummary(first);
    expect(second).toEqual(first);
    expect(first.schema).toBe(SPARK_REPRO_WORK_SUMMARY_SCHEMA);
    expect(first.migration).toEqual({
      sourceSchema: "spark.repro.work-summary/v1",
      revision: 1,
      legacyProofAuthority: "not_promoted",
    });
    expect(first.profile.unknownFields).toEqual(["runtime"]);
    expect(first.progress.quantified).toBe(false);
    expect(first.progress).not.toHaveProperty("percent");
    expect(first.validationMatrix.rows.every((row) => row.evidenceClass === "probe")).toBe(true);
    expect(
      first.validationMatrix.rows.every((row) => row.invocationClass === "isolated_diagnostic"),
    ).toBe(true);
    expect(first.unresolved).toEqual([]);
    expect(first.exploreFrontier.observationId).toBeUndefined();
    expect(first.progress.stages.flatMap((stage) => stage.acceptedGateIds)).toEqual([]);
  });
});

function v2Input(): SparkReproWorkSummaryInput {
  const acceptance = v2Profile({ completed: 100, target: 100 });
  const gates: SparkReproEvidenceGate[] = [
    formalGate("contract-frozen", "contract", "accepted"),
    {
      ...formalGate("reference-ready", "reference", "accepted", v2Profile({ completed: 1 })),
      establishes: ["reference_ready"],
    },
    {
      ...formalGate("target-ready", "target", "accepted", v2Profile({ completed: 1 })),
      establishes: ["target_ready"],
    },
    {
      ...formalGate("required-alignment", "alignment", "accepted", acceptance),
      establishes: ["required_steps_aligned", "reference_parity"],
    },
    formalGate("delivery-ready", "delivery", "open"),
  ];
  return {
    schema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
    reproId: "repro:dual-lane",
    title: "Dual-lane reproduction",
    stage: "alignment",
    target: {
      model: "minimum_complete",
      requiredSteps: 100,
      referenceStrategies: ["pp", "ep"],
      validationTopology: acceptance.validationTopology!,
      acceptanceProfile: acceptance,
    },
    profile: acceptance,
    gates,
    validationMatrix: matrixFor(gates, acceptance),
    exploreFrontier: {
      stage: "alignment",
      profile: v2Profile({ modelScope: "probe", computeScope: "forward", completed: 1 }),
      planRevision: 7,
      observationId: "obs-alignment",
      ownerStepId: "S1",
      stepDefinitionDigest: "digest:alignment",
      evidenceRefs: [evidence("obs-alignment")],
      unresolvedIds: [],
    },
    normativeCursor: {
      planRevision: 7,
      orderedStepIds: ["S1"],
      stepDefinitionDigests: { S1: "digest:alignment" },
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
    numericalFrontier: numericalFrontier(),
    nextAction: {
      id: "align-next",
      summary: "Run the next exact alignment receipt",
      passCriterion: "The owning entrypoint is bitwise exact",
    },
  };
}

function v2Profile(
  overrides: {
    modelScope?: SparkReproProfile["model"];
    computeScope?: SparkReproProfile["compute"];
    completed?: number;
    target?: number;
  } = {},
): SparkReproProfile {
  const modelScope = overrides.modelScope ?? "minimum_complete";
  const computeScope = overrides.computeScope ?? "optimizer";
  const validationTopology: SparkReproTopology = {
    dp: 1,
    tp: 1,
    pp: 2,
    ep: 4,
    etp: 1,
    cp: 1,
    sp: false,
    worldSize: 8,
    strategies: [
      {
        axis: "pp",
        id: "official-pipeline",
        source: "official",
        revision: "r1",
        configDigest: "sha256:pp",
      },
      {
        axis: "ep",
        id: "reference-expert",
        source: "reference",
        revision: "r2",
        configDigest: "sha256:ep",
      },
    ],
  };
  return {
    id: "acceptance-minimum-complete",
    model: modelScope,
    compute: computeScope,
    modelScope,
    computeScope,
    steps: { completed: overrides.completed ?? 100, target: overrides.target ?? 100 },
    topology: structuredClone(validationTopology),
    validationTopology,
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

function matrixFor(
  gates: SparkReproEvidenceGate[],
  acceptance: SparkReproProfile,
  denominatorOverrides: Partial<Record<SparkReproWorkStage, number | null>> = {},
): SparkReproValidationMatrix {
  return {
    denominators: { ...stageDenominators(1), ...denominatorOverrides },
    rows: gates.map((gate) => ({
      id: `entrypoint:${gate.id}`,
      gateId: gate.id,
      stage: gate.stage,
      invocationClass: "owning_entrypoint",
      evidenceClass: "entrypoint",
      verdict: gate.status,
      profile: acceptance,
      repetitions: 2,
      exactScope: "frozen acceptance entrypoint",
      evidenceRefs: [...gate.evidenceRefs],
      artifactRefs: [],
    })),
  };
}

function stageDenominators(value: number): Record<SparkReproWorkStage, number | null> {
  return {
    contract: value,
    reference: value,
    target: value,
    alignment: value,
    delivery: value,
  };
}

function acceptDelivery(gates: SparkReproEvidenceGate[]): SparkReproEvidenceGate[] {
  return gates.map((gate) =>
    gate.stage === "delivery"
      ? { ...gate, status: "accepted", evidenceRefs: [evidence("delivery-ready")] }
      : gate,
  );
}

function activeExperiment(): SparkReproActiveExperiment {
  return {
    id: "exp-rmsnorm",
    status: "running",
    evidenceClass: "probe",
    profile: v2Profile({ modelScope: "probe", computeScope: "forward", completed: 1 }),
    hypothesis: "The fused RMSNorm reduction is the first unequal native boundary",
    onlyVariable: "RMSNorm implementation",
    command: "python experiments/e051/check.py",
    repetitions: 3,
    expectedResult: "The reference decomposition stays exact before the native output",
    falsifier: "The native output is exact or an earlier boundary differs",
    stopCondition: "Three identical receipts establish one binary outcome",
    outputEvidencePaths: ["experiments/e051/receipt.json"],
    evidenceRefs: [],
  };
}

function numericalFrontier(): SparkReproNumericalFrontier {
  return {
    claims: {
      native_module_boundary: "established",
      derived_reference_boundary: "established",
      native_internal_boundary: "not_established",
    },
    lastGood: {
      status: "established",
      location: { step: 0, boundary: "rmsnorm.input", module: "RMSNorm", tensor: "hidden" },
      evidenceRefs: [evidence("last-good")],
    },
    firstBad: {
      status: "established",
      location: { step: 0, boundary: "rmsnorm.output", module: "RMSNorm", tensor: "output" },
      evidenceRefs: [evidence("first-bad")],
    },
    equalityRule: "raw_bits",
    comparedInventory: { quantified: false, reason: "the complete tensor denominator is unknown" },
    exactCoverage: {
      quantified: false,
      tensors: null,
      elements: null,
      steps: null,
      topology: v2Profile().validationTopology!,
    },
    difference: { maxAbsDiff: 0.001, maxUlp: null, signedZeroEqual: true },
    activeBlocker: "native fused-kernel internals are not instrumented",
  };
}

function unresolved(id: string): SparkReproUnresolvedItem {
  return {
    id,
    kind: "adapter",
    owner: "repro-owner",
    impact: "The probe bypasses the native launcher",
    reversible: true,
    rollback: "Remove the adapter and restore the owning entrypoint",
    dischargeCriterion: "A current exact owning-entrypoint receipt passes",
    status: "open",
    completionRequired: true,
    planRevision: 7,
    ownerStepId: "S1",
    stepDefinitionDigest: "digest:S1",
    evidenceRefs: [],
  };
}

function dualLaneState(): SparkReproDualLaneState {
  return {
    acceptanceProfile: v2Profile(),
    exploreFrontier: {
      stage: "reference",
      profile: v2Profile({ modelScope: "probe", computeScope: "forward", completed: 1 }),
      planRevision: 7,
      observationId: "obs-reference",
      ownerStepId: "S1",
      stepDefinitionDigest: "digest:S1",
      evidenceRefs: [evidence("obs-reference")],
      unresolvedIds: [],
    },
    normativeCursor: {
      planRevision: 7,
      orderedStepIds: ["S1", "S2", "S3"],
      stepDefinitionDigests: {
        S1: "digest:S1",
        S2: "digest:S2",
        S3: "digest:S3",
      },
      stepDependencies: { S1: [], S2: ["S1"], S3: ["S2"] },
      currentStepId: "S1",
      retiredStepIds: [],
      candidateBuffer: [],
      retirementLog: [],
    },
    unresolved: [],
  };
}

function candidate(
  id: string,
  stepId: string,
  dependsOn: string[],
  planRevision = 7,
): SparkReproRetirementCandidate {
  return {
    id,
    stepId,
    dependsOn,
    planRevision,
    stepDefinitionDigest: `digest:${stepId}`,
    verdict: "accepted",
    profile: v2Profile(),
    evidenceRefs: [evidence(id)],
    unresolvedIds: [],
  };
}

function profileInvalidCases(): Array<[string, (profile: Record<string, unknown>) => void]> {
  const del = (path: string[]) => (profile: Record<string, unknown>) => {
    let cursor = profile;
    for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
    delete cursor[path.at(-1)!];
  };
  const set = (path: string[], value: unknown) => (profile: Record<string, unknown>) => {
    let cursor = profile;
    for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
    cursor[path.at(-1)!] = value;
  };
  return [
    ["modelScope missing", del(["modelScope"])],
    ["modelScope unknown", set(["modelScope"], "toy")],
    ["computeScope missing", del(["computeScope"])],
    ["computeScope unknown", set(["computeScope"], "inference")],
    ["steps.completed missing", del(["steps", "completed"])],
    ["steps.target missing", del(["steps", "target"])],
    ["topology etp missing", del(["validationTopology", "etp"])],
    ["topology worldSize missing", del(["validationTopology", "worldSize"])],
    ["topology strategies missing", del(["validationTopology", "strategies"])],
    ["strategy axis unknown", set(["validationTopology", "strategies", "0", "axis"], "mp")],
    ["strategy id missing", del(["validationTopology", "strategies", "0", "id"])],
    ["strategy source unknown", set(["validationTopology", "strategies", "0", "source"], "local")],
    ["strategy revision missing", del(["validationTopology", "strategies", "0", "revision"])],
    [
      "strategy configDigest missing",
      del(["validationTopology", "strategies", "0", "configDigest"]),
    ],
    ["runtime missing", del(["runtime"])],
    ["runtime modelRevision missing", del(["runtime", "modelRevision"])],
  ];
}
