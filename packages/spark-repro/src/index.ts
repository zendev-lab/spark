import { createHash } from "node:crypto";

import {
  isRef,
  nowIso,
  stableId,
  type EvidenceRef,
  type ProjectRef,
  type RoleRef,
  type SparkSubgoal,
  type SparkSubgoalDefinition,
  type SparkSubgoalStatus,
  type SparkSubgoalVerificationResult,
  type SubgoalRef,
  type TaskRef,
} from "@zendev-lab/spark-core";
import {
  createSubgoal,
  subgoalDefinitionDigest,
  type SparkGoalAuthority,
  type SparkGoalContract,
  type SparkGoalContractStatus,
} from "@zendev-lab/spark-loop";

export type SparkSessionPhase = "plan" | "implement";

export type SparkReproStageName = "contract" | "reference" | "target" | "alignment" | "delivery";

interface SparkReproRequirementBase {
  /** Stable machine identifier; descriptions are presentation only. */
  id: string;
  description: string;
  phase: SparkSessionPhase;
}

export interface SparkReproEvidenceRequirement extends SparkReproRequirementBase {
  kind: "evidence";
  evidenceRefs: EvidenceRef[];
}

export interface SparkReproDecisionRequirement extends SparkReproRequirementBase {
  kind: "decision";
  /** Evidence produced by canonical ask with recordAsEvidence=true. */
  decisionRef?: EvidenceRef;
  selectedValue?: string;
  rationale?: string;
}

export interface SparkReproValidationRequirement extends SparkReproRequirementBase {
  kind: "validation";
  command?: string;
  resultRef?: EvidenceRef;
  passed?: boolean;
}

export type SparkReproRequirement =
  | SparkReproEvidenceRequirement
  | SparkReproDecisionRequirement
  | SparkReproValidationRequirement;

/** @deprecated Use SparkReproRequirement. */
export type SparkReproAcceptanceCondition = SparkReproRequirement;

export type SparkReproRequirementProof =
  | { kind: "evidence"; evidenceRefs: EvidenceRef[] }
  | { kind: "decision"; decisionRef: EvidenceRef; selectedValue: string; rationale?: string }
  | { kind: "validation"; command: string; resultRef: EvidenceRef; passed: boolean };

export interface SparkReproGateEvaluation {
  passed: boolean;
  blockers: string[];
  evidenceRefs: EvidenceRef[];
  evaluatedAt: string;
}

export interface SparkReproGate {
  id: string;
  description: string;
  evaluation?: SparkReproGateEvaluation;
}

export interface SparkReproStage {
  name: SparkReproStageName;
  title: string;
  phases: SparkSessionPhase[];
  acceptance: SparkReproRequirement[];
  gate?: SparkReproGate;
}

export type SparkReproStatus = "active" | "needs_revalidation" | "complete";

export interface SparkSessionReproV3 {
  version: 3;
  reproId: string;
  sessionKey: string;
  status: SparkReproStatus;
  objective?: string;
  currentStageIndex: number;
  currentPhase: SparkSessionPhase;
  stages: SparkReproStage[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type SparkReproGoalContractStatus = SparkGoalContractStatus;
export type SparkReproGoalAuthority = SparkGoalAuthority;
export type SparkReproGoalContract = SparkGoalContract;

export type SparkReproStepAuthority = "safe_local" | "ask_decision" | "ask_approval";
export type SparkReproStepStatus = "pending" | "in_progress" | "done" | "blocked" | "cancelled";

export interface SparkReproStepDefinition {
  id: string;
  stage: SparkReproStageName;
  goal: string;
  doneWhen: string[];
  evidenceRequired: string[];
  authority: SparkReproStepAuthority;
  dependsOn?: string[];
}

export interface SparkReproStep extends SparkReproStepDefinition {
  status: SparkReproStepStatus;
  evidenceRefs: EvidenceRef[];
  verification?: Extract<SparkReproStepVerifierResult, { verdict: "Pass" }>;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export type SparkReproStepProofKind = "evidence" | "decision" | "approval";

export interface SparkReproStepAskBinding {
  schema: "spark.repro.step-ask/v1";
  planRevision: number;
  stepId: string;
  definitionDigest: string;
  doneWhen: string[];
  authority: "ask_decision" | "ask_approval";
}

export type SparkReproStepVerifierResult =
  | {
      verdict: "Pass";
      planRevision: number;
      stepId: string;
      definitionDigest: string;
      proofKind: SparkReproStepProofKind;
      evidenceRefs: EvidenceRef[];
      verifiedDoneWhen: string[];
      askRequestHash?: string;
      acceptedAnswerHash?: string;
      selectedValues?: string[];
      approvalResult?: "approved";
    }
  | {
      verdict: "Repair" | "Ask" | "Replan";
      stepId: string;
      reasons: string[];
    };

export interface SparkReproPlanRevision {
  revision: number;
  reason: string;
  difficulty: number;
  steps: SparkReproStepDefinition[];
  createdAt: string;
}

export interface SparkReproPlan {
  currentRevision: number;
  difficulty: number;
  revisions: SparkReproPlanRevision[];
  steps: SparkReproStep[];
}

export interface SparkReproPlanRevisionV4 extends SparkReproPlanRevision {
  minimumStepCount: number;
}

export interface SparkReproPlanV4 extends Omit<SparkReproPlan, "revisions"> {
  minimumStepCount: number;
  revisions: SparkReproPlanRevisionV4[];
}

export type SparkReproStopDecision = "continue" | "ask" | "revalidate" | "complete";

export interface SparkReproOrchestrationInput {
  taskStatusByRef?: Readonly<Record<string, string | undefined>>;
  activeChildRunCount?: number;
  dispatchableFrontierCount?: number;
  awaitingAsk?: boolean;
}

export interface SparkReproStopGuard {
  lastProgressDigest: string;
  stagnationCount: number;
  limit: number;
  decision: SparkReproStopDecision;
  lastSettledAt?: string;
}

export interface SparkSessionReproV4 {
  version: 4;
  reproId: string;
  sessionKey: string;
  status: SparkReproStatus;
  /** Compatibility projection of goalContract.objective. */
  objective?: string;
  goalContract: SparkReproGoalContract;
  plan: SparkReproPlanV4;
  stopGuard: SparkReproStopGuard;
  currentStageIndex: number;
  currentPhase: SparkSessionPhase;
  stages: SparkReproStage[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SparkReproSubgoal extends SparkSubgoal {
  id: string;
  stage: SparkReproStageName;
}

export interface SparkReproSubgoalV5 extends SparkSubgoalDefinition {
  ref: SubgoalRef;
  id: string;
  stage: SparkReproStageName;
  goalId: string;
  roleRef: RoleRef;
  planRevision: number;
  status: SparkSubgoalStatus;
  taskRefs: TaskRef[];
  evidenceRefs: EvidenceRef[];
  delegation?: {
    sessionId: string;
    planRevision: number;
    definitionDigest: string;
    delegatedAt: string;
  };
  verification?: Extract<SparkSubgoalVerificationResult, { verdict: "Pass" }>;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SparkSessionReproV5 extends Omit<SparkSessionReproV4, "version" | "plan"> {
  version: 5;
  /** Missing only while a legacy v4 snapshot awaits project backfill. */
  projectRef?: ProjectRef;
  plan: SparkReproPlan;
  subgoals: SparkReproSubgoalV5[];
}

export interface SparkReproDualLaneSessionState {
  schema: "spark.repro.dual-lane-session/v1";
  planRevision: number;
  explore: {
    stage: SparkReproStageName;
    observationIds: string[];
  };
  normative: {
    orderedStepIds: string[];
    currentStepId?: string;
    retiredStepIds: string[];
    candidateIds: string[];
  };
  unresolvedIds: string[];
  migration: {
    sourceVersion: 6 | 7;
    legacyProofAuthority: "not_promoted";
  };
}

export interface SparkSessionReproV6 extends Omit<SparkSessionReproV5, "version" | "subgoals"> {
  version: 6;
  subgoals: SparkReproSubgoal[];
}

export interface SparkSessionRepro extends Omit<SparkSessionReproV6, "version"> {
  version: 7;
  dualLane: SparkReproDualLaneSessionState;
}

export const DEFAULT_REPRO_STAGES: SparkReproStage[] = [
  {
    name: "contract",
    title: "Contract",
    phases: ["plan"],
    acceptance: [
      evidenceRequirement(
        "repro-contract-frozen",
        "Reproduction claim and acceptance contract frozen",
        "plan",
      ),
      evidenceRequirement(
        "competitor-baseline-availability-researched",
        "Runnable reference implementation availability verified",
        "plan",
      ),
      decisionRequirement(
        "baseline-construction-strategy-approved",
        "Reuse existing baseline or construction approach approved by the user",
        "plan",
      ),
      evidenceRequirement(
        "implementation-landscape-researched",
        "Reusable implementation and extension boundaries researched",
        "plan",
      ),
      evidenceRequirement(
        "alignment-paths-researched",
        "Real-module and eager alignment paths compared",
        "plan",
      ),
      decisionRequirement(
        "implementation-strategy-approved",
        "Reuse, adapt, or new implementation strategy approved by the user",
        "plan",
      ),
      decisionRequirement(
        "alignment-strategy-approved",
        "Real-module or eager alignment strategy approved by the user",
        "plan",
      ),
      validationRequirement(
        "baseline-probe-passed",
        "Minimum baseline comparison probe passed against an available or user-approved constructed baseline",
        "plan",
      ),
    ],
  },
  {
    name: "reference",
    title: "Reference",
    phases: ["implement"],
    acceptance: [
      evidenceRequirement("project-structure-created", "Project structure created", "implement"),
      validationRequirement(
        "dependencies-buildable",
        "Dependencies installed and buildable",
        "implement",
      ),
    ],
  },
  {
    name: "target",
    title: "Target",
    phases: ["implement"],
    acceptance: [
      validationRequirement(
        "bitwise-pass-20",
        "20+ step BITWISE_PASS reproduction achieved",
        "implement",
      ),
      validationRequirement("bitwise-pass-100", "100-step BITWISE_PASS verified", "implement"),
    ],
    gate: {
      id: "gate-A",
      description: "20+100 step BITWISE_PASS achieved",
    },
  },
  {
    name: "alignment",
    title: "Alignment",
    phases: ["implement"],
    acceptance: [
      validationRequirement(
        "target-scale-convergence",
        "Convergence verified at target scale",
        "implement",
      ),
      validationRequirement("performance-budget", "Performance metrics within budget", "implement"),
    ],
    gate: {
      id: "gate-B",
      description: "Convergence verified at scale",
    },
  },
  {
    name: "delivery",
    title: "Delivery",
    phases: ["implement"],
    acceptance: [
      evidenceRequirement("pr-submitted", "PR submitted", "implement"),
      validationRequirement("no-runtime-patches", "No runtime patches remain", "implement"),
    ],
    gate: {
      id: "gate-C",
      description: "PR submitted, no runtime patch",
    },
  },
];

export function currentReproStage(repro: SparkSessionRepro): SparkReproStage {
  const stage = repro.stages[repro.currentStageIndex];
  if (!stage) throw new Error(`repro stage index is out of range: ${repro.currentStageIndex}`);
  return stage;
}

export function currentPhaseAcceptance(repro: SparkSessionRepro): SparkReproRequirement[] {
  return currentReproStage(repro).acceptance.filter(
    (requirement) => requirement.phase === repro.currentPhase,
  );
}

export function isReproRequirementSatisfied(requirement: SparkReproRequirement): boolean {
  switch (requirement.kind) {
    case "evidence":
      return requirement.evidenceRefs.length > 0;
    case "decision":
      return Boolean(requirement.decisionRef && requirement.selectedValue?.trim());
    case "validation":
      return Boolean(
        requirement.command?.trim() && requirement.resultRef && requirement.passed === true,
      );
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

export function reproRequirementBlockers(requirement: SparkReproRequirement): string[] {
  if (isReproRequirementSatisfied(requirement)) return [];
  switch (requirement.kind) {
    case "evidence":
      return [`${requirement.id} has no evidence ref`];
    case "decision":
      return [`${requirement.id} has no recorded user decision`];
    case "validation":
      return [
        `${requirement.id} requires a command, result evidence ref, and passing validation result`,
      ];
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

export function isPhaseComplete(repro: SparkSessionRepro, phase?: SparkSessionPhase): boolean {
  const targetPhase = phase ?? repro.currentPhase;
  const requirements = currentReproStage(repro).acceptance.filter(
    (requirement) => requirement.phase === targetPhase,
  );
  return requirements.length > 0 && requirements.every(isReproRequirementSatisfied);
}

export function isStageAcceptanceMet(repro: SparkSessionRepro): boolean {
  return currentReproStage(repro).acceptance.every(isReproRequirementSatisfied);
}

export function isStageGatePassed(repro: SparkSessionRepro): boolean {
  const gate = currentReproStage(repro).gate;
  return gate ? gate.evaluation?.passed === true : true;
}

export function isStageComplete(repro: SparkSessionRepro): boolean {
  const subgoals = currentReproSubgoals(repro);
  const planComplete =
    subgoals.length > 0 &&
    subgoals.every((subgoal) => subgoal.status === "done" || subgoal.status === "cancelled");
  return isStageAcceptanceMet(repro) && isStageGatePassed(repro) && planComplete;
}

export function recordReproRequirementProof(
  repro: SparkSessionRepro,
  requirementId: string,
  proof: SparkReproRequirementProof,
): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const index = stage.acceptance.findIndex((requirement) => requirement.id === requirementId);
  if (index < 0) return undefined;
  const current = stage.acceptance[index]!;
  if (current.kind !== proof.kind) {
    throw new Error(
      `repro requirement ${requirementId} expects ${current.kind} proof, received ${proof.kind}`,
    );
  }

  const acceptance = [...stage.acceptance];
  acceptance[index] = requirementWithProof(current, proof);
  const stages = [...repro.stages];
  stages[repro.currentStageIndex] = {
    ...stage,
    acceptance,
    ...(stage.gate ? { gate: { id: stage.gate.id, description: stage.gate.description } } : {}),
  };
  const timestamp = nowIso();
  const requirement = acceptance[index]!;
  const proofRefs = reproRequirementEvidenceRefs(requirement);
  const freezesGoalContract =
    requirementId === "repro-contract-frozen" && isReproRequirementSatisfied(requirement);
  return {
    ...repro,
    stages,
    plan: repro.plan,
    ...(freezesGoalContract
      ? {
          goalContract: {
            ...repro.goalContract,
            status: "frozen",
            evidenceRefs: uniqueEvidenceRefs([...repro.goalContract.evidenceRefs, ...proofRefs]),
            frozenAt: timestamp,
            updatedAt: timestamp,
          },
        }
      : {}),
    updatedAt: timestamp,
  };
}

/**
 * Compatibility helper for legacy callers. It now accepts only evidence
 * requirements and refuses empty evidence instead of writing a satisfied flag.
 */
export function satisfyAcceptanceCondition(
  repro: SparkSessionRepro,
  conditionIdOrDescription: string,
  ref?: string,
): SparkSessionRepro | undefined {
  if (!ref) return undefined;
  const requirement = currentReproStage(repro).acceptance.find(
    (candidate) =>
      candidate.id === conditionIdOrDescription ||
      candidate.description === conditionIdOrDescription,
  );
  if (!requirement || requirement.kind !== "evidence") return undefined;
  return recordReproRequirementProof(repro, requirement.id, {
    kind: "evidence",
    evidenceRefs: [evidenceRef(ref, "evidenceRef")],
  });
}

export interface SparkReproGateEvaluationResult {
  repro: SparkSessionRepro;
  passed: boolean;
  blockers: string[];
}

export function evaluateStageGate(repro: SparkSessionRepro): SparkReproGateEvaluationResult {
  const stage = currentReproStage(repro);
  if (!stage.gate) return { repro, passed: true, blockers: [] };
  const blockers = stage.acceptance.flatMap(reproRequirementBlockers);
  const evaluation: SparkReproGateEvaluation = {
    passed: blockers.length === 0,
    blockers,
    evidenceRefs: stage.acceptance.flatMap(reproRequirementEvidenceRefs),
    evaluatedAt: nowIso(),
  };
  const stages = [...repro.stages];
  stages[repro.currentStageIndex] = { ...stage, gate: { ...stage.gate, evaluation } };
  return {
    repro: { ...repro, stages, updatedAt: evaluation.evaluatedAt },
    passed: evaluation.passed,
    blockers,
  };
}

/** @deprecated Use evaluateStageGate; this no longer force-passes a gate. */
export function passStageGate(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  if (!currentReproStage(repro).gate) return undefined;
  const evaluated = evaluateStageGate(repro);
  return evaluated.passed ? evaluated.repro : undefined;
}

export function advanceReproPhase(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  const stage = currentReproStage(repro);
  const currentPhaseIndex = stage.phases.indexOf(repro.currentPhase);
  if (currentPhaseIndex < 0 || !isPhaseComplete(repro)) return undefined;
  const nextPhase = stage.phases[currentPhaseIndex + 1];
  return nextPhase ? { ...repro, currentPhase: nextPhase, updatedAt: nowIso() } : undefined;
}

export function advanceReproStage(repro: SparkSessionRepro): SparkSessionRepro | undefined {
  if (!isStageComplete(repro)) return undefined;
  const nextStage = repro.stages[repro.currentStageIndex + 1];
  if (!nextStage) {
    const completedAt = nowIso();
    return { ...repro, status: "complete", completedAt, updatedAt: completedAt };
  }
  if (!repro.subgoals.some((subgoal) => subgoal.stage === nextStage.name)) return undefined;
  return {
    ...repro,
    currentStageIndex: repro.currentStageIndex + 1,
    currentPhase: nextStage.phases[0]!,
    updatedAt: nowIso(),
  };
}

export function createSparkSessionRepro(
  sessionKey: string,
  stages?: SparkReproStage[],
  options: { objective?: string; reproId?: string } = {},
): SparkSessionRepro {
  const resolvedStages = structuredClone(stages ?? DEFAULT_REPRO_STAGES);
  const firstPhase = resolvedStages[0]?.phases[0];
  if (!firstPhase) throw new Error("repro requires at least one stage with one phase");
  const objective = options.objective?.trim();
  const timestamp = nowIso();
  const explicitReproId = options.reproId?.trim();
  if (
    options.reproId !== undefined &&
    (!explicitReproId ||
      explicitReproId.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/u.test(explicitReproId))
  ) {
    throw new Error("reproId must be a non-empty safe identifier of at most 128 characters");
  }
  const reproId = explicitReproId ?? crypto.randomUUID?.() ?? `repro-${Date.now()}`;
  const plan = createInitialReproPlan(resolvedStages, timestamp);
  const reproWithoutDigest: SparkSessionRepro = {
    version: 7,
    reproId,
    sessionKey,
    status: "active",
    ...(objective ? { objective } : {}),
    goalContract: createGoalContract(objective, timestamp),
    plan,
    subgoals: createInitialReproSubgoals(reproId, plan, timestamp, new Set(["contract"])),
    dualLane: createInitialDualLaneSessionState(plan),
    stopGuard: {
      lastProgressDigest: "",
      stagnationCount: 0,
      limit: 3,
      decision: "continue",
    },
    currentStageIndex: 0,
    currentPhase: firstPhase,
    stages: resolvedStages,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ...reproWithoutDigest,
    stopGuard: {
      ...reproWithoutDigest.stopGuard,
      lastProgressDigest: reproProgressDigest(reproWithoutDigest),
    },
  };
}

export function isReproComplete(repro: SparkSessionRepro): boolean {
  return repro.status === "complete";
}

/**
 * Explicitly acknowledge a legacy completion migration and reopen execution.
 * Loading, settling, or rendering a v7 snapshot never performs this transition.
 */
export function beginReproRevalidation(repro: SparkSessionRepro): SparkSessionRepro {
  if (repro.status !== "needs_revalidation") return repro;
  const timestamp = nowIso();
  const reopened: SparkSessionRepro = {
    ...repro,
    status: "active",
    stopGuard: {
      ...repro.stopGuard,
      stagnationCount: 0,
      decision: "continue",
      lastSettledAt: timestamp,
    },
    updatedAt: timestamp,
  };
  return {
    ...reopened,
    stopGuard: {
      ...reopened.stopGuard,
      lastProgressDigest: reproProgressDigest(reopened),
    },
  };
}

export function reproRequirementEvidenceRefs(requirement: SparkReproRequirement): EvidenceRef[] {
  switch (requirement.kind) {
    case "evidence":
      return requirement.evidenceRefs;
    case "decision":
      return requirement.decisionRef ? [requirement.decisionRef] : [];
    case "validation":
      return requirement.resultRef ? [requirement.resultRef] : [];
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

export interface SparkReproGoalContractInput {
  objective: string;
  constraints?: string[];
  nonGoals?: string[];
  successCriteria: string[];
  evidenceRequired: string[];
}

export interface SparkReproSubgoalPlanInput extends SparkReproStepDefinition {
  taskRef?: TaskRef;
}

export interface ReviseReproPlanInput {
  reason: string;
  difficulty?: number;
  goalContract?: SparkReproGoalContractInput;
  /** @deprecated Complete-list compatibility input. Prefer subgoals for stage-scoped append/update. */
  steps?: SparkReproStepDefinition[];
  subgoals?: SparkReproSubgoalPlanInput[];
}

export function reviseReproPlan(
  repro: SparkSessionRepro,
  input: ReviseReproPlanInput,
): SparkSessionRepro {
  const reason = nonEmpty(input.reason, "reason");
  if (!input.goalContract && !input.steps && !input.subgoals && input.difficulty === undefined) {
    throw new Error("plan revision requires goalContract, difficulty, steps, or subgoals");
  }
  if (input.steps && input.subgoals) {
    throw new Error(
      "plan revision accepts either complete steps or stage-scoped subgoals, not both",
    );
  }
  const timestamp = nowIso();
  const normalizedGoal = input.goalContract
    ? normalizeGoalContractInput(input.goalContract)
    : undefined;
  const goalChanged =
    normalizedGoal !== undefined &&
    JSON.stringify(goalContractDefinition(repro.goalContract)) !== JSON.stringify(normalizedGoal);
  const { frozenAt: _frozenAt, ...goalContractWithoutFrozenAt } = repro.goalContract;
  const goalContractBase = goalChanged ? goalContractWithoutFrozenAt : repro.goalContract;
  const nextGoalContract = normalizedGoal
    ? {
        ...goalContractBase,
        ...normalizedGoal,
        status: goalChanged ? ("draft" as const) : repro.goalContract.status,
        evidenceRefs: goalChanged ? [] : repro.goalContract.evidenceRefs,
        updatedAt: timestamp,
      }
    : repro.goalContract;
  const difficulty = normalizeDifficulty(input.difficulty ?? repro.plan.difficulty);
  const normalizedSubgoals = input.subgoals
    ? normalizeSubgoalPlanInputs(input.subgoals)
    : undefined;
  const candidateDefinitions = input.steps
    ? input.steps
    : normalizedSubgoals
      ? upsertStepDefinitions(repro.plan.steps.map(stepDefinition), normalizedSubgoals)
      : repro.plan.steps.map(stepDefinition);
  const normalizedSteps = validateAndNormalizeStepDefinitions(repro, candidateDefinitions);
  const definitionsChanged =
    JSON.stringify(normalizedSteps) !== JSON.stringify(repro.plan.steps.map(stepDefinition));
  const planChanged = definitionsChanged || difficulty !== repro.plan.difficulty;
  const nextRevision = repro.plan.currentRevision + (planChanged ? 1 : 0);
  const steps = normalizedSteps.map((definition): SparkReproStep => {
    const prior = repro.plan.steps.find((step) => step.id === definition.id);
    const definitionChanged = !prior || !sameStepDefinition(prior, definition);
    if (!definitionChanged) {
      if (!(goalChanged && definition.id === "repro-contract-frozen")) return prior;
      const { blocker: _blocker, verification: _verification, ...withoutProof } = prior;
      return { ...withoutProof, status: "pending", evidenceRefs: [], updatedAt: timestamp };
    }
    return {
      ...definition,
      status: "pending",
      evidenceRefs: [],
      createdAt: prior?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  });
  const revisions = planChanged
    ? [
        ...repro.plan.revisions,
        {
          revision: nextRevision,
          reason,
          difficulty,
          steps: structuredClone(normalizedSteps),
          createdAt: timestamp,
        },
      ]
    : repro.plan.revisions;
  const stages = goalChanged ? clearGoalContractProof(repro.stages) : repro.stages;
  const revised: SparkSessionRepro = {
    ...repro,
    ...(normalizedGoal ? { objective: normalizedGoal.objective } : {}),
    goalContract: nextGoalContract,
    plan: {
      currentRevision: nextRevision,
      difficulty,
      revisions,
      steps,
    },
    stages,
    updatedAt: timestamp,
  };
  return {
    ...revised,
    subgoals: reconcileReproSubgoals(repro, revised, normalizedSubgoals, goalChanged, timestamp),
    ...(planChanged || goalChanged
      ? { dualLane: rebaseDualLaneSessionState(revised.plan, repro.dualLane) }
      : {}),
  };
}

export interface UpdateReproStepInput {
  status: SparkReproStepStatus;
  evidenceRefs?: EvidenceRef[];
  blocker?: string;
  verifier?: SparkReproStepVerifierResult;
}

export function updateReproStep(
  repro: SparkSessionRepro,
  stepId: string,
  input: UpdateReproStepInput,
): SparkSessionRepro | undefined {
  const index = repro.plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return undefined;
  const current = repro.plan.steps[index]!;
  if (input.status !== "pending" && input.status !== "blocked" && input.status !== "cancelled") {
    const incompleteDependencies = (current.dependsOn ?? []).filter((dependency) => {
      const step = repro.plan.steps.find((candidate) => candidate.id === dependency);
      return !step || (step.status !== "done" && step.status !== "cancelled");
    });
    if (incompleteDependencies.length > 0) {
      throw new Error(
        `repro step ${stepId} has incomplete dependencies: ${incompleteDependencies.join(", ")}`,
      );
    }
  }
  const timestamp = nowIso();
  const evidenceRefs = uniqueEvidenceRefs([...current.evidenceRefs, ...(input.evidenceRefs ?? [])]);
  if (input.status === "done") {
    if (evidenceRefs.length === 0) {
      throw new Error(`repro step ${stepId} requires evidence before it can be done`);
    }
    if (input.verifier?.verdict !== "Pass") {
      throw new Error(
        `repro step ${stepId} requires a passing StepVerifier result before it can be done`,
      );
    }
    const expected = expectedStepPass(repro, current, evidenceRefs);
    if (!sameStepPassBinding(input.verifier, expected)) {
      throw new Error(
        `repro step ${stepId} verifier binding does not match the current plan revision or definition`,
      );
    }
  }
  const blocker = input.blocker?.trim();
  if (input.status === "blocked" && !blocker) {
    throw new Error(`repro step ${stepId} requires a blocker when blocked`);
  }
  const {
    blocker: _currentBlocker,
    verification: _currentVerification,
    ...stepWithoutRuntimeProof
  } = current;
  const steps = [...repro.plan.steps];
  steps[index] = {
    ...stepWithoutRuntimeProof,
    status: input.status,
    evidenceRefs,
    ...(input.status === "done"
      ? {
          verification: input.verifier as Extract<
            SparkReproStepVerifierResult,
            { verdict: "Pass" }
          >,
        }
      : {}),
    ...(input.status === "blocked" ? { blocker: blocker! } : {}),
    updatedAt: timestamp,
  };
  const updated: SparkSessionRepro = {
    ...repro,
    plan: { ...repro.plan, steps },
    updatedAt: timestamp,
  };
  return {
    ...updated,
    subgoals: synchronizeReproSubgoals(updated, repro.subgoals, timestamp),
    dualLane: synchronizeDualLaneSessionState(updated, repro.dualLane, stepId, input.status),
  };
}

export function stepDefinitionDigest(step: SparkReproStepDefinition): string {
  return createHash("sha256")
    .update(JSON.stringify(stepDefinitionValue(step)))
    .digest("hex");
}

export function createReproStepAskBinding(
  repro: SparkSessionRepro,
  step: SparkReproStep,
): SparkReproStepAskBinding {
  if (step.authority !== "ask_decision" && step.authority !== "ask_approval") {
    throw new Error(`repro step ${step.id} does not require a canonical ask`);
  }
  return {
    schema: "spark.repro.step-ask/v1",
    planRevision: reproStepPlanRevision(repro, step.id),
    stepId: step.id,
    definitionDigest: stepDefinitionDigest(step),
    doneWhen: [...step.doneWhen],
    authority: step.authority,
  };
}

export function encodeReproStepAskBinding(binding: SparkReproStepAskBinding): string {
  return `spark.repro.step-ask/v1:${JSON.stringify(binding)}`;
}

export function decodeReproStepAskBinding(
  value: string | undefined,
): SparkReproStepAskBinding | undefined {
  const prefix = "spark.repro.step-ask/v1:";
  if (!value?.startsWith(prefix)) return undefined;
  try {
    const binding = JSON.parse(value.slice(prefix.length)) as Partial<SparkReproStepAskBinding>;
    if (
      binding.schema !== "spark.repro.step-ask/v1" ||
      !Number.isInteger(binding.planRevision) ||
      (binding.planRevision ?? 0) < 1 ||
      typeof binding.stepId !== "string" ||
      !binding.stepId ||
      typeof binding.definitionDigest !== "string" ||
      !binding.definitionDigest ||
      !Array.isArray(binding.doneWhen) ||
      binding.doneWhen.some((entry) => typeof entry !== "string" || !entry) ||
      (binding.authority !== "ask_decision" && binding.authority !== "ask_approval")
    ) {
      return undefined;
    }
    return {
      schema: binding.schema,
      planRevision: binding.planRevision as number,
      stepId: binding.stepId,
      definitionDigest: binding.definitionDigest,
      doneWhen: [...binding.doneWhen],
      authority: binding.authority,
    };
  } catch {
    return undefined;
  }
}

export function verifyReproStepPass(
  repro: SparkSessionRepro,
  stepId: string,
  input: Omit<Extract<SparkReproStepVerifierResult, { verdict: "Pass" }>, "stepId">,
): SparkReproStepVerifierResult {
  const step = repro.plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) return { verdict: "Repair", stepId, reasons: [`unknown step: ${stepId}`] };
  const actual = { ...input, stepId } as Extract<SparkReproStepVerifierResult, { verdict: "Pass" }>;
  const expected = expectedStepPass(repro, step, input.evidenceRefs);
  if (!sameStepPassBinding(actual, expected)) {
    return {
      verdict: "Repair",
      stepId,
      reasons: ["proof does not match the current plan revision, step definition, or doneWhen"],
    };
  }
  return actual;
}

export function reproStepPlanRevision(
  repro: SparkSessionRepro | SparkSessionReproV6 | SparkSessionReproV5,
  stepId: string,
): number {
  return (
    repro.subgoals.find((subgoal) => subgoal.id === stepId)?.planRevision ??
    repro.plan.currentRevision
  );
}

/**
 * Select the next executable step from durable repro state.
 *
 * A blocked dependency does not make a later step executable. If corrupt or
 * legacy state leaves every incomplete step dependency-blocked, return the
 * first incomplete step so callers can surface the blocker without inventing
 * progress.
 */
export function nextReproStep(repro: SparkSessionRepro): SparkReproStep | undefined {
  const incomplete = currentReproSteps(repro).filter(
    (step) => step.status !== "done" && step.status !== "cancelled",
  );
  const completedIds = new Set(
    repro.plan.steps
      .filter((step) => step.status === "done" || step.status === "cancelled")
      .map((step) => step.id),
  );
  return (
    incomplete.find((step) =>
      (step.dependsOn ?? []).every((dependency) => completedIds.has(dependency)),
    ) ?? incomplete[0]
  );
}

export function normalizeStoredSparkSessionRepro(value: unknown): SparkSessionRepro | undefined {
  if (!isStoredSparkSessionRepro(value)) return undefined;
  try {
    const repro =
      value.version === 5
        ? migrateSparkSessionReproV5(value)
        : value.version === 6
          ? migrateSparkSessionReproV6(value)
          : value;
    const stages = normalizeStoredReproStages(repro.stages);
    const steps = repro.plan.steps.map((step: SparkReproStep) => {
      const evidenceRefs = step.evidenceRefs.filter(isStoredEvidenceRef);
      const mustReopen =
        step.status === "done" && !isStoredStepVerificationValid(repro, step, evidenceRefs);
      const { blocker: _blocker, verification: _verification, ...stepWithoutRuntimeProof } = step;
      return {
        ...(mustReopen ? stepWithoutRuntimeProof : step),
        status: mustReopen ? ("pending" as const) : step.status,
        evidenceRefs,
      };
    });
    const normalizedPlan = { ...repro.plan, steps };
    const dualLane = normalizeDualLaneSessionState(normalizedPlan, repro.dualLane);
    const semanticStateChanged =
      JSON.stringify(stages) !== JSON.stringify(repro.stages) ||
      JSON.stringify(steps) !== JSON.stringify(repro.plan.steps) ||
      JSON.stringify(dualLane) !== JSON.stringify(repro.dualLane);
    const normalized: SparkSessionRepro = {
      ...repro,
      stages,
      plan: normalizedPlan,
      dualLane,
      stopGuard: {
        ...repro.stopGuard,
        limit:
          Number.isInteger(repro.stopGuard.limit) && repro.stopGuard.limit > 0
            ? repro.stopGuard.limit
            : 3,
        stagnationCount:
          Number.isInteger(repro.stopGuard.stagnationCount) && repro.stopGuard.stagnationCount >= 0
            ? repro.stopGuard.stagnationCount
            : 0,
      },
    };
    if (!semanticStateChanged && normalized.stopGuard.lastProgressDigest.trim()) return normalized;
    return {
      ...normalized,
      stopGuard: {
        ...normalized.stopGuard,
        lastProgressDigest: reproProgressDigest(normalized),
      },
    };
  } catch {
    return undefined;
  }
}

export function currentReproSubgoals(repro: SparkSessionRepro): SparkReproSubgoal[] {
  const stageName = currentReproStage(repro).name;
  return repro.subgoals.filter((subgoal) => subgoal.stage === stageName);
}

export function nextReproStagePlanningBlocker(repro: SparkSessionRepro): string | undefined {
  if (!isStageComplete(repro)) return undefined;
  const nextStage = repro.stages[repro.currentStageIndex + 1];
  if (!nextStage || repro.subgoals.some((subgoal) => subgoal.stage === nextStage.name))
    return undefined;
  return `Stage ${nextStage.name} has no planned subgoals. Plan concrete subgoals and task experiments before advancing.`;
}

export function currentReproSteps(repro: SparkSessionRepro): SparkReproStep[] {
  const subgoalIds = new Set(currentReproSubgoals(repro).map((subgoal) => subgoal.id));
  return repro.plan.steps.filter((step) => subgoalIds.has(step.id));
}

export function reproProgressDigest(
  repro: SparkSessionRepro | SparkSessionReproV6 | SparkSessionReproV4,
  orchestration: SparkReproOrchestrationInput = {},
): string {
  const progress = {
    status: repro.status,
    currentStageIndex: repro.currentStageIndex,
    currentPhase: repro.currentPhase,
    goalContract: {
      status: repro.goalContract.status,
      objective: repro.goalContract.objective,
      constraints: repro.goalContract.constraints,
      nonGoals: repro.goalContract.nonGoals,
      successCriteria: repro.goalContract.successCriteria,
      evidenceRequired: repro.goalContract.evidenceRequired,
      evidenceRefs: repro.goalContract.evidenceRefs,
    },
    requirements: repro.stages.flatMap((stage) =>
      stage.acceptance.map((requirement) => ({
        id: requirement.id,
        satisfied: isReproRequirementSatisfied(requirement),
        evidenceRefs: reproRequirementEvidenceRefs(requirement),
      })),
    ),
    gates: repro.stages.map((stage) => ({
      id: stage.gate?.id,
      passed: stage.gate?.evaluation?.passed,
      evidenceRefs: stage.gate?.evaluation?.evidenceRefs ?? [],
    })),
    difficulty: repro.plan.difficulty,
    steps: repro.plan.steps.map((step) => ({
      id: step.id,
      stage: step.stage,
      goal: step.goal,
      doneWhen: step.doneWhen,
      evidenceRequired: step.evidenceRequired,
      authority: step.authority,
      dependsOn: step.dependsOn ?? [],
      status: step.status,
      evidenceRefs: step.evidenceRefs,
      blocker: step.blocker,
    })),
    ...(repro.version === 7
      ? {
          dualLane: repro.dualLane,
          subgoalTasks: [...repro.subgoals]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((subgoal) => ({
              id: subgoal.id,
              ...(subgoal.taskRef
                ? {
                    taskRef: subgoal.taskRef,
                    taskStatus: orchestration.taskStatusByRef?.[subgoal.taskRef],
                  }
                : {}),
            })),
        }
      : {}),
  };
  return `repro-progress:${stableId(JSON.stringify(progress))}`;
}

function isStoredStepVerificationValid(
  repro: SparkSessionRepro,
  step: SparkReproStep,
  evidenceRefs: EvidenceRef[],
): boolean {
  const verification = step.verification;
  if (!verification || verification.verdict !== "Pass") return false;
  const expectedProofKind =
    step.authority === "ask_approval"
      ? "approval"
      : step.authority === "ask_decision"
        ? "decision"
        : "evidence";
  return (
    verification.planRevision === reproStepPlanRevision(repro, step.id) &&
    verification.stepId === step.id &&
    verification.definitionDigest === stepDefinitionDigest(step) &&
    verification.proofKind === expectedProofKind &&
    JSON.stringify(verification.evidenceRefs) === JSON.stringify(evidenceRefs) &&
    JSON.stringify(verification.verifiedDoneWhen) === JSON.stringify(step.doneWhen) &&
    (expectedProofKind !== "approval" ||
      (verification.approvalResult === "approved" &&
        JSON.stringify(verification.selectedValues) === JSON.stringify(["approve"]))) &&
    (expectedProofKind === "evidence" ||
      (typeof verification.askRequestHash === "string" &&
        typeof verification.acceptedAnswerHash === "string" &&
        Array.isArray(verification.selectedValues) &&
        verification.selectedValues.length > 0))
  );
}

function normalizeStoredReproStages(stages: readonly SparkReproStage[]): SparkReproStage[] {
  return stages.map((stage) => {
    let invalidProofRemoved = false;
    const acceptance = stage.acceptance.map((requirement): SparkReproRequirement => {
      if (requirement.kind === "evidence") {
        const evidenceRefs = requirement.evidenceRefs.filter(isStoredEvidenceRef);
        invalidProofRemoved ||= evidenceRefs.length !== requirement.evidenceRefs.length;
        return { ...requirement, evidenceRefs };
      }
      if (
        requirement.kind === "decision" &&
        requirement.decisionRef &&
        !isStoredEvidenceRef(requirement.decisionRef)
      ) {
        invalidProofRemoved = true;
        const {
          decisionRef: _decisionRef,
          selectedValue: _selectedValue,
          rationale: _rationale,
          ...pending
        } = requirement;
        return pending;
      }
      if (
        requirement.kind === "validation" &&
        requirement.resultRef &&
        !isStoredEvidenceRef(requirement.resultRef)
      ) {
        invalidProofRemoved = true;
        const { resultRef: _resultRef, passed: _passed, ...pending } = requirement;
        return pending;
      }
      return requirement;
    });
    if (!stage.gate) return { ...stage, acceptance };
    const gateHasInvalidRefs = stage.gate.evaluation?.evidenceRefs.some(
      (ref) => !isStoredEvidenceRef(ref),
    );
    if (!invalidProofRemoved && !gateHasInvalidRefs) return { ...stage, acceptance };
    const { evaluation: _evaluation, ...gate } = stage.gate;
    return { ...stage, acceptance, gate };
  });
}

function isStoredSparkSessionRepro(
  value: unknown,
): value is SparkSessionRepro | SparkSessionReproV6 | SparkSessionReproV5 {
  if (!isRecord(value) || (value.version !== 5 && value.version !== 6 && value.version !== 7))
    return false;
  if (
    typeof value.reproId !== "string" ||
    typeof value.sessionKey !== "string" ||
    (value.status !== "active" &&
      value.status !== "needs_revalidation" &&
      value.status !== "complete") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.completedAt !== undefined && typeof value.completedAt !== "string") ||
    !Number.isInteger(value.currentStageIndex) ||
    (value.currentPhase !== "plan" && value.currentPhase !== "implement") ||
    !Array.isArray(value.stages) ||
    value.stages.length === 0 ||
    !value.stages.every(isStoredReproStage)
  ) {
    return false;
  }
  if (!isRecord(value.goalContract) || !isStoredGoalContract(value.goalContract)) return false;
  if (!isRecord(value.plan) || !isStoredReproPlan(value.plan)) return false;
  if (
    !Array.isArray(value.subgoals) ||
    !value.subgoals.every(value.version === 5 ? isStoredReproSubgoalV5 : isStoredReproSubgoal)
  )
    return false;
  if (value.version === 7 && !isStoredDualLaneSessionState(value.dualLane, value.plan))
    return false;
  if (value.version !== 7 && value.status === "needs_revalidation") return false;
  if (
    value.projectRef !== undefined &&
    (typeof value.projectRef !== "string" || !isRef(value.projectRef, "proj"))
  )
    return false;
  if (!isRecord(value.stopGuard) || !isStoredStopGuard(value.stopGuard)) return false;
  const currentStageIndex = Number(value.currentStageIndex);
  return currentStageIndex >= 0 && currentStageIndex < value.stages.length;
}

function isStoredDualLaneSessionState(
  value: unknown,
  plan: SparkReproPlan,
): value is SparkReproDualLaneSessionState {
  if (!isRecord(value) || value.schema !== "spark.repro.dual-lane-session/v1") return false;
  if (value.planRevision !== plan.currentRevision) return false;
  if (!isRecord(value.explore) || !isReproStageName(value.explore.stage)) return false;
  if (!isStringArray(value.explore.observationIds)) return false;
  if (!isRecord(value.normative)) return false;
  if (
    !isStringArray(value.normative.orderedStepIds) ||
    !isStringArray(value.normative.retiredStepIds) ||
    !isStringArray(value.normative.candidateIds) ||
    (value.normative.currentStepId !== undefined &&
      typeof value.normative.currentStepId !== "string")
  )
    return false;
  const orderedStepIds = plan.steps.map((step) => step.id);
  const retiredStepIds = value.normative.retiredStepIds;
  const candidateIds = value.normative.candidateIds;
  if (JSON.stringify(value.normative.orderedStepIds) !== JSON.stringify(orderedStepIds))
    return false;
  if (
    new Set(retiredStepIds).size !== retiredStepIds.length ||
    new Set(candidateIds).size !== candidateIds.length ||
    JSON.stringify(retiredStepIds) !==
      JSON.stringify(orderedStepIds.slice(0, retiredStepIds.length))
  )
    return false;
  const retired = new Set(retiredStepIds);
  if (
    candidateIds.some(
      (id) =>
        !orderedStepIds.includes(id) ||
        retired.has(id) ||
        plan.steps.find((step) => step.id === id)?.status !== "done",
    )
  )
    return false;
  const currentStepId = orderedStepIds[retiredStepIds.length];
  if (value.normative.currentStepId !== currentStepId) return false;
  if (!isStringArray(value.unresolvedIds)) return false;
  if (
    new Set(value.explore.observationIds).size !== value.explore.observationIds.length ||
    new Set(value.unresolvedIds).size !== value.unresolvedIds.length
  )
    return false;
  return (
    isRecord(value.migration) &&
    (value.migration.sourceVersion === 6 || value.migration.sourceVersion === 7) &&
    value.migration.legacyProofAuthority === "not_promoted"
  );
}

function isStoredGoalContract(value: Record<string, unknown>): boolean {
  return (
    (value.status === "draft" || value.status === "frozen") &&
    typeof value.objective === "string" &&
    value.objective.trim().length > 0 &&
    isStringArray(value.constraints) &&
    isStringArray(value.nonGoals) &&
    isStringArray(value.successCriteria) &&
    isStringArray(value.evidenceRequired) &&
    Array.isArray(value.evidenceRefs) &&
    isStoredGoalAuthority(value.authority) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.frozenAt === undefined || typeof value.frozenAt === "string")
  );
}

function isStoredGoalAuthority(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.safeLocal === "auto" &&
    value.externalWrites === "ask" &&
    value.destructiveActions === "ask" &&
    value.scopeExpansion === "ask"
  );
}

function isStoredReproPlan(value: unknown): value is SparkReproPlan {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.currentRevision) &&
    Number(value.currentRevision) > 0 &&
    Number.isInteger(value.difficulty) &&
    Array.isArray(value.revisions) &&
    value.revisions.every(isStoredReproPlanRevision) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStoredReproStep)
  );
}

function isStoredReproPlanRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isInteger(value.revision) &&
    typeof value.reason === "string" &&
    Number.isInteger(value.difficulty) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStoredReproStepDefinition) &&
    typeof value.createdAt === "string"
  );
}

function isStoredReproSubgoalV5(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isReproStageName(value.stage) &&
    typeof value.ref === "string" &&
    isRef(value.ref, "subgoal") &&
    typeof value.goalId === "string" &&
    typeof value.roleRef === "string" &&
    isRef(value.roleRef, "role") &&
    Number.isInteger(value.planRevision) &&
    typeof value.goal === "string" &&
    isStringArray(value.doneWhen) &&
    isStringArray(value.evidenceRequired) &&
    (value.authority === "safe_local" ||
      value.authority === "ask_decision" ||
      value.authority === "ask_approval") &&
    (value.dependsOn === undefined ||
      (Array.isArray(value.dependsOn) &&
        value.dependsOn.every((ref) => typeof ref === "string" && isRef(ref, "subgoal")))) &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "done" ||
      value.status === "blocked" ||
      value.status === "cancelled") &&
    Array.isArray(value.taskRefs) &&
    value.taskRefs.every((ref) => typeof ref === "string" && isRef(ref, "task")) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every(isStoredEvidenceRef) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isStoredReproSubgoal(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isReproStageName(value.stage) &&
    typeof value.ref === "string" &&
    isRef(value.ref, "subgoal") &&
    Number.isInteger(value.planRevision) &&
    typeof value.goal === "string" &&
    isStringArray(value.doneWhen) &&
    isStringArray(value.evidenceRequired) &&
    (value.authority === "safe_local" ||
      value.authority === "ask_decision" ||
      value.authority === "ask_approval") &&
    (value.dependsOn === undefined ||
      (Array.isArray(value.dependsOn) &&
        value.dependsOn.every((ref) => typeof ref === "string" && isRef(ref, "subgoal")))) &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "done" ||
      value.status === "blocked" ||
      value.status === "cancelled") &&
    (value.taskRef === undefined ||
      (typeof value.taskRef === "string" && isRef(value.taskRef, "task"))) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every(isStoredEvidenceRef) &&
    (value.verification === undefined || isStoredSubgoalVerification(value.verification)) &&
    (value.blocker === undefined || typeof value.blocker === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isStoredSubgoalVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.verdict === "Pass" &&
    typeof value.subgoalRef === "string" &&
    isRef(value.subgoalRef, "subgoal") &&
    Number.isInteger(value.planRevision) &&
    typeof value.definitionDigest === "string" &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every(isStoredEvidenceRef) &&
    isStringArray(value.verifiedDoneWhen) &&
    (value.canonicalAskEvidenceRef === undefined ||
      (typeof value.canonicalAskEvidenceRef === "string" &&
        isStoredEvidenceRef(value.canonicalAskEvidenceRef)))
  );
}

function isStoredReproStep(value: unknown): value is SparkReproStep {
  if (!isRecord(value)) return false;
  return (
    isStoredReproStepDefinition(value) &&
    (value.status === "pending" ||
      value.status === "in_progress" ||
      value.status === "done" ||
      value.status === "blocked" ||
      value.status === "cancelled") &&
    Array.isArray(value.evidenceRefs) &&
    (value.verification === undefined || isStoredStepVerification(value.verification)) &&
    (value.blocker === undefined || typeof value.blocker === "string") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isStoredReproStepDefinition(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isReproStageName(value.stage) &&
    typeof value.goal === "string" &&
    isStringArray(value.doneWhen) &&
    isStringArray(value.evidenceRequired) &&
    (value.authority === "safe_local" ||
      value.authority === "ask_decision" ||
      value.authority === "ask_approval") &&
    (value.dependsOn === undefined || isStringArray(value.dependsOn))
  );
}

function isStoredStepVerification(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.verdict === "Pass" &&
    Number.isInteger(value.planRevision) &&
    typeof value.stepId === "string" &&
    typeof value.definitionDigest === "string" &&
    (value.proofKind === "evidence" ||
      value.proofKind === "decision" ||
      value.proofKind === "approval") &&
    Array.isArray(value.evidenceRefs) &&
    isStringArray(value.verifiedDoneWhen) &&
    (value.askRequestHash === undefined || typeof value.askRequestHash === "string") &&
    (value.acceptedAnswerHash === undefined || typeof value.acceptedAnswerHash === "string") &&
    (value.selectedValues === undefined || isStringArray(value.selectedValues)) &&
    (value.approvalResult === undefined || value.approvalResult === "approved")
  );
}

function isStoredReproStage(value: unknown): value is SparkReproStage {
  if (!isRecord(value)) return false;
  return (
    isReproStageName(value.name) &&
    typeof value.title === "string" &&
    Array.isArray(value.phases) &&
    value.phases.every((phase) => phase === "plan" || phase === "implement") &&
    Array.isArray(value.acceptance) &&
    value.acceptance.every(isStoredReproRequirement) &&
    (value.gate === undefined || isStoredReproGate(value.gate))
  );
}

function isStoredReproGate(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.description === "string" &&
    (value.evaluation === undefined ||
      (isRecord(value.evaluation) &&
        typeof value.evaluation.passed === "boolean" &&
        isStringArray(value.evaluation.blockers) &&
        Array.isArray(value.evaluation.evidenceRefs) &&
        typeof value.evaluation.evaluatedAt === "string"))
  );
}

function isStoredReproRequirement(value: unknown): value is SparkReproRequirement {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.description !== "string" ||
    (value.phase !== "plan" && value.phase !== "implement")
  ) {
    return false;
  }
  if (value.kind === "evidence") return Array.isArray(value.evidenceRefs);
  if (value.kind === "decision") {
    return (
      (value.decisionRef === undefined || typeof value.decisionRef === "string") &&
      (value.selectedValue === undefined || typeof value.selectedValue === "string") &&
      (value.rationale === undefined || typeof value.rationale === "string")
    );
  }
  if (value.kind === "validation") {
    return (
      (value.command === undefined || typeof value.command === "string") &&
      (value.resultRef === undefined || typeof value.resultRef === "string") &&
      (value.passed === undefined || typeof value.passed === "boolean")
    );
  }
  return false;
}

function isStoredStopGuard(value: Record<string, unknown>): boolean {
  return (
    typeof value.lastProgressDigest === "string" &&
    typeof value.stagnationCount === "number" &&
    typeof value.limit === "number" &&
    (value.decision === "continue" ||
      value.decision === "ask" ||
      value.decision === "revalidate" ||
      value.decision === "complete") &&
    (value.lastSettledAt === undefined || typeof value.lastSettledAt === "string")
  );
}

function isStoredEvidenceRef(value: unknown): value is EvidenceRef {
  return (
    typeof value === "string" && value.startsWith("evidence:") && value.length > "evidence:".length
  );
}

function isReproStageName(value: unknown): value is SparkReproStageName {
  return (
    value === "contract" ||
    value === "reference" ||
    value === "target" ||
    value === "alignment" ||
    value === "delivery"
  );
}

export function normalizeReproStageName(value: unknown): SparkReproStageName {
  switch (value) {
    case "contract":
    case "setup":
      return "contract";
    case "reference":
    case "scaffold":
      return "reference";
    case "target":
    case "reproduce":
      return "target";
    case "alignment":
    case "scale":
      return "alignment";
    case "delivery":
    case "deliver":
      return "delivery";
    default:
      throw new Error(`unknown Repro stage: ${String(value)}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SparkReproSettleResult {
  repro: SparkSessionRepro;
  decision: SparkReproStopDecision;
  scheduleDelayMs?: 10_000 | 30_000;
  dormantReason?: "awaiting_ask";
}

export function settleReproTick(
  repro: SparkSessionRepro,
  orchestration: SparkReproOrchestrationInput = {},
): SparkReproSettleResult {
  const timestamp = nowIso();
  const digest = reproProgressDigest(repro, orchestration);
  if (repro.status === "needs_revalidation") {
    const settled = {
      ...repro,
      stopGuard: {
        ...repro.stopGuard,
        lastProgressDigest: digest,
        stagnationCount: 0,
        decision: "revalidate" as const,
        lastSettledAt: timestamp,
      },
      updatedAt: timestamp,
    };
    return { repro: settled, decision: "revalidate" };
  }
  if (isReproComplete(repro)) {
    const settled = {
      ...repro,
      stopGuard: {
        ...repro.stopGuard,
        lastProgressDigest: digest,
        stagnationCount: 0,
        decision: "complete" as const,
        lastSettledAt: timestamp,
      },
      updatedAt: timestamp,
    };
    return { repro: settled, decision: "complete" };
  }
  const stagnationCount =
    (orchestration.activeChildRunCount ?? 0) > 0
      ? 0
      : digest === repro.stopGuard.lastProgressDigest
        ? repro.stopGuard.stagnationCount + 1
        : 0;
  const decision: SparkReproStopDecision =
    stagnationCount >= repro.stopGuard.limit ? "ask" : "continue";
  const settled = {
    ...repro,
    stopGuard: {
      ...repro.stopGuard,
      lastProgressDigest: digest,
      stagnationCount,
      decision,
      lastSettledAt: timestamp,
    },
    updatedAt: timestamp,
  };
  if (decision !== "continue") return { repro: settled, decision };
  if (
    orchestration.awaitingAsk &&
    (orchestration.activeChildRunCount ?? 0) === 0 &&
    (orchestration.dispatchableFrontierCount ?? 0) === 0
  ) {
    return { repro: settled, decision, dormantReason: "awaiting_ask" };
  }
  return {
    repro: settled,
    decision,
    scheduleDelayMs: (orchestration.activeChildRunCount ?? 0) > 0 ? 10_000 : 30_000,
  };
}

export function migrateSparkSessionReproV3(repro: SparkSessionReproV3): SparkSessionReproV4 {
  const timestamp = repro.updatedAt || nowIso();
  const contractProof = repro.stages
    .flatMap((stage) => stage.acceptance)
    .find((requirement) => requirement.id === "repro-contract-frozen");
  const contractRefs = contractProof ? reproRequirementEvidenceRefs(contractProof) : [];
  const goalContract = createGoalContract(repro.objective?.trim(), repro.createdAt);
  const migratedWithoutDigest: SparkSessionReproV4 = {
    ...repro,
    version: 4,
    goalContract: {
      ...goalContract,
      ...(contractRefs.length > 0
        ? {
            status: "frozen" as const,
            evidenceRefs: contractRefs,
            frozenAt: timestamp,
          }
        : {}),
      updatedAt: timestamp,
    },
    plan: createLegacyReproPlanV4(repro.stages, timestamp),
    stopGuard: {
      lastProgressDigest: "",
      stagnationCount: 0,
      limit: 3,
      decision: repro.status === "complete" ? "complete" : "continue",
    },
  };
  return {
    ...migratedWithoutDigest,
    stopGuard: {
      ...migratedWithoutDigest.stopGuard,
      lastProgressDigest: reproProgressDigest(migratedWithoutDigest),
    },
  };
}

export function migrateSparkSessionReproV4(repro: SparkSessionReproV4): SparkSessionRepro {
  const legacy = reopenLegacyCompletionForDualLane(repro);
  const plan = migrateReproPlanV4(legacy.plan);
  const migratedWithoutDigest: SparkSessionRepro = {
    ...legacy,
    version: 7,
    plan,
    subgoals: createInitialReproSubgoals(legacy.reproId, plan, legacy.updatedAt || nowIso()),
    dualLane: createInitialDualLaneSessionState(plan, 6),
  };
  return {
    ...migratedWithoutDigest,
    stopGuard: {
      ...migratedWithoutDigest.stopGuard,
      lastProgressDigest: reproProgressDigest(migratedWithoutDigest),
    },
  };
}

export function migrateSparkSessionReproV5(repro: SparkSessionReproV5): SparkSessionRepro {
  const legacy = reopenLegacyCompletionForDualLane(repro);
  const taskUseCount = new Map<TaskRef, number>();
  for (const subgoal of legacy.subgoals) {
    for (const taskRef of new Set(subgoal.taskRefs)) {
      taskUseCount.set(taskRef, (taskUseCount.get(taskRef) ?? 0) + 1);
    }
  }
  const migratedWithoutDigest: SparkSessionRepro = {
    ...legacy,
    version: 7,
    subgoals: legacy.subgoals.map((legacySubgoal): SparkReproSubgoal => {
      const uniqueTaskRefs = [...new Set(legacySubgoal.taskRefs)];
      const taskRef =
        uniqueTaskRefs.length === 1 && taskUseCount.get(uniqueTaskRefs[0]!) === 1
          ? uniqueTaskRefs[0]
          : undefined;
      return {
        ref: legacySubgoal.ref,
        id: legacySubgoal.id,
        stage: legacySubgoal.stage,
        goal: legacySubgoal.goal,
        doneWhen: [...legacySubgoal.doneWhen],
        evidenceRequired: [...legacySubgoal.evidenceRequired],
        authority: legacySubgoal.authority,
        ...(legacySubgoal.dependsOn ? { dependsOn: [...legacySubgoal.dependsOn] } : {}),
        planRevision: legacySubgoal.planRevision,
        status:
          legacySubgoal.delegation &&
          legacySubgoal.status !== "done" &&
          legacySubgoal.status !== "cancelled"
            ? "pending"
            : legacySubgoal.status,
        ...(taskRef ? { taskRef } : {}),
        evidenceRefs: [...legacySubgoal.evidenceRefs],
        ...(legacySubgoal.verification ? { verification: legacySubgoal.verification } : {}),
        ...(legacySubgoal.blocker ? { blocker: legacySubgoal.blocker } : {}),
        createdAt: legacySubgoal.createdAt,
        updatedAt: legacySubgoal.updatedAt,
      };
    }),
    dualLane: createInitialDualLaneSessionState(legacy.plan, 6),
  };
  return {
    ...migratedWithoutDigest,
    stopGuard: {
      ...migratedWithoutDigest.stopGuard,
      lastProgressDigest: reproProgressDigest(migratedWithoutDigest),
    },
  };
}

export function migrateSparkSessionReproV6(repro: SparkSessionReproV6): SparkSessionRepro {
  const legacy = reopenLegacyCompletionForDualLane(repro);
  const migratedWithoutDigest: SparkSessionRepro = {
    ...legacy,
    version: 7,
    dualLane: createInitialDualLaneSessionState(legacy.plan, 6),
  };
  return {
    ...migratedWithoutDigest,
    stopGuard: {
      ...migratedWithoutDigest.stopGuard,
      lastProgressDigest: reproProgressDigest(migratedWithoutDigest),
    },
  };
}

function reopenLegacyCompletionForDualLane<
  T extends SparkSessionReproV4 | SparkSessionReproV5 | SparkSessionReproV6,
>(repro: T): T {
  if (repro.status !== "complete") return repro;
  const reopened = {
    ...repro,
    status: "needs_revalidation" as const,
    stopGuard: { ...repro.stopGuard, decision: "revalidate" as const },
  };
  delete (reopened as { completedAt?: string }).completedAt;
  return reopened as T;
}

function rebaseDualLaneSessionState(
  plan: SparkReproPlan,
  prior: SparkReproDualLaneSessionState,
): SparkReproDualLaneSessionState {
  const orderedStepIds = plan.steps.map((step) => step.id);
  return {
    ...prior,
    planRevision: plan.currentRevision,
    normative: {
      orderedStepIds,
      ...(orderedStepIds[0] ? { currentStepId: orderedStepIds[0] } : {}),
      retiredStepIds: [],
      candidateIds: [],
    },
  };
}

function normalizeDualLaneSessionState(
  plan: SparkReproPlan,
  prior: SparkReproDualLaneSessionState,
): SparkReproDualLaneSessionState {
  const orderedStepIds = plan.steps.map((step) => step.id);
  const verifiedIds = new Set([...prior.normative.retiredStepIds, ...prior.normative.candidateIds]);
  const retiredStepIds: string[] = [];
  for (const step of plan.steps) {
    if (step.status !== "done" || !verifiedIds.has(step.id)) break;
    retiredStepIds.push(step.id);
  }
  const retired = new Set(retiredStepIds);
  const candidateIds = orderedStepIds.filter(
    (id) =>
      verifiedIds.has(id) &&
      !retired.has(id) &&
      plan.steps.find((step) => step.id === id)?.status === "done",
  );
  const currentStepId = orderedStepIds[retiredStepIds.length];
  return {
    ...prior,
    planRevision: plan.currentRevision,
    normative: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds,
    },
  };
}

function synchronizeDualLaneSessionState(
  repro: SparkSessionRepro,
  prior: SparkReproDualLaneSessionState,
  stepId: string,
  status: SparkReproStepStatus,
): SparkReproDualLaneSessionState {
  const orderedStepIds = repro.plan.steps.map((step) => step.id);
  const verifiedIds = new Set([...prior.normative.retiredStepIds, ...prior.normative.candidateIds]);
  if (status === "done") verifiedIds.add(stepId);
  else verifiedIds.delete(stepId);
  const retiredStepIds: string[] = [];
  while (retiredStepIds.length < orderedStepIds.length) {
    const nextStepId = orderedStepIds[retiredStepIds.length]!;
    const step = repro.plan.steps[retiredStepIds.length]!;
    if (step.status !== "done" || !verifiedIds.has(nextStepId)) break;
    retiredStepIds.push(nextStepId);
  }
  const retired = new Set(retiredStepIds);
  const currentStepId = orderedStepIds[retiredStepIds.length];
  return {
    ...prior,
    planRevision: repro.plan.currentRevision,
    normative: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds: orderedStepIds.filter((id) => verifiedIds.has(id) && !retired.has(id)),
    },
  };
}

function createInitialDualLaneSessionState(
  plan: SparkReproPlan,
  sourceVersion: 6 | 7 = 7,
): SparkReproDualLaneSessionState {
  const orderedStepIds = plan.steps.map((step) => step.id);
  const retiredStepIds: string[] = [];
  if (sourceVersion === 7) {
    for (const step of plan.steps) {
      if (step.status !== "done") break;
      retiredStepIds.push(step.id);
    }
  }
  const retired = new Set(retiredStepIds);
  const candidateIds =
    sourceVersion === 7
      ? plan.steps
          .filter((step) => step.status === "done" && !retired.has(step.id))
          .map((step) => step.id)
      : [];
  const currentStepId = orderedStepIds.find((stepId) => !retired.has(stepId));
  const initial: SparkReproDualLaneSessionState = {
    schema: "spark.repro.dual-lane-session/v1",
    planRevision: plan.currentRevision,
    explore: {
      stage: plan.steps[0]?.stage ?? "contract",
      observationIds: [],
    },
    normative: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds,
    },
    unresolvedIds: [],
    migration: {
      sourceVersion,
      legacyProofAuthority: "not_promoted",
    },
  };
  return initial;
}

function reconcileReproSubgoals(
  before: SparkSessionRepro,
  after: SparkSessionRepro,
  inputs: SparkReproSubgoalPlanInput[] | undefined,
  goalChanged: boolean,
  timestamp: string,
): SparkReproSubgoal[] {
  const inputById = new Map((inputs ?? []).map((input) => [input.id, input]));
  const targetIds = new Set([...before.subgoals.map((subgoal) => subgoal.id), ...inputById.keys()]);
  return [...targetIds].map((id) => {
    const prior = before.subgoals.find((subgoal) => subgoal.id === id);
    const step = after.plan.steps.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`subgoal ${id} has no compatibility plan step`);
    const taskRef = inputById.get(id)?.taskRef ?? prior?.taskRef;
    const definitionChanged =
      !prior ||
      subgoalDefinitionDigest(prior) !==
        subgoalDefinitionDigest(subgoalDefinitionFromStep(after.reproId, step));
    const clearGoalProof = goalChanged && id === "repro-contract-frozen";
    if (prior && !definitionChanged && !clearGoalProof) {
      const { taskRef: _priorTaskRef, ...withoutTaskRef } = prior;
      return taskRef ? { ...withoutTaskRef, taskRef } : withoutTaskRef;
    }
    return subgoalFromStep(
      after.reproId,
      step,
      definitionChanged ? after.plan.currentRevision : prior!.planRevision,
      timestamp,
      taskRef,
      clearGoalProof,
    );
  });
}

function synchronizeReproSubgoals(
  repro: SparkSessionRepro,
  priorSubgoals: readonly SparkReproSubgoal[],
  timestamp: string,
): SparkReproSubgoal[] {
  return priorSubgoals.map((prior) => {
    const step = repro.plan.steps.find((candidate) => candidate.id === prior.id);
    return step
      ? subgoalFromStep(repro.reproId, step, prior.planRevision, timestamp, prior.taskRef)
      : prior;
  });
}

function createInitialReproSubgoals(
  reproId: string,
  plan: SparkReproPlan,
  timestamp: string,
  stages?: ReadonlySet<SparkReproStageName>,
): SparkReproSubgoal[] {
  return plan.steps
    .filter((step) => !stages || stages.has(step.stage))
    .map((step) => subgoalFromStep(reproId, step, plan.currentRevision, timestamp));
}

function subgoalFromStep(
  reproId: string,
  step: SparkReproStep,
  planRevision: number,
  timestamp: string,
  taskRef?: TaskRef,
  clearProof = false,
): SparkReproSubgoal {
  const subgoal = createSubgoal({
    ref: `subgoal:${stableId(`${reproId}:${step.id}`)}` as SubgoalRef,
    planRevision,
    ...subgoalDefinitionFromStep(reproId, step),
    ...(taskRef ? { taskRef } : {}),
    evidenceRefs: clearProof ? [] : step.evidenceRefs,
    now: step.createdAt || timestamp,
  });
  const verification =
    !clearProof && step.status === "done" && step.verification?.verdict === "Pass"
      ? {
          verdict: "Pass" as const,
          subgoalRef: subgoal.ref,
          planRevision,
          definitionDigest: subgoalDefinitionDigest(subgoal),
          evidenceRefs: [...step.evidenceRefs],
          verifiedDoneWhen: [...step.doneWhen],
          ...(step.authority === "safe_local" || !step.evidenceRefs[0]
            ? {}
            : { canonicalAskEvidenceRef: step.evidenceRefs[0] }),
        }
      : undefined;
  return {
    ...subgoal,
    id: step.id,
    stage: step.stage,
    status: verification ? "done" : clearProof || step.status === "done" ? "pending" : step.status,
    evidenceRefs: clearProof ? [] : [...step.evidenceRefs],
    ...(verification ? { verification } : {}),
    ...(!clearProof && step.blocker ? { blocker: step.blocker } : {}),
    createdAt: step.createdAt,
    updatedAt: step.updatedAt || timestamp,
  };
}

function subgoalDefinitionFromStep(
  reproId: string,
  step: SparkReproStepDefinition,
): SparkSubgoalDefinition {
  return {
    goal: step.goal,
    doneWhen: [...step.doneWhen],
    evidenceRequired: [...step.evidenceRequired],
    authority: step.authority,
    ...(step.dependsOn
      ? {
          dependsOn: step.dependsOn.map(
            (stepId) => `subgoal:${stableId(`${reproId}:${stepId}`)}` as SubgoalRef,
          ),
        }
      : {}),
  };
}

function createGoalContract(
  objective: string | undefined,
  timestamp: string,
): SparkReproGoalContract {
  return {
    status: "draft",
    objective: objective || "Reproduce the target behavior with inspectable evidence",
    constraints: [
      "Preserve the fixed contract, reference, target, alignment, and delivery evidence gates",
    ],
    nonGoals: ["Treating agent narration as proof of completion"],
    successCriteria: [
      "Every required claim is backed by inspectable evidence",
      "Every stage gate passes before the next stage starts",
    ],
    evidenceRequired: ["Evidence refs for completed requirements and plan steps"],
    authority: {
      safeLocal: "auto",
      externalWrites: "ask",
      destructiveActions: "ask",
      scopeExpansion: "ask",
    },
    evidenceRefs: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createInitialReproPlan(
  stages: readonly SparkReproStage[],
  timestamp: string,
): SparkReproPlan {
  const difficulty = 8;
  const steps = stages.flatMap((stage) =>
    stage.acceptance.map((requirement): SparkReproStep => {
      const definition = stepDefinitionForRequirement(stage.name, requirement);
      return {
        ...definition,
        status: "pending",
        evidenceRefs: reproRequirementEvidenceRefs(requirement),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }),
  );
  return {
    currentRevision: 1,
    difficulty,
    revisions: [
      {
        revision: 1,
        reason: "Seed plan from fixed repro evidence gates",
        difficulty,
        steps: steps.map(stepDefinition),
        createdAt: timestamp,
      },
    ],
    steps,
  };
}

function createLegacyReproPlanV4(
  stages: readonly SparkReproStage[],
  timestamp: string,
): SparkReproPlanV4 {
  const plan = createInitialReproPlan(stages, timestamp);
  return {
    ...plan,
    minimumStepCount: plan.steps.length,
    revisions: plan.revisions.map((revision) => ({
      ...revision,
      minimumStepCount: revision.steps.length,
    })),
  };
}

function migrateReproPlanV4(plan: SparkReproPlanV4): SparkReproPlan {
  return {
    currentRevision: plan.currentRevision,
    difficulty: plan.difficulty,
    revisions: plan.revisions.map(
      ({ minimumStepCount: _minimumStepCount, ...revision }) => revision,
    ),
    steps: plan.steps,
  };
}

function stepDefinitionForRequirement(
  stage: SparkReproStageName,
  requirement: SparkReproRequirement,
): SparkReproStepDefinition {
  switch (requirement.kind) {
    case "evidence":
      return {
        id: requirement.id,
        stage,
        goal: requirement.description,
        doneWhen: [requirement.description],
        evidenceRequired: ["At least one inspectable evidence ref"],
        authority: "safe_local",
      };
    case "decision":
      return {
        id: requirement.id,
        stage,
        goal: requirement.description,
        doneWhen: [requirement.description],
        evidenceRequired: ["Canonical ask decision evidence with the selected value"],
        authority: "ask_decision",
      };
    case "validation":
      return {
        id: requirement.id,
        stage,
        goal: requirement.description,
        doneWhen: [requirement.description],
        evidenceRequired: ["Passing command result captured as evidence"],
        authority: "safe_local",
      };
    default: {
      const exhaustive: never = requirement;
      return exhaustive;
    }
  }
}

function stepDefinition(step: SparkReproStep): SparkReproStepDefinition {
  return stepDefinitionValue(step);
}

function stepDefinitionValue(step: SparkReproStepDefinition): SparkReproStepDefinition {
  return {
    id: step.id,
    stage: step.stage,
    goal: step.goal,
    doneWhen: [...step.doneWhen],
    evidenceRequired: [...step.evidenceRequired],
    authority: step.authority,
    ...(step.dependsOn ? { dependsOn: [...step.dependsOn] } : {}),
  };
}

function expectedStepPass(
  repro: SparkSessionRepro,
  step: SparkReproStep,
  evidenceRefs: EvidenceRef[],
): Extract<SparkReproStepVerifierResult, { verdict: "Pass" }> {
  return {
    verdict: "Pass",
    planRevision: reproStepPlanRevision(repro, step.id),
    stepId: step.id,
    definitionDigest: stepDefinitionDigest(step),
    proofKind:
      step.authority === "ask_approval"
        ? "approval"
        : step.authority === "ask_decision"
          ? "decision"
          : "evidence",
    evidenceRefs: [...evidenceRefs],
    verifiedDoneWhen: [...step.doneWhen],
    ...(step.authority === "ask_approval" ? { approvalResult: "approved" as const } : {}),
  };
}

function sameStepPassBinding(
  actual: Extract<SparkReproStepVerifierResult, { verdict: "Pass" }>,
  expected: Extract<SparkReproStepVerifierResult, { verdict: "Pass" }>,
): boolean {
  return (
    actual.planRevision === expected.planRevision &&
    actual.stepId === expected.stepId &&
    actual.definitionDigest === expected.definitionDigest &&
    actual.proofKind === expected.proofKind &&
    JSON.stringify(actual.evidenceRefs) === JSON.stringify(expected.evidenceRefs) &&
    JSON.stringify(actual.verifiedDoneWhen) === JSON.stringify(expected.verifiedDoneWhen) &&
    (expected.approvalResult === undefined || actual.approvalResult === "approved") &&
    (expected.proofKind === "approval"
      ? actual.approvalResult === "approved" &&
        JSON.stringify(actual.selectedValues) === JSON.stringify(["approve"])
      : true) &&
    (expected.proofKind === "evidence" ||
      (typeof actual.askRequestHash === "string" &&
        typeof actual.acceptedAnswerHash === "string" &&
        Array.isArray(actual.selectedValues) &&
        actual.selectedValues.length > 0))
  );
}

function normalizeGoalContractInput(
  input: SparkReproGoalContractInput,
): SparkReproGoalContractInput & { constraints: string[]; nonGoals: string[] } {
  return {
    objective: nonEmpty(input.objective, "goalContract.objective"),
    constraints: normalizeStrings(input.constraints ?? [], "goalContract.constraints"),
    nonGoals: normalizeStrings(input.nonGoals ?? [], "goalContract.nonGoals"),
    successCriteria: nonEmptyStrings(input.successCriteria, "goalContract.successCriteria"),
    evidenceRequired: nonEmptyStrings(input.evidenceRequired, "goalContract.evidenceRequired"),
  };
}

function goalContractDefinition(
  contract: SparkReproGoalContract,
): SparkReproGoalContractInput & { constraints: string[]; nonGoals: string[] } {
  return {
    objective: contract.objective,
    constraints: contract.constraints,
    nonGoals: contract.nonGoals,
    successCriteria: contract.successCriteria,
    evidenceRequired: contract.evidenceRequired,
  };
}

function normalizeSubgoalPlanInputs(
  inputs: readonly SparkReproSubgoalPlanInput[],
): SparkReproSubgoalPlanInput[] {
  const definitions = inputs.map(({ taskRef: _taskRef, ...definition }) => definition);
  const normalizedDefinitions = normalizeStepDefinitions(definitions);
  return normalizedDefinitions.map((definition, index) => {
    const taskRef = inputs[index]?.taskRef;
    if (taskRef && !isRef(taskRef, "task")) {
      throw new Error(`subgoals[${index}].taskRef must be a task: ref`);
    }
    return { ...definition, ...(taskRef ? { taskRef } : {}) };
  });
}

function upsertStepDefinitions(
  existing: readonly SparkReproStepDefinition[],
  updates: readonly SparkReproSubgoalPlanInput[],
): SparkReproStepDefinition[] {
  const updatedIds = new Set(updates.map((definition) => definition.id));
  return [
    ...existing.filter((definition) => !updatedIds.has(definition.id)),
    ...updates.map(({ taskRef: _taskRef, ...definition }) => definition),
  ];
}

function validateAndNormalizeStepDefinitions(
  repro: SparkSessionRepro,
  definitions: readonly SparkReproStepDefinition[],
): SparkReproStepDefinition[] {
  const normalized = normalizeStepDefinitions(definitions);
  const stageNames = new Set(repro.stages.map((stage) => stage.name));
  for (const [index, definition] of normalized.entries()) {
    if (!stageNames.has(definition.stage)) {
      throw new Error(`steps[${index}].stage is not a configured repro stage: ${definition.stage}`);
    }
  }
  const ids = new Set(normalized.map((definition) => definition.id));
  for (const step of normalized) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) throw new Error(`repro step ${step.id} cannot depend on itself`);
      if (!ids.has(dependency))
        throw new Error(`repro step ${step.id} depends on unknown step ${dependency}`);
    }
  }
  const stageIndexes = new Map(repro.stages.map((stage, index) => [stage.name, index]));
  const stepsById = new Map(normalized.map((step) => [step.id, step]));
  for (const step of normalized) {
    for (const dependency of step.dependsOn ?? []) {
      const dependencyStep = stepsById.get(dependency)!;
      if (stageIndexes.get(dependencyStep.stage)! > stageIndexes.get(step.stage)!) {
        throw new Error(`repro step ${step.id} cannot depend on later-stage step ${dependency}`);
      }
    }
  }
  assertAcyclicSteps(normalized);
  return normalized;
}

function normalizeStepDefinitions(
  definitions: readonly SparkReproStepDefinition[],
): SparkReproStepDefinition[] {
  if (definitions.length === 0) throw new Error("plan steps must not be empty");
  const ids = new Set<string>();
  const normalized = definitions.map((definition, index): SparkReproStepDefinition => {
    const prefix = `steps[${index}]`;
    const id = nonEmpty(definition.id, `${prefix}.id`);
    if (ids.has(id)) throw new Error(`duplicate repro step id: ${id}`);
    ids.add(id);
    if (
      definition.authority !== "safe_local" &&
      definition.authority !== "ask_decision" &&
      definition.authority !== "ask_approval"
    ) {
      throw new Error(`${prefix}.authority is invalid`);
    }
    return {
      id,
      stage: definition.stage,
      goal: nonEmpty(definition.goal, `${prefix}.goal`),
      doneWhen: nonEmptyStrings(definition.doneWhen, `${prefix}.doneWhen`),
      evidenceRequired: nonEmptyStrings(definition.evidenceRequired, `${prefix}.evidenceRequired`),
      authority: definition.authority,
      ...(definition.dependsOn
        ? {
            dependsOn: normalizeStrings(definition.dependsOn, `${prefix}.dependsOn`),
          }
        : {}),
    };
  });
  return normalized;
}

function assertAcyclicSteps(steps: readonly SparkReproStepDefinition[]): void {
  const dependencies = new Map(steps.map((step) => [step.id, step.dependsOn ?? []]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (active.has(id)) throw new Error(`repro plan dependency cycle includes ${id}`);
    active.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    active.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}

function sameStepDefinition(step: SparkReproStep, definition: SparkReproStepDefinition): boolean {
  return JSON.stringify(stepDefinition(step)) === JSON.stringify(definition);
}

function clearGoalContractProof(stages: readonly SparkReproStage[]): SparkReproStage[] {
  return stages.map((stage) => {
    let cleared = false;
    const acceptance = stage.acceptance.map((requirement): SparkReproRequirement => {
      if (requirement.id !== "repro-contract-frozen") return requirement;
      cleared = true;
      if (requirement.kind !== "evidence") return requirement;
      return { ...requirement, evidenceRefs: [] };
    });
    if (!cleared || !stage.gate) return { ...stage, acceptance };
    const { evaluation: _evaluation, ...gate } = stage.gate;
    return { ...stage, acceptance, gate };
  });
}

function nonEmptyStrings(values: readonly string[], field: string): string[] {
  const normalized = normalizeStrings(values, field);
  if (normalized.length === 0) throw new Error(`${field} must not be empty`);
  return normalized;
}

function normalizeStrings(values: readonly string[], field: string): string[] {
  return [...new Set(values.map((value, index) => nonEmpty(value, `${field}[${index}]`)))];
}

function normalizeDifficulty(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error("difficulty must be an integer from 1 to 10");
  }
  return value;
}

function evidenceRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproEvidenceRequirement {
  return { id, kind: "evidence", description, phase, evidenceRefs: [] };
}

function decisionRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproDecisionRequirement {
  return { id, kind: "decision", description, phase };
}

function validationRequirement(
  id: string,
  description: string,
  phase: SparkSessionPhase,
): SparkReproValidationRequirement {
  return { id, kind: "validation", description, phase };
}

function requirementWithProof(
  requirement: SparkReproRequirement,
  proof: SparkReproRequirementProof,
): SparkReproRequirement {
  switch (proof.kind) {
    case "evidence":
      if (requirement.kind !== "evidence") return requirement;
      if (proof.evidenceRefs.length === 0) throw new Error("evidence proof requires evidenceRefs");
      return {
        ...requirement,
        evidenceRefs: uniqueEvidenceRefs([...requirement.evidenceRefs, ...proof.evidenceRefs]),
      };
    case "decision":
      if (requirement.kind !== "decision") return requirement;
      return {
        ...requirement,
        decisionRef: evidenceRef(proof.decisionRef, "decisionRef"),
        selectedValue: nonEmpty(proof.selectedValue, "selectedValue"),
        ...(proof.rationale?.trim() ? { rationale: proof.rationale.trim() } : {}),
      };
    case "validation":
      if (requirement.kind !== "validation") return requirement;
      return {
        ...requirement,
        command: nonEmpty(proof.command, "command"),
        resultRef: evidenceRef(proof.resultRef, "resultRef"),
        passed: proof.passed,
      };
    default: {
      const exhaustive: never = proof;
      return exhaustive;
    }
  }
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  return [...new Set(refs.map((ref, index) => evidenceRef(ref, `evidenceRefs[${index}]`)))];
}

function evidenceRef(value: string, field: string): EvidenceRef {
  if (!value.startsWith("evidence:") || value.length === "evidence:".length) {
    throw new Error(`${field} must be an evidence: ref`);
  }
  return value as EvidenceRef;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}
