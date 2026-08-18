import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";

import type { EvidenceRef } from "@zendev-lab/spark-core";
import {
  DEFAULT_REPRO_STAGES,
  advanceReproStage,
  createSparkSessionRepro,
  currentPhaseAcceptance,
  currentReproStage,
  evaluateStageGate,
  isPhaseComplete,
  isReproRequirementSatisfied,
  isStageComplete,
  passStageGate,
  readSessionRepro,
  recordReproRequirementProof,
  reviseReproPlan,
  satisfyAcceptanceCondition,
  sessionReproStorePath,
  sparkReproNormativeOrderedStepIds,
  stepDefinitionDigest,
  updateReproStep,
  verifyReproStepPass,
  type SparkReproRequirementProof,
  type SparkSessionRepro,
  type SparkSessionReproV3,
  type SparkSessionReproV4,
  type SparkSessionReproV6,
} from "../extension/spark-session-repro.ts";

const evidenceRef = (id: string) => `evidence:${id}` as EvidenceRef;

interface LegacyReproStageFixture {
  name: string;
  title: string;
  phases: string[];
  acceptance: Array<{
    description: string;
    phase: string;
    satisfied: boolean;
    evidenceRef?: string;
  }>;
  gate?: { id: string; description: string; passed: boolean };
}

describe("SparkSessionRepro evidence-backed state machine", () => {
  function makeRepro(): SparkSessionRepro {
    return createSparkSessionRepro("test-session");
  }

  it("starts a v9 research-first setup with typed Goal Contract, plan, and subgoals", () => {
    const repro = makeRepro();
    const setup = currentReproStage(repro);

    assert.equal(repro.version, 9);
    assert.equal(repro.projectRef, undefined);
    assert.equal(
      repro.subgoals.length,
      repro.plan.steps.filter((step) => step.stage === "contract").length,
    );
    assert.deepEqual([...new Set(repro.subgoals.map((subgoal) => subgoal.stage))], ["contract"]);
    assert.equal(repro.subgoals[0]?.id, "repro-contract-frozen");
    assert.equal(repro.status, "active");
    assert.equal(repro.goalContract.status, "draft");
    assert.equal(repro.plan.currentRevision, 1);
    assert.equal(repro.currentStageIndex, 0);
    assert.equal(repro.currentPhase, "plan");
    assert.deepEqual(
      repro.stages.map((stage) => stage.name),
      ["contract", "reference", "target", "alignment", "delivery"],
    );
    assert.deepEqual(
      setup.acceptance.map(({ id, kind }) => [id, kind]),
      [
        ["repro-contract-frozen", "evidence"],
        ["competitor-baseline-availability-researched", "evidence"],
        ["baseline-construction-strategy-approved", "decision"],
        ["implementation-landscape-researched", "evidence"],
        ["alignment-paths-researched", "evidence"],
        ["implementation-strategy-approved", "decision"],
        ["alignment-strategy-approved", "decision"],
        ["baseline-probe-passed", "validation"],
      ],
    );
    assert.equal(currentPhaseAcceptance(repro).length, 8);
    assert.equal(
      setup.acceptance.every((item) => !isReproRequirementSatisfied(item)),
      true,
    );
  });

  it("preserves an optional user-supplied reproduction objective", () => {
    const repro = createSparkSessionRepro("test-session", undefined, {
      objective: "进行正经的复现对齐工作",
    });
    assert.equal(repro.objective, "进行正经的复现对齐工作");
    assert.equal(repro.goalContract.objective, "进行正经的复现对齐工作");
  });

  it("derives readiness from evidence, user decisions, and validation proof", () => {
    let repro = makeRepro();
    repro = record(repro, "repro-contract-frozen", {
      kind: "evidence",
      evidenceRefs: [evidenceRef("contract")],
    });
    repro = record(repro, "competitor-baseline-availability-researched", {
      kind: "evidence",
      evidenceRefs: [evidenceRef("baseline-availability")],
    });
    repro = record(repro, "baseline-construction-strategy-approved", {
      kind: "decision",
      decisionRef: evidenceRef("baseline-construction-ask"),
      selectedValue: "reuse-existing",
    });
    repro = record(repro, "implementation-landscape-researched", {
      kind: "evidence",
      evidenceRefs: [evidenceRef("reuse-research")],
    });
    repro = record(repro, "alignment-paths-researched", {
      kind: "evidence",
      evidenceRefs: [evidenceRef("alignment-research")],
    });
    repro = record(repro, "implementation-strategy-approved", {
      kind: "decision",
      decisionRef: evidenceRef("implementation-ask"),
      selectedValue: "reuse",
    });
    repro = record(repro, "alignment-strategy-approved", {
      kind: "decision",
      decisionRef: evidenceRef("alignment-ask"),
      selectedValue: "real-module",
    });
    assert.equal(isPhaseComplete(repro), false);

    repro = record(repro, "baseline-probe-passed", {
      kind: "validation",
      command: "pnpm test baseline",
      resultRef: evidenceRef("baseline-output"),
      passed: true,
    });

    for (const step of repro.plan.steps.filter((candidate) => candidate.stage === "contract")) {
      const evidenceRefs = [evidenceRef(`step-${step.id}`)];
      const verifier = verifyReproStepPass(repro, step.id, {
        verdict: "Pass",
        planRevision: repro.plan.currentRevision,
        definitionDigest: stepDefinitionDigest(step),
        proofKind: step.authority === "ask_decision" ? "decision" : "evidence",
        evidenceRefs,
        verifiedDoneWhen: [...step.doneWhen],
        ...(step.authority === "ask_decision"
          ? {
              askRequestHash: `request-${step.id}`,
              acceptedAnswerHash: `answer-${step.id}`,
              selectedValues: ["accepted"],
            }
          : {}),
      });
      assert.equal(verifier.verdict, "Pass");
      repro = updateReproStep(repro, step.id, {
        status: "done",
        evidenceRefs,
        verifier,
      })!;
    }
    assert.equal(isPhaseComplete(repro), true);
    assert.equal(isStageComplete(repro), true);
    assert.equal(advanceReproStage(repro), undefined);
    repro = reviseReproPlan(repro, {
      reason: "Plan scaffold work before advancing",
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
    const scaffold = advanceReproStage(repro);
    assert.equal(scaffold?.currentStageIndex, 1);
    assert.equal(scaffold?.currentPhase, "implement");
  });

  it("rejects proof kinds that do not match the stable requirement", () => {
    const repro = makeRepro();
    assert.throws(
      () =>
        recordReproRequirementProof(repro, "implementation-strategy-approved", {
          kind: "evidence",
          evidenceRefs: [evidenceRef("research")],
        }),
      /expects decision proof, received evidence/u,
    );
  });

  it("keeps the legacy satisfy helper fail-closed", () => {
    const repro = makeRepro();
    assert.equal(satisfyAcceptanceCondition(repro, "repro-contract-frozen"), undefined);
    assert.equal(
      satisfyAcceptanceCondition(
        repro,
        "implementation-strategy-approved",
        evidenceRef("decision"),
      ),
      undefined,
    );
    const updated = satisfyAcceptanceCondition(
      repro,
      "repro-contract-frozen",
      evidenceRef("contract"),
    );
    assert.equal(updated?.stages[0]?.acceptance[0]?.kind, "evidence");
    assert.equal(isReproRequirementSatisfied(updated!.stages[0]!.acceptance[0]!), true);
  });

  it("derives gates from proof and cannot force-pass an incomplete stage", () => {
    const repro = { ...makeRepro(), currentStageIndex: 2, currentPhase: "implement" as const };
    const blocked = evaluateStageGate(repro);
    assert.equal(blocked.passed, false);
    assert.deepEqual(blocked.blockers, [
      "bitwise-pass-20 requires a command, result evidence ref, and passing validation result",
      "bitwise-pass-100 requires a command, result evidence ref, and passing validation result",
    ]);
    assert.equal(passStageGate(repro), undefined);

    let proved = record(repro, "bitwise-pass-20", validation("20", true));
    proved = record(proved, "bitwise-pass-100", validation("100", true));
    const passed = evaluateStageGate(proved);
    assert.equal(passed.passed, true);
    assert.equal(passed.repro.stages[2]?.gate?.evaluation?.passed, true);
    assert.deepEqual(passed.repro.stages[2]?.gate?.evaluation?.evidenceRefs, [
      evidenceRef("result-20"),
      evidenceRef("result-100"),
    ]);
  });

  it("migrates legacy state without trusting artifact-backed facts or agent-authored decisions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-phase-migration-"));
    try {
      const current = toV3(makeRepro());
      const legacy = {
        ...current,
        version: 1,
        currentPhase: "research",
        stages: current.stages.map((stage): LegacyReproStageFixture => ({
          name: stage.name,
          title: stage.title,
          phases: stage.name === "contract" ? ["research", "plan"] : stage.phases,
          acceptance: stage.acceptance.map((requirement) => ({
            description: requirement.description,
            phase: requirement.phase,
            satisfied: false,
          })),
          ...(stage.gate
            ? {
                gate: {
                  id: stage.gate.id,
                  description: stage.gate.description,
                  passed: true,
                },
              }
            : {}),
        })),
      };
      const negativeValues = JSON.parse(
        await readFile(
          join(
            import.meta.dirname,
            "../../../../test/fixtures/evidence-surface/negative-values.json",
          ),
          "utf8",
        ),
      ) as { wrongNamespaceRef: string };
      legacy.stages[0]!.acceptance = [
        {
          description: "Problem statement documented",
          phase: "research",
          satisfied: true,
          evidenceRef: negativeValues.wrongNamespaceRef,
        },
        {
          description: "Reproduction strategy planned",
          phase: "plan",
          satisfied: true,
        },
      ];
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 1, repro: legacy })}\n`, "utf8");

      const migrated = await readSessionRepro(dir);
      assert.equal(migrated?.version, 9);
      assert.equal(migrated?.currentPhase, "plan");
      assert.deepEqual(migrated?.stages[0]?.phases, ["plan"]);
      assert.deepEqual(migrated?.stages[0]?.acceptance[0], {
        id: "repro-contract-frozen",
        kind: "evidence",
        description: "Reproduction claim and acceptance contract frozen",
        phase: "plan",
        evidenceRefs: [],
      });
      assert.equal(
        isReproRequirementSatisfied(
          migrated!.stages[0]!.acceptance.find(
            (requirement) => requirement.id === "implementation-strategy-approved",
          )!,
        ),
        false,
        "a legacy strategy boolean is not a recorded user decision",
      );
      assert.equal(migrated?.stages[2]?.gate?.evaluation, undefined);

      const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assert.equal(persisted.version, 8);
      assert.doesNotMatch(JSON.stringify(persisted), /"research"/u);
      assert.doesNotMatch(JSON.stringify(persisted), /"satisfied"/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes artifact-backed proof and stale gates from stored v3 snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v3-evidence-hard-cut-"));
    try {
      const repro = toV3(makeRepro());
      const setup = repro.stages[0]!;
      setup.acceptance[0] = {
        ...setup.acceptance[0]!,
        kind: "evidence",
        evidenceRefs: ["artifact:legacy-contract" as unknown as EvidenceRef],
      };
      const reproduce = repro.stages[2]!;
      reproduce.gate!.evaluation = {
        passed: true,
        blockers: [],
        evidenceRefs: ["artifact:legacy-validation" as unknown as EvidenceRef],
        evaluatedAt: new Date().toISOString(),
      };
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 3, repro })}\n`, "utf8");

      const sanitized = await readSessionRepro(dir);
      assert.equal(sanitized?.version, 9);
      assert.equal(sanitized?.goalContract.status, "draft");
      assert.equal(
        sanitized?.plan.steps.find((step) => step.id === "repro-contract-frozen")?.status,
        "pending",
      );
      assert.deepEqual(sanitized?.stages[0]?.acceptance[0], {
        id: "repro-contract-frozen",
        kind: "evidence",
        description: "Reproduction claim and acceptance contract frozen",
        phase: "plan",
        evidenceRefs: [],
      });
      assert.equal(sanitized?.stages[2]?.gate?.evaluation, undefined);
      assert.doesNotMatch(await readFile(path, "utf8"), /artifact:legacy/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reopens v4 contracts and steps whose stored evidence refs are invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v4-evidence-sanitize-"));
    try {
      const repro = toV4(makeRepro());
      const invalidRef = "artifact:legacy-contract" as unknown as EvidenceRef;
      repro.stages[0]!.acceptance[0] = {
        ...repro.stages[0]!.acceptance[0]!,
        kind: "evidence",
        evidenceRefs: [invalidRef],
      };
      repro.goalContract = {
        ...repro.goalContract,
        status: "frozen",
        evidenceRefs: [invalidRef],
        frozenAt: new Date().toISOString(),
      };
      repro.plan.steps[0] = {
        ...repro.plan.steps[0]!,
        status: "done",
        evidenceRefs: [invalidRef],
      };
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 4, repro })}\n`, "utf8");

      const sanitized = await readSessionRepro(dir);
      assert.equal(sanitized?.goalContract.status, "draft");
      assert.deepEqual(sanitized?.goalContract.evidenceRefs, []);
      assert.equal(sanitized?.goalContract.frozenAt, undefined);
      assert.deepEqual(
        sanitized?.plan.steps.find((step) => step.id === "repro-contract-frozen"),
        {
          ...repro.plan.steps[0],
          status: "pending",
          evidenceRefs: [],
        },
      );
      assert.doesNotMatch(await readFile(path, "utf8"), /artifact:legacy/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const version of [1, 2] as const) {
    it(`reopens incomplete legacy v${version} snapshots that claimed completion`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `spark-repro-v${version}-fail-closed-`));
      try {
        const current = toV3(makeRepro());
        const completedAt = "2026-01-02T03:04:05.000Z";
        const legacy = {
          ...current,
          version,
          status: "complete",
          currentStageIndex: current.stages.length - 1,
          currentPhase: "implement",
          completedAt,
          stages: current.stages.map((stage) => ({
            name: stage.name,
            title: stage.title,
            phases: stage.phases,
            acceptance: stage.acceptance.map((requirement) => ({
              description: requirement.description,
              phase: requirement.phase,
              satisfied: true,
              evidenceRef: `artifact:legacy-${requirement.id}`,
            })),
            ...(stage.gate
              ? {
                  gate: {
                    id: stage.gate.id,
                    description: stage.gate.description,
                    passed: true,
                    passedAt: completedAt,
                  },
                }
              : {}),
          })),
        };
        const path = sessionReproStorePath(dir);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify({ version, repro: legacy })}\n`, "utf8");

        const migrated = await readSessionRepro(dir);
        assert.equal(migrated?.version, 9);
        assert.equal(migrated?.status, "active");
        assert.equal(migrated?.completedAt, undefined);
        assert.equal(migrated?.currentStageIndex, 0);
        assert.equal(migrated?.currentPhase, "plan");
        assert.equal(
          isReproRequirementSatisfied(
            migrated!.stages[0]!.acceptance.find(
              (requirement) => requirement.id === "baseline-construction-strategy-approved",
            )!,
          ),
          false,
          "legacy satisfied booleans and evidence refs cannot forge a v6 user decision",
        );
        assert.equal(
          isReproRequirementSatisfied(
            migrated!.stages[0]!.acceptance.find(
              (requirement) => requirement.id === "baseline-probe-passed",
            )!,
          ),
          false,
          "a legacy evidence ref cannot certify a v6 validation command and pass result",
        );
        assert.equal(migrated?.stages[2]?.gate?.evaluation, undefined);

        const persisted = JSON.parse(await readFile(path, "utf8")) as {
          version: number;
          repro?: Record<string, unknown>;
        };
        assert.equal(persisted.version, 8);
        assert.equal(persisted.repro?.status, "active");
        assert.equal(Object.hasOwn(persisted.repro ?? {}, "completedAt"), false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("migrates a v6 snapshot to v9 idempotently without promoting proof authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v6-three-lane-migration-"));
    try {
      const current = makeRepro();
      const { threeLane: _threeLane, ...withoutThreeLane } = current;
      const legacy: SparkSessionReproV6 = { ...withoutThreeLane, version: 6 };
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 6, repro: legacy })}\n`, "utf8");

      const first = await readSessionRepro(dir);
      const second = await readSessionRepro(dir);
      assert.deepEqual(second, first);
      assert.equal(first?.version, 9);
      assert.deepEqual(first?.threeLane, {
        schema: "spark.repro.three-lane-session/v2",
        planRevision: legacy.plan.currentRevision,
        implementation: { stage: "contract", observationIds: [], workItemIds: [] },
        exactness: { workItemIds: [], findingIds: [], mismatchIds: [] },
        formalize: {
          orderedStepIds: legacy.plan.steps.map((step) => step.id),
          currentStepId: legacy.plan.steps[0]?.id,
          retiredStepIds: [],
          candidateIds: [],
          workItemIds: [],
        },
        workItems: [],
        bindings: [],
        compatibilityBindings: [],
        routes: [],
        resultReceipts: [],
        findings: [],
        mismatches: [],
        handoffs: [],
        resolutions: [],
        unresolvedIds: [],
        migration: { sourceVersion: 6, legacyProofAuthority: "not_promoted" },
      });
      const persisted = JSON.parse(await readFile(path, "utf8")) as { version: number };
      assert.equal(persisted.version, 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes legacy plan-array Formalize order into stage order without promoting proof", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v8-order-normalization-"));
    try {
      const repro = reviseReproPlan(makeRepro(), {
        reason: "Append a late raw-order Contract step",
        subgoals: [
          {
            id: "late-raw-contract-step",
            stage: "contract",
            goal: "Normalize legacy raw ordering",
            doneWhen: ["The stored order is normalized"],
            evidenceRequired: ["Normalized snapshot"],
            authority: "safe_local",
          },
        ],
      });
      const canonicalOrderedStepIds = sparkReproNormativeOrderedStepIds(repro.plan);
      const legacyOrderedStepIds = repro.plan.steps.map((step) => step.id);
      assert.notDeepEqual(legacyOrderedStepIds, canonicalOrderedStepIds);
      assert.deepEqual(repro.threeLane.formalize.orderedStepIds, canonicalOrderedStepIds);

      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 8, repro })}\n`, "utf8");
      const canonical = await readSessionRepro(dir);
      assert.deepEqual(canonical?.threeLane.formalize.orderedStepIds, canonicalOrderedStepIds);

      const legacy = structuredClone(repro);
      legacy.threeLane.formalize = {
        orderedStepIds: legacyOrderedStepIds,
        currentStepId: legacyOrderedStepIds[0],
        retiredStepIds: [],
        candidateIds: [],
        workItemIds: [],
      };
      await writeFile(path, `${JSON.stringify({ version: 8, repro: legacy })}\n`, "utf8");
      const normalized = await readSessionRepro(dir);
      assert.deepEqual(normalized?.threeLane.formalize.orderedStepIds, canonicalOrderedStepIds);
      assert.equal(normalized?.threeLane.formalize.currentStepId, canonicalOrderedStepIds[0]);
      assert.deepEqual(normalized?.threeLane.formalize.retiredStepIds, []);
      assert.deepEqual(normalized?.threeLane.formalize.candidateIds, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves an invalid v8 snapshot instead of overwriting it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-invalid-v8-preserved-"));
    try {
      const invalid = makeRepro();
      invalid.threeLane.planRevision += 1;
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      const serialized = `${JSON.stringify({ version: 8, repro: invalid })}\n`;
      await writeFile(path, serialized, "utf8");

      await assert.rejects(
        readSessionRepro(dir),
        /Stored Repro snapshot is invalid and was preserved/u,
      );
      assert.equal(await readFile(path, "utf8"), serialized);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates valid v4 requirement proofs, gate evaluations, and frozen contract losslessly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-repro-v4-proof-preservation-"));
    try {
      let repro = makeRepro();
      repro = record(repro, "repro-contract-frozen", {
        kind: "evidence",
        evidenceRefs: [evidenceRef("contract")],
      });
      repro = record(repro, "competitor-baseline-availability-researched", {
        kind: "evidence",
        evidenceRefs: [evidenceRef("baseline")],
      });
      repro = record(repro, "baseline-construction-strategy-approved", {
        kind: "decision",
        decisionRef: evidenceRef("baseline-decision"),
        selectedValue: "reuse-existing",
        rationale: "The baseline command and outputs are available.",
      });
      repro = {
        ...repro,
        currentStageIndex: 2,
        currentPhase: "implement",
      };
      repro = record(repro, "bitwise-pass-20", validation("bitwise-pass-20", true));
      repro = evaluateStageGate(repro).repro;
      const v4 = toV4(repro);
      const path = sessionReproStorePath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 4, repro: v4 })}\n`, "utf8");

      const migrated = await readSessionRepro(dir);
      assert.equal(migrated?.version, 9);
      assert.equal(migrated?.projectRef, undefined);
      assert.deepEqual(migrated?.stages, v4.stages);
      assert.deepEqual(migrated?.goalContract, v4.goalContract);
      assert.deepEqual(migrated?.plan.steps, v4.plan.steps);
      assert.deepEqual(
        migrated?.plan.revisions,
        v4.plan.revisions.map(({ minimumStepCount: _minimumStepCount, ...revision }) => revision),
      );
      assert.equal(migrated?.subgoals.length, v4.plan.steps.length);
      assert.equal(migrated?.goalContract.frozenAt, v4.goalContract.frozenAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the five-stage gate topology", () => {
    assert.equal(DEFAULT_REPRO_STAGES.length, 5);
    assert.equal(DEFAULT_REPRO_STAGES[0]?.gate, undefined);
    assert.equal(DEFAULT_REPRO_STAGES[2]?.gate?.id, "gate-A");
    assert.equal(DEFAULT_REPRO_STAGES[3]?.gate?.id, "gate-B");
    assert.equal(DEFAULT_REPRO_STAGES[4]?.gate?.id, "gate-C");
  });
});

function record(
  repro: SparkSessionRepro,
  requirementId: string,
  proof: SparkReproRequirementProof,
): SparkSessionRepro {
  const updated = recordReproRequirementProof(repro, requirementId, proof);
  assert.ok(updated, `requirement should exist: ${requirementId}`);
  return updated;
}

function validation(id: string, passed: boolean): SparkReproRequirementProof {
  return {
    kind: "validation",
    command: `run ${id}`,
    resultRef: evidenceRef(`result-${id}`),
    passed,
  };
}

function toV4(repro: SparkSessionRepro): SparkSessionReproV4 {
  const { version: _version, projectRef: _projectRef, subgoals: _subgoals, plan, ...v4 } = repro;
  return {
    ...v4,
    version: 4,
    plan: {
      ...plan,
      minimumStepCount: plan.steps.length,
      revisions: plan.revisions.map((revision) => ({
        ...revision,
        minimumStepCount: revision.steps.length,
      })),
    },
  };
}

function toV3(repro: SparkSessionRepro): SparkSessionReproV3 {
  const {
    version: _version,
    projectRef: _projectRef,
    subgoals: _subgoals,
    goalContract: _goalContract,
    plan: _plan,
    stopGuard: _stopGuard,
    ...legacy
  } = repro;
  return { ...legacy, version: 3 };
}
