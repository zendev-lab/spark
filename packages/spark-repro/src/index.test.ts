import { describe, expect, it } from "vitest";

import type { EvidenceRef, RoleRef, TaskRef } from "@zendev-lab/spark-core";
import {
  advanceReproStage,
  createSparkSessionRepro,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  isStageComplete,
  migrateSparkSessionReproV5,
  migrateSparkSessionReproV6,
  nextReproStagePlanningBlocker,
  nextReproStep,
  normalizeStoredSparkSessionRepro,
  recordReproRequirementProof,
  reproProgressDigest,
  reviseReproPlan,
  settleReproTick,
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
  type SparkReproStepDefinition,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
  type SparkSessionReproV5,
  type SparkSessionReproV6,
} from "./index.ts";

const ref = (id: string) => `evidence:${id}` as EvidenceRef;

describe("spark-repro", () => {
  it("selects the first dependency-ready step in the current stage", () => {
    const base = createSparkSessionRepro("session:test");
    const first = base.plan.steps[0]!;
    const second = base.plan.steps[1]!;
    const repro: SparkSessionRepro = {
      ...base,
      plan: {
        ...base.plan,
        steps: base.plan.steps.map((step) =>
          step.id === first.id
            ? { ...step, status: "blocked" }
            : step.id === second.id
              ? { ...step, dependsOn: [first.id] }
              : step,
        ),
      },
    };

    expect(nextReproStep(repro)?.id).toBe(first.id);
  });

  it("starts with a draft Goal Contract and a typed plan seeded from fixed gates", () => {
    const repro = createSparkSessionRepro("session:test", undefined, {
      objective: "Reproduce target logits",
    });

    expect(repro.version).toBe(7);
    expect(repro.dualLane).toMatchObject({
      schema: "spark.repro.dual-lane-session/v1",
      planRevision: 1,
      explore: { stage: "contract", observationIds: [] },
      normative: { retiredStepIds: [], candidateIds: [] },
      unresolvedIds: [],
      migration: { sourceVersion: 7, legacyProofAuthority: "not_promoted" },
    });
    expect(repro.projectRef).toBeUndefined();
    expect(repro.subgoals).toHaveLength(
      repro.plan.steps.filter((step) => step.stage === "contract").length,
    );
    expect(new Set(repro.subgoals.map((subgoal) => subgoal.stage))).toEqual(new Set(["contract"]));
    expect(repro.subgoals[0]).toMatchObject({
      id: "repro-contract-frozen",
      stage: "contract",
      authority: "safe_local",
      status: "pending",
    });
    expect(repro.goalContract).toMatchObject({
      status: "draft",
      objective: "Reproduce target logits",
    });
    expect(repro.plan.currentRevision).toBe(1);
    expect(repro.plan).toMatchObject({ difficulty: 8 });
    expect(repro.plan).not.toHaveProperty("minimumStepCount");
    expect(repro.plan.steps[0]).toMatchObject({
      id: "repro-contract-frozen",
      stage: "contract",
      authority: "safe_local",
      status: "pending",
    });
    expect(
      repro.plan.steps.find((step) => step.id === "implementation-strategy-approved"),
    ).toMatchObject({ authority: "ask_decision" });
  });

  it("uses an explicit external Repro id without accepting unsafe identifiers", () => {
    const repro = createSparkSessionRepro("session:bench", undefined, {
      reproId: "minimax_m25-20260803-run",
    });
    expect(repro.reproId).toBe("minimax_m25-20260803-run");
    expect(() =>
      createSparkSessionRepro("session:bench", undefined, { reproId: "../another-run" }),
    ).toThrow("reproId must be a non-empty safe identifier");
  });

  it("normalizes the current v7 persisted shape without dropping its dual-lane state", () => {
    const repro = createSparkSessionRepro("session:persisted-v6", undefined, {
      objective: "Read the current persisted shape",
    });

    expect(normalizeStoredSparkSessionRepro(structuredClone(repro))).toEqual(repro);
  });

  it("migrates v5 evidence while invalidating delegation and ambiguous task bindings", () => {
    const completed = completeStep(
      createSparkSessionRepro("session:migrate-v5"),
      "repro-contract-frozen",
    );
    const sharedTaskRef = "task:legacy-shared" as TaskRef;
    const uniqueTaskRef = "task:legacy-unique" as TaskRef;
    const legacy: SparkSessionReproV5 = {
      ...completed,
      version: 5,
      subgoals: completed.subgoals.map((subgoal, index) => {
        const { taskRef: _taskRef, ...definition } = subgoal;
        return {
          ...definition,
          goalId: completed.reproId,
          roleRef: "role:builtin-explorer" as RoleRef,
          taskRefs: index < 2 ? [sharedTaskRef] : index === 2 ? [uniqueTaskRef] : [],
          ...(index === 2
            ? {
                status: "in_progress" as const,
                delegation: {
                  sessionId: "session:legacy",
                  planRevision: subgoal.planRevision,
                  definitionDigest: "legacy",
                  delegatedAt: subgoal.updatedAt,
                },
              }
            : {}),
        };
      }),
    };

    const migrated = migrateSparkSessionReproV5(legacy);
    expect(migrated.version).toBe(7);
    expect(migrated.subgoals[0]?.status).toBe("done");
    expect(migrated.subgoals[0]?.evidenceRefs).toEqual(completed.subgoals[0]?.evidenceRefs);
    expect(migrated.subgoals[0]?.taskRef).toBeUndefined();
    expect(migrated.subgoals[1]?.taskRef).toBeUndefined();
    expect(migrated.subgoals[2]).toMatchObject({
      status: "pending",
      taskRef: uniqueTaskRef,
    });
    expect(migrated.subgoals[2]).not.toHaveProperty("delegation");
    expect(migrated.subgoals[2]).not.toHaveProperty("goalId");
    expect(migrated.subgoals[2]).not.toHaveProperty("roleRef");
    expect(migrated.dualLane.migration).toEqual({
      sourceVersion: 6,
      legacyProofAuthority: "not_promoted",
    });
  });

  it("migrates v6 twice without promoting legacy proof into observations or candidates", () => {
    const current = completeStep(
      createSparkSessionRepro("session:migrate-v6"),
      "repro-contract-frozen",
    );
    const { dualLane: _dualLane, ...withoutDualLane } = current;
    const legacy: SparkSessionReproV6 = { ...withoutDualLane, version: 6 };

    const first = migrateSparkSessionReproV6(legacy);
    const second = normalizeStoredSparkSessionRepro(structuredClone(first));
    expect(second).toEqual(first);
    expect(first.dualLane).toMatchObject({
      planRevision: legacy.plan.currentRevision,
      explore: { observationIds: [] },
      normative: { candidateIds: [] },
      unresolvedIds: [],
      migration: { sourceVersion: 6, legacyProofAuthority: "not_promoted" },
    });
    expect(first.dualLane.normative.retiredStepIds).toEqual([]);
  });

  it("reopens a completed v6 snapshot until v7 Normative retirement is proven", () => {
    const current = createSparkSessionRepro("session:migrate-complete-v6");
    const { dualLane: _dualLane, ...withoutDualLane } = current;
    const legacy: SparkSessionReproV6 = {
      ...withoutDualLane,
      version: 6,
      status: "complete",
      completedAt: "2026-08-01T00:00:00.000Z",
      stopGuard: { ...withoutDualLane.stopGuard, decision: "complete" },
    };

    const migrated = migrateSparkSessionReproV6(legacy);
    expect(migrated.status).toBe("active");
    expect(migrated.completedAt).toBeUndefined();
    expect(migrated.stopGuard.decision).toBe("continue");
    expect(migrated.dualLane.normative.retiredStepIds).toEqual([]);
    expect(migrated.dualLane.migration).toEqual({
      sourceVersion: 6,
      legacyProofAuthority: "not_promoted",
    });
  });

  it("keeps v6 proof outside Normative retirement after a later plan revision", () => {
    const completed = completeStep(
      createSparkSessionRepro("session:migrate-v6-revise"),
      "repro-contract-frozen",
    );
    const { dualLane: _dualLane, ...withoutDualLane } = completed;
    const legacy: SparkSessionReproV6 = { ...withoutDualLane, version: 6 };
    let migrated = migrateSparkSessionReproV6(legacy);
    migrated = {
      ...migrated,
      dualLane: {
        ...migrated.dualLane,
        explore: { ...migrated.dualLane.explore, observationIds: ["legacy-observation"] },
        unresolvedIds: ["legacy-unresolved"],
      },
    };

    const revised = reviseReproPlan(migrated, {
      reason: "Change only the difficulty after migration",
      difficulty: 9,
    });
    expect(revised.dualLane).toMatchObject({
      planRevision: 2,
      explore: { observationIds: ["legacy-observation"] },
      normative: {
        currentStepId: revised.plan.steps[0]?.id,
        retiredStepIds: [],
        candidateIds: [],
      },
      unresolvedIds: ["legacy-unresolved"],
      migration: { sourceVersion: 6, legacyProofAuthority: "not_promoted" },
    });
  });

  it("buffers v7 StepVerifier completions and retires them only as an ordered prefix", () => {
    let repro = createSparkSessionRepro("session:ordered-retirement");
    const [s1, s2, s3, s4] = repro.plan.steps;
    repro = completeStep(repro, s3!.id);
    expect(repro.dualLane.normative).toMatchObject({
      currentStepId: s1!.id,
      retiredStepIds: [],
      candidateIds: [s3!.id],
    });
    repro = completeStep(repro, s2!.id);
    expect(repro.dualLane.normative).toMatchObject({
      currentStepId: s1!.id,
      retiredStepIds: [],
      candidateIds: [s2!.id, s3!.id],
    });
    repro = completeStep(repro, s1!.id);
    expect(repro.dualLane.normative).toMatchObject({
      currentStepId: s4!.id,
      retiredStepIds: [s1!.id, s2!.id, s3!.id],
      candidateIds: [],
    });
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

  it("appends a stage subgoal without reopening unchanged completed proof", () => {
    let repro = completeStep(createSparkSessionRepro("session:test"), "repro-contract-frozen");
    const completedBefore = structuredClone(
      repro.subgoals.find((subgoal) => subgoal.id === "repro-contract-frozen")!,
    );

    repro = reviseReproPlan(repro, {
      reason: "Plan scaffold build work",
      subgoals: [
        {
          id: "scaffold-build-layout",
          stage: "reference",
          goal: "Build the target project layout",
          doneWhen: ["The project tree matches the recorded layout"],
          evidenceRequired: ["Project tree command output"],
          authority: "safe_local",
        },
      ],
    });

    expect(repro.plan.currentRevision).toBe(2);
    expect(repro.dualLane).toMatchObject({
      planRevision: 2,
      explore: { observationIds: [] },
      normative: {
        currentStepId: "repro-contract-frozen",
        retiredStepIds: [],
        candidateIds: [],
      },
      unresolvedIds: [],
    });
    expect(repro.plan.revisions).toHaveLength(2);
    expect(repro.subgoals.find((subgoal) => subgoal.id === "repro-contract-frozen")).toEqual(
      completedBefore,
    );
    expect(repro.subgoals.find((subgoal) => subgoal.id === "scaffold-build-layout")).toMatchObject({
      stage: "reference",
      status: "pending",
      planRevision: 2,
    });
  });

  it("reopens only the subgoal whose definition digest changed", () => {
    let repro = completeStep(createSparkSessionRepro("session:test"), "repro-contract-frozen");
    repro = completeStep(repro, "competitor-baseline-availability-researched");
    const before = structuredClone(repro.subgoals);
    const baseline = repro.plan.steps.find(
      (step) => step.id === "competitor-baseline-availability-researched",
    )!;

    repro = reviseReproPlan(repro, {
      reason: "Require an executable baseline command",
      subgoals: [
        {
          ...stepDefinition(baseline),
          doneWhen: ["A baseline command exits with code 0 and records output"],
        },
      ],
    });

    const changedStatusIds = repro.subgoals
      .filter(
        (subgoal) => before.find((prior) => prior.id === subgoal.id)?.status !== subgoal.status,
      )
      .map((subgoal) => subgoal.id);
    expect(changedStatusIds).toEqual(["competitor-baseline-availability-researched"]);
    const reopened = repro.subgoals.find(
      (subgoal) => subgoal.id === "competitor-baseline-availability-researched",
    );
    expect(reopened).toMatchObject({ status: "pending", evidenceRefs: [], planRevision: 2 });
    expect(reopened?.verification).toBeUndefined();
    expect(repro.subgoals.find((subgoal) => subgoal.id === "repro-contract-frozen")).toEqual(
      before.find((subgoal) => subgoal.id === "repro-contract-frozen"),
    );
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
        reason: "Depend on future-stage work",
        steps: steps.map((step) =>
          step.id === "repro-contract-frozen" ? { ...step, dependsOn: ["pr-submitted"] } : step,
        ),
      }),
    ).toThrow(/cannot depend on later-stage step/u);
  });

  it("includes bound task status changes in the repro progress digest", () => {
    const taskRef = "task:digest-safe-local" as TaskRef;
    const initial = createSparkSessionRepro("session:digest");
    const repro: SparkSessionRepro = {
      ...initial,
      subgoals: initial.subgoals.map((subgoal, index) =>
        index === 0 && subgoal.authority === "safe_local" ? { ...subgoal, taskRef } : subgoal,
      ),
    };

    const pending = reproProgressDigest(repro, {
      taskStatusByRef: { [taskRef]: "pending" },
    });
    const running = reproProgressDigest(repro, {
      taskStatusByRef: { [taskRef]: "running" },
    });

    expect(pending).not.toBe(running);
  });

  it("selects repro settle cadence from fresh orchestration snapshots", () => {
    const active = settleReproTick(createSparkSessionRepro("session:active"), {
      activeChildRunCount: 1,
    });
    expect(active.scheduleDelayMs).toBe(10_000);

    const awaitingAsk = settleReproTick(createSparkSessionRepro("session:awaiting-ask"), {
      awaitingAsk: true,
      activeChildRunCount: 0,
      dispatchableFrontierCount: 0,
    });
    expect(awaitingAsk.scheduleDelayMs).toBeUndefined();
    expect(awaitingAsk.dormantReason).toBe("awaiting_ask");

    const idle = settleReproTick(createSparkSessionRepro("session:idle"));
    expect(idle.scheduleDelayMs).toBe(30_000);

    const dispatchable = settleReproTick(createSparkSessionRepro("session:dispatchable"), {
      activeChildRunCount: 0,
      dispatchableFrontierCount: 1,
    });
    expect(dispatchable.scheduleDelayMs).toBe(30_000);

    const complete = createSparkSessionRepro("session:complete");
    const completed = { ...complete, status: "complete" as const };
    const completedResult = settleReproTick(completed);
    expect(completedResult.decision).toBe("complete");
    expect(completedResult.scheduleDelayMs).toBeUndefined();

    let stagnant = createSparkSessionRepro("session:recover-ask");
    stagnant = settleReproTick(stagnant).repro;
    stagnant = settleReproTick(stagnant).repro;
    const recoverAsk = settleReproTick(stagnant);
    expect(recoverAsk.decision).toBe("ask");
    expect(recoverAsk.scheduleDelayMs).toBeUndefined();
  });

  it("requires a current passing StepVerifier result and asks after three unchanged settlements", () => {
    let repro = createSparkSessionRepro("session:test");
    const step = repro.plan.steps.find((candidate) => candidate.id === "repro-contract-frozen")!;
    const evidenceRefs = [ref("contract")];
    expect(() => updateReproStep(repro, step.id, { status: "done", evidenceRefs })).toThrow(
      /requires a passing StepVerifier/u,
    );

    const staleVerifier = verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: repro.plan.currentRevision + 1,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "evidence",
      evidenceRefs,
      verifiedDoneWhen: step.doneWhen,
    });
    expect(staleVerifier.verdict).toBe("Repair");
    expect(() =>
      updateReproStep(repro, step.id, { status: "done", evidenceRefs, verifier: staleVerifier }),
    ).toThrow(/requires a passing StepVerifier/u);

    const verifier = verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: repro.plan.currentRevision,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "evidence",
      evidenceRefs,
      verifiedDoneWhen: step.doneWhen,
    });
    expect(verifier.verdict).toBe("Pass");
    repro = updateReproStep(repro, step.id, { status: "done", evidenceRefs, verifier })!;
    expect(repro.plan.steps.find((candidate) => candidate.id === step.id)).toMatchObject({
      status: "done",
      verification: { verdict: "Pass", planRevision: 1 },
    });
    expect(repro.subgoals.find((candidate) => candidate.id === step.id)).toMatchObject({
      status: "done",
      evidenceRefs,
      verification: { verdict: "Pass", planRevision: 1 },
    });

    expect(settleReproTick(repro).decision).toBe("continue");
    repro = settleReproTick(repro).repro;
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

  it("requires an explicit approve answer for approval Steps", () => {
    let repro = createSparkSessionRepro("session:test");
    const approvalStepId = "repro-contract-frozen";
    repro = reviseReproPlan(repro, {
      reason: "Make contract freeze an explicit approval",
      steps: repro.plan.steps.map((step) =>
        step.id === approvalStepId
          ? { ...stepDefinition(step), authority: "ask_approval" as const }
          : stepDefinition(step),
      ),
    });
    const step = repro.plan.steps.find((candidate) => candidate.id === approvalStepId)!;
    expect(repro.subgoals.find((candidate) => candidate.id === approvalStepId)).toMatchObject({
      authority: "ask_approval",
      status: "pending",
      planRevision: 2,
    });
    const evidenceRefs = [ref("approval")];
    const rejected = verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: repro.plan.currentRevision,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "approval",
      evidenceRefs,
      verifiedDoneWhen: step.doneWhen,
      askRequestHash: "request-hash",
      acceptedAnswerHash: "answer-hash",
      selectedValues: ["reject"],
      approvalResult: "approved",
    });
    expect(rejected.verdict).toBe("Repair");

    const approved = verifyReproStepPass(repro, step.id, {
      verdict: "Pass",
      planRevision: repro.plan.currentRevision,
      definitionDigest: stepDefinitionDigest(step),
      proofKind: "approval",
      evidenceRefs,
      verifiedDoneWhen: step.doneWhen,
      askRequestHash: "request-hash",
      acceptedAnswerHash: "answer-hash",
      selectedValues: ["approve"],
      approvalResult: "approved",
    });
    repro = updateReproStep(repro, step.id, { status: "done", evidenceRefs, verifier: approved })!;
    expect(repro.plan.steps.find((candidate) => candidate.id === step.id)?.status).toBe("done");
  });

  it("blocks stage advance until the target stage has planned subgoals", () => {
    let repro = satisfySetupRequirements(createSparkSessionRepro("session:test"));
    repro = {
      ...repro,
      subgoals: repro.subgoals.map((subgoal) => ({ ...subgoal, status: "done" as const })),
    };

    expect(isStageComplete(repro)).toBe(true);
    expect(advanceReproStage(repro)).toBeUndefined();
    expect(nextReproStagePlanningBlocker(repro)).toBe(
      "Stage reference has no planned subgoals. Plan concrete subgoals and task experiments before advancing.",
    );

    repro = reviseReproPlan(repro, {
      reason: "Plan scaffold stage",
      subgoals: [
        {
          id: "scaffold-build-layout",
          stage: "reference",
          goal: "Build the target project layout",
          doneWhen: ["The project tree command matches the recorded layout"],
          evidenceRequired: ["Project tree command output"],
          authority: "safe_local",
        },
      ],
    });
    expect(advanceReproStage(repro)).toMatchObject({
      currentStageIndex: 1,
      currentPhase: "implement",
    });
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

function completeStep(repro: SparkSessionRepro, stepId: string): SparkSessionRepro {
  const step = repro.plan.steps.find((candidate) => candidate.id === stepId)!;
  const subgoal = repro.subgoals.find((candidate) => candidate.id === stepId)!;
  const evidenceRefs = [ref(`proof-${stepId}`)];
  const proofKind =
    step.authority === "ask_approval"
      ? ("approval" as const)
      : step.authority === "ask_decision"
        ? ("decision" as const)
        : ("evidence" as const);
  const verifier = verifyReproStepPass(repro, stepId, {
    verdict: "Pass",
    planRevision: subgoal.planRevision,
    definitionDigest: stepDefinitionDigest(step),
    proofKind,
    evidenceRefs,
    verifiedDoneWhen: step.doneWhen,
    ...(proofKind === "evidence"
      ? {}
      : {
          askRequestHash: "request-hash",
          acceptedAnswerHash: "answer-hash",
          selectedValues: proofKind === "approval" ? ["approve"] : ["selected"],
        }),
    ...(proofKind === "approval" ? { approvalResult: "approved" as const } : {}),
  });
  expect(verifier.verdict).toBe("Pass");
  return updateReproStep(repro, stepId, { status: "done", evidenceRefs, verifier })!;
}

function satisfySetupRequirements(repro: SparkSessionRepro): SparkSessionRepro {
  let updated = repro;
  for (const requirement of repro.stages[0]!.acceptance) {
    const proof: SparkReproRequirementProof =
      requirement.kind === "evidence"
        ? { kind: "evidence", evidenceRefs: [ref(requirement.id)] }
        : requirement.kind === "decision"
          ? {
              kind: "decision",
              decisionRef: ref(requirement.id),
              selectedValue: "selected",
            }
          : {
              kind: "validation",
              command: `run ${requirement.id}`,
              resultRef: ref(requirement.id),
              passed: true,
            };
    updated = recordReproRequirementProof(updated, requirement.id, proof)!;
  }
  return updated;
}

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
