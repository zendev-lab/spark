import { createHash } from "node:crypto";

import { nowIso, stableId, type EvidenceRef } from "@zendev-lab/spark-core";
export * from "./driver-policy.ts";

export type SparkSessionPhase = "plan" | "implement";

export type SparkReproStageName = "setup" | "scaffold" | "reproduce" | "scale" | "deliver";

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

export type SparkReproStatus = "active" | "complete";

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

export type SparkReproGoalContractStatus = "draft" | "frozen";

export interface SparkReproGoalAuthority {
  safeLocal: "auto";
  externalWrites: "ask";
  destructiveActions: "ask";
  scopeExpansion: "ask";
}

export interface SparkReproGoalContract {
  status: SparkReproGoalContractStatus;
  objective: string;
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  evidenceRequired: string[];
  authority: SparkReproGoalAuthority;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  updatedAt: string;
  frozenAt?: string;
}

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
  minimumStepCount: number;
  steps: SparkReproStepDefinition[];
  createdAt: string;
}

export interface SparkReproPlan {
  currentRevision: number;
  difficulty: number;
  minimumStepCount: number;
  revisions: SparkReproPlanRevision[];
  steps: SparkReproStep[];
}

export type SparkReproStopDecision = "continue" | "ask" | "complete";

export interface SparkReproStopGuard {
  lastProgressDigest: string;
  stagnationCount: number;
  limit: number;
  decision: SparkReproStopDecision;
  lastSettledAt?: string;
}

export interface SparkSessionRepro {
  version: 4;
  reproId: string;
  sessionKey: string;
  status: SparkReproStatus;
  /** Compatibility projection of goalContract.objective. */
  objective?: string;
  goalContract: SparkReproGoalContract;
  plan: SparkReproPlan;
  stopGuard: SparkReproStopGuard;
  currentStageIndex: number;
  currentPhase: SparkSessionPhase;
  stages: SparkReproStage[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const DEFAULT_REPRO_STAGES: SparkReproStage[] = [
  {
    name: "setup",
    title: "Setup",
    phases: ["plan"],
    acceptance: [
      evidenceRequirement(
        "repro-contract-frozen",
        "Reproduction claim and acceptance contract frozen",
        "plan",
      ),
      evidenceRequirement(
        "competitor-baseline-availability-researched",
        "Runnable competitor/reference baseline availability verified (typically Megatron)",
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
    name: "scaffold",
    title: "Scaffold",
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
    name: "reproduce",
    title: "Reproduce",
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
    name: "scale",
    title: "Scale",
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
    name: "deliver",
    title: "Deliver",
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
  const stageName = currentReproStage(repro).name;
  const stageSteps = repro.plan.steps.filter((step) => step.stage === stageName);
  const planComplete =
    stageSteps.length > 0 &&
    stageSteps.every((step) => step.status === "done" || step.status === "cancelled");
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
  options: { objective?: string } = {},
): SparkSessionRepro {
  const resolvedStages = structuredClone(stages ?? DEFAULT_REPRO_STAGES);
  const firstPhase = resolvedStages[0]?.phases[0];
  if (!firstPhase) throw new Error("repro requires at least one stage with one phase");
  const objective = options.objective?.trim();
  const timestamp = nowIso();
  const reproWithoutDigest: SparkSessionRepro = {
    version: 4,
    reproId: crypto.randomUUID?.() ?? `repro-${Date.now()}`,
    sessionKey,
    status: "active",
    ...(objective ? { objective } : {}),
    goalContract: createGoalContract(objective, timestamp),
    plan: createInitialReproPlan(resolvedStages, timestamp),
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

export interface ReviseReproPlanInput {
  reason: string;
  difficulty?: number;
  goalContract?: SparkReproGoalContractInput;
  steps?: SparkReproStepDefinition[];
}

export function reviseReproPlan(
  repro: SparkSessionRepro,
  input: ReviseReproPlanInput,
): SparkSessionRepro {
  const reason = nonEmpty(input.reason, "reason");
  if (!input.goalContract && !input.steps && input.difficulty === undefined) {
    throw new Error("plan revision requires goalContract, difficulty, or steps");
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
  const minimumStepCount = reproStepBudget(difficulty);
  const normalizedSteps = input.steps
    ? validateAndNormalizeStepDefinitions(repro, input.steps, difficulty)
    : undefined;
  if (!normalizedSteps && repro.plan.steps.length < minimumStepCount) {
    throw new Error(
      `difficulty ${difficulty} requires at least ${minimumStepCount} plan steps; revise the steps in the same action`,
    );
  }
  const planChanged =
    normalizedSteps !== undefined ||
    difficulty !== repro.plan.difficulty ||
    minimumStepCount !== repro.plan.minimumStepCount;
  const nextRevision = repro.plan.currentRevision + (planChanged ? 1 : 0);
  const revisedSteps = normalizedSteps
    ? normalizedSteps.map((definition) => {
        const prior = repro.plan.steps.find((step) => step.id === definition.id);
        if (prior && sameStepDefinition(prior, definition)) {
          return { ...prior, ...definition };
        }
        return {
          ...definition,
          status: "pending" as const,
          evidenceRefs: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      })
    : repro.plan.steps;
  const steps = revisedSteps.map((step) => {
    const shouldReopen = planChanged && step.status === "done";
    const shouldClearContract = goalChanged && step.id === "repro-contract-frozen";
    if (!shouldReopen && !shouldClearContract) return step;
    const { blocker: _blocker, verification: _verification, ...stepWithoutRuntimeProof } = step;
    return {
      ...stepWithoutRuntimeProof,
      status: "pending" as const,
      evidenceRefs: shouldClearContract ? [] : step.evidenceRefs,
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
          minimumStepCount,
          steps: structuredClone(normalizedSteps ?? repro.plan.steps.map(stepDefinition)),
          createdAt: timestamp,
        },
      ]
    : repro.plan.revisions;
  const stages = goalChanged ? clearGoalContractProof(repro.stages) : repro.stages;
  return {
    ...repro,
    ...(normalizedGoal ? { objective: normalizedGoal.objective } : {}),
    goalContract: nextGoalContract,
    plan: {
      currentRevision: nextRevision,
      difficulty,
      minimumStepCount,
      revisions,
      steps,
    },
    stages,
    updatedAt: timestamp,
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
  return {
    ...repro,
    plan: { ...repro.plan, steps },
    updatedAt: timestamp,
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
    planRevision: repro.plan.currentRevision,
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

export function currentReproSteps(repro: SparkSessionRepro): SparkReproStep[] {
  const stageName = currentReproStage(repro).name;
  return repro.plan.steps.filter((step) => step.stage === stageName);
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

/**
 * Fail-closed normalization for a persisted v4 repro value.
 *
 * This is deliberately pure: persistence adapters may decide whether to write
 * the normalized value back, while read-only projections can safely consume it
 * without becoming a second durable-state writer.
 */
export function normalizeStoredSparkSessionRepro(value: unknown): SparkSessionRepro | undefined {
  if (!isStoredSparkSessionRepro(value)) return undefined;
  try {
    const repro = value;
    const stages = normalizeStoredReproStages(repro.stages);
    const contractRequirement = stages
      .flatMap((stage) => stage.acceptance)
      .find((requirement) => requirement.id === "repro-contract-frozen");
    const contractFrozen = contractRequirement
      ? isReproRequirementSatisfied(contractRequirement)
      : false;
    const contractEvidenceRefs = repro.goalContract.evidenceRefs.filter(isStoredEvidenceRef);
    const { frozenAt: _frozenAt, ...goalContractWithoutFrozenAt } = repro.goalContract;
    const goalContract = contractFrozen
      ? {
          ...repro.goalContract,
          status: "frozen" as const,
          evidenceRefs: contractEvidenceRefs,
        }
      : {
          ...goalContractWithoutFrozenAt,
          status: "draft" as const,
          evidenceRefs: [],
        };
    const steps = repro.plan.steps.map((step) => {
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
    const limit =
      Number.isInteger(repro.stopGuard.limit) && repro.stopGuard.limit > 0
        ? repro.stopGuard.limit
        : 3;
    const stagnationCount =
      Number.isInteger(repro.stopGuard.stagnationCount) && repro.stopGuard.stagnationCount >= 0
        ? repro.stopGuard.stagnationCount
        : 0;
    const normalized: SparkSessionRepro = {
      ...repro,
      stages,
      goalContract,
      plan: { ...repro.plan, steps },
      stopGuard: {
        ...repro.stopGuard,
        limit,
        stagnationCount,
      },
    };
    if (normalized.stopGuard.lastProgressDigest.trim()) return normalized;
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

export function reproProgressDigest(repro: SparkSessionRepro): string {
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
    minimumStepCount: repro.plan.minimumStepCount,
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
    verification.planRevision === repro.plan.currentRevision &&
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

function isStoredSparkSessionRepro(value: unknown): value is SparkSessionRepro {
  if (!isRecord(value) || value.version !== 4) return false;
  if (
    typeof value.reproId !== "string" ||
    typeof value.sessionKey !== "string" ||
    (value.status !== "active" && value.status !== "complete") ||
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
  if (!isRecord(value.stopGuard) || !isStoredStopGuard(value.stopGuard)) return false;
  const currentStageIndex = Number(value.currentStageIndex);
  return currentStageIndex >= 0 && currentStageIndex < value.stages.length;
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

function isStoredReproPlan(value: Record<string, unknown>): boolean {
  return (
    Number.isInteger(value.currentRevision) &&
    Number(value.currentRevision) > 0 &&
    Number.isInteger(value.difficulty) &&
    Number.isInteger(value.minimumStepCount) &&
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
    Number.isInteger(value.minimumStepCount) &&
    Array.isArray(value.steps) &&
    value.steps.every(isStoredReproStepDefinition) &&
    typeof value.createdAt === "string"
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
    (value.decision === "continue" || value.decision === "ask" || value.decision === "complete") &&
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
    value === "setup" ||
    value === "scaffold" ||
    value === "reproduce" ||
    value === "scale" ||
    value === "deliver"
  );
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
}

export function settleReproTick(repro: SparkSessionRepro): SparkReproSettleResult {
  const timestamp = nowIso();
  const digest = reproProgressDigest(repro);
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
    digest === repro.stopGuard.lastProgressDigest ? repro.stopGuard.stagnationCount + 1 : 0;
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
  return { repro: settled, decision };
}

export function migrateSparkSessionReproV3(repro: SparkSessionReproV3): SparkSessionRepro {
  const timestamp = repro.updatedAt || nowIso();
  const contractProof = repro.stages
    .flatMap((stage) => stage.acceptance)
    .find((requirement) => requirement.id === "repro-contract-frozen");
  const contractRefs = contractProof ? reproRequirementEvidenceRefs(contractProof) : [];
  const goalContract = createGoalContract(repro.objective?.trim(), repro.createdAt);
  const migratedWithoutDigest: SparkSessionRepro = {
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
    plan: createInitialReproPlan(repro.stages, timestamp),
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

function createGoalContract(
  objective: string | undefined,
  timestamp: string,
): SparkReproGoalContract {
  return {
    status: "draft",
    objective: objective || "Reproduce the target behavior with inspectable evidence",
    constraints: [
      "Preserve the fixed setup, scaffold, reproduce, scale, and deliver evidence gates",
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
  const minimumStepCount = reproStepBudget(difficulty);
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
    minimumStepCount,
    revisions: [
      {
        revision: 1,
        reason: "Seed plan from fixed repro evidence gates",
        difficulty,
        minimumStepCount,
        steps: steps.map(stepDefinition),
        createdAt: timestamp,
      },
    ],
    steps,
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
    planRevision: repro.plan.currentRevision,
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

function validateAndNormalizeStepDefinitions(
  repro: SparkSessionRepro,
  definitions: readonly SparkReproStepDefinition[],
  difficulty: number,
): SparkReproStepDefinition[] {
  const minimumStepCount = reproStepBudget(difficulty);
  if (definitions.length === 0) throw new Error("plan steps must not be empty");
  const stageNames = new Set(repro.stages.map((stage) => stage.name));
  const ids = new Set<string>();
  const normalized = definitions.map((definition, index): SparkReproStepDefinition => {
    const prefix = `steps[${index}]`;
    const id = nonEmpty(definition.id, `${prefix}.id`);
    if (ids.has(id)) throw new Error(`duplicate repro step id: ${id}`);
    ids.add(id);
    if (!stageNames.has(definition.stage)) {
      throw new Error(`${prefix}.stage is not a configured repro stage: ${definition.stage}`);
    }
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
  for (const step of normalized) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) {
        throw new Error(`repro step ${step.id} cannot depend on itself`);
      }
      if (!ids.has(dependency)) {
        throw new Error(`repro step ${step.id} depends on unknown step ${dependency}`);
      }
    }
  }
  for (const stageName of stageNames) {
    if (!normalized.some((step) => step.stage === stageName)) {
      throw new Error(`repro plan requires at least one step for stage ${stageName}`);
    }
  }
  if (normalized.length < minimumStepCount) {
    throw new Error(`difficulty ${difficulty} requires at least ${minimumStepCount} plan steps`);
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

export function reproStepBudget(difficulty: number): number {
  const normalized = normalizeDifficulty(difficulty);
  if (normalized <= 2) return 4;
  if (normalized <= 4) return 6;
  if (normalized <= 6) return 8;
  if (normalized <= 8) return 11;
  return 13;
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
