import { createHash } from "node:crypto";

import {
  isRef,
  type ArtifactRef,
  type AskRef,
  type EvidenceRef,
  type TaskRef,
} from "@zendev-lab/spark-core";

export const SPARK_REPRO_WORK_SUMMARY_SCHEMA = "spark.repro.work-summary/v2" as const;
export const SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA = "spark.repro.work-summary/v1" as const;

export const SPARK_REPRO_WORK_STAGES = [
  "contract",
  "reference",
  "target",
  "alignment",
  "delivery",
] as const;

export type SparkReproWorkStage = (typeof SPARK_REPRO_WORK_STAGES)[number];

export const SPARK_REPRO_STAGE_WEIGHTS = {
  contract: 5,
  reference: 10,
  target: 25,
  alignment: 55,
  delivery: 5,
} as const satisfies Record<SparkReproWorkStage, number>;

export type SparkReproWorkStatus = "active" | "waiting_decision" | "complete";
export type SparkReproSchedulerActivity = "running" | "ready" | "dormant" | "sealed";
export type SparkReproModelScope = "minimum_complete" | "reduced" | "probe" | "full";
export type SparkReproComputeScope = "forward" | "backward" | "optimizer" | "checkpoint";
export type SparkReproDistributedStrategy = "dp" | "tp" | "pp" | "ep" | "etp" | "cp" | "sp";
export type SparkReproStrategySource = "official" | "reference";

export const SPARK_REPRO_MODEL_SCOPES = ["probe", "reduced", "minimum_complete", "full"] as const;
export const SPARK_REPRO_COMPUTE_SCOPES = [
  "forward",
  "backward",
  "optimizer",
  "checkpoint",
] as const;
export const SPARK_REPRO_DISTRIBUTED_STRATEGIES = [
  "dp",
  "tp",
  "pp",
  "ep",
  "etp",
  "cp",
  "sp",
] as const;

export interface SparkReproStrategyEntry {
  axis: SparkReproDistributedStrategy;
  id: string;
  source: SparkReproStrategySource;
  revision: string;
  configDigest: string;
}

/**
 * The optional v2 fields keep TypeScript source compatibility for v1 callers.
 * A v2 profile is accepted only by validateSparkReproProfile(..., { requireVNext: true })
 * when etp, worldSize, strategies, canonical aliases, and runtime are all present.
 */
export interface SparkReproTopology {
  dp: number;
  tp: number;
  pp: number;
  ep: number;
  etp?: number;
  cp: number;
  sp: boolean;
  worldSize?: number;
  strategies?: SparkReproStrategyEntry[];
  /** Fields synthesized only for legacy read compatibility; strict v2 rejects them. */
  unknownFields?: Array<"etp" | "worldSize" | "strategies">;
}

export const SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY: SparkReproTopology = {
  dp: 1,
  tp: 1,
  pp: 1,
  ep: 1,
  etp: 1,
  cp: 1,
  sp: false,
  worldSize: 1,
  strategies: [],
};

export interface SparkReproRuntimeProfile {
  framework: string;
  device: string;
  dtype: string;
  hardware: string;
  modelRevision: string;
  configDigest: string;
}

export interface SparkReproProfile {
  id: string;
  /** @deprecated v1 compatibility alias for modelScope. */
  model: SparkReproModelScope;
  /** @deprecated v1 compatibility alias for computeScope. */
  compute: SparkReproComputeScope;
  modelScope?: SparkReproModelScope;
  computeScope?: SparkReproComputeScope;
  steps: {
    completed: number;
    target: number;
  };
  /** @deprecated v1 compatibility alias for validationTopology. */
  topology: SparkReproTopology;
  validationTopology?: SparkReproTopology;
  runtime?: SparkReproRuntimeProfile;
  /** Fields synthesized only for legacy read compatibility; strict v2 rejects them. */
  unknownFields?: Array<"runtime">;
}

export type SparkReproDecisionKind =
  | "contract_change"
  | "reference_choice"
  | "scope_expansion"
  | "resource_change"
  | "global_behavior_change"
  | "external_publish";

const SPARK_REPRO_DECISION_KINDS = [
  "contract_change",
  "reference_choice",
  "scope_expansion",
  "resource_change",
  "global_behavior_change",
  "external_publish",
] as const;

export interface SparkReproDecisionOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** A still-pending typed decision. Resolved decisions belong in evidence/history. */
export interface SparkReproDecisionRequest {
  id: string;
  status: "pending";
  kind: SparkReproDecisionKind;
  question: string;
  options: SparkReproDecisionOption[];
  blockedTransition: {
    from: SparkReproWorkStage;
    to: SparkReproWorkStage;
  };
  evidenceRefs: EvidenceRef[];
  /** Typed Hub action target; Markdown may render this ref but never dispatch it. */
  askRef: AskRef;
}

export interface SparkReproOperatorLocation {
  step: number;
  boundary: string;
  layer?: string;
  module?: string;
  operator?: string;
  tensor?: string;
  rank?: number;
}

export type SparkReproExperimentStatus = "queued" | "running" | "passed" | "failed";

/** Legacy compact experiment shape retained as a read adapter. */
export interface SparkReproExperiment {
  id: string;
  status: SparkReproExperimentStatus;
  profile: SparkReproProfile;
  hypothesis: string;
  singleVariable: string;
  expectedOutcome: string;
  falsificationOutcome: string;
  command?: string;
  evidenceRefs: EvidenceRef[];
}

/** Legacy compact frontier retained as a read adapter. */
export interface SparkReproFrontier {
  stage: SparkReproWorkStage;
  profile: SparkReproProfile;
  lastGood?: SparkReproOperatorLocation;
  firstBad?: SparkReproOperatorLocation;
  activeExperiment?: SparkReproExperiment;
  blocker?: string;
}

export interface SparkReproExploreFrontier {
  stage: SparkReproWorkStage;
  profile: SparkReproProfile;
  planRevision: number;
  observationId?: string;
  ownerStepId?: string;
  stepDefinitionDigest?: string;
  evidenceRefs: EvidenceRef[];
  unresolvedIds: string[];
}

export type SparkReproCandidateVerdict = "candidate" | "accepted" | "rejected" | "stale";

export interface SparkReproRetirementCandidate {
  id: string;
  stepId: string;
  dependsOn: string[];
  planRevision: number;
  stepDefinitionDigest: string;
  verdict: SparkReproCandidateVerdict;
  profile: SparkReproProfile;
  evidenceRefs: EvidenceRef[];
  unresolvedIds: string[];
}

export interface SparkReproRetirementRecord {
  stepId: string;
  candidateId: string;
  planRevision: number;
  stepDefinitionDigest: string;
  profile: SparkReproProfile;
  profileDigest: string;
  evidenceRefs: EvidenceRef[];
}

export interface SparkReproNormativeCursor {
  planRevision: number;
  orderedStepIds: string[];
  stepDefinitionDigests?: Record<string, string>;
  stepDependencies?: Record<string, string[]>;
  currentStepId?: string;
  retiredStepIds: string[];
  candidateBuffer: SparkReproRetirementCandidate[];
  retirementLog: SparkReproRetirementRecord[];
}

export type SparkReproUnresolvedKind =
  | "bridge"
  | "adapter"
  | "fallback"
  | "stub"
  | "assumption"
  | "mismatch";
export type SparkReproUnresolvedStatus = "open" | "discharged" | "superseded";

export interface SparkReproUnresolvedItem {
  id: string;
  kind: SparkReproUnresolvedKind;
  owner: string;
  impact: string;
  reversible: boolean;
  rollback: string;
  dischargeCriterion: string;
  status: SparkReproUnresolvedStatus;
  completionRequired: boolean;
  planRevision: number;
  ownerStepId: string;
  stepDefinitionDigest: string;
  evidenceRefs: EvidenceRef[];
  supersededBy?: string;
}

export type SparkReproRetirementBlockKind =
  | "decision"
  | "approval"
  | "dependency"
  | "verification"
  | "unresolved";

export interface SparkReproRetirementBlock {
  id: string;
  kind: SparkReproRetirementBlockKind;
  ownerStepId: string;
  reason: string;
  askRef?: AskRef;
  unresolvedId?: string;
}

export type SparkReproInvocationClass = "owning_entrypoint" | "isolated_diagnostic";
export type SparkReproValidationEvidenceClass = "entrypoint" | "probe";
export type SparkReproValidationVerdict = "open" | "accepted" | "rejected";

export interface SparkReproValidationMatrixRow {
  id: string;
  gateId: string;
  stage: SparkReproWorkStage;
  invocationClass: SparkReproInvocationClass;
  evidenceClass: SparkReproValidationEvidenceClass;
  verdict: SparkReproValidationVerdict;
  profile: SparkReproProfile;
  repetitions: number;
  exactScope: string;
  command?: string;
  receiptPath?: string;
  evidenceRefs: EvidenceRef[];
  artifactRefs: ArtifactRef[];
}

export interface SparkReproValidationMatrix {
  denominators: Record<SparkReproWorkStage, number | null>;
  rows: SparkReproValidationMatrixRow[];
}

export type SparkReproBoundaryClaim =
  | { status: "established"; location: SparkReproOperatorLocation; evidenceRefs: EvidenceRef[] }
  | { status: "not_established"; reason: string; evidenceRefs: EvidenceRef[] };

export type SparkReproNumericalClaimLevel =
  | "native_module_boundary"
  | "derived_reference_boundary"
  | "native_internal_boundary";

export type SparkReproQuantifiedInventory =
  | { quantified: true; tensors: number; elements: number }
  | { quantified: false; reason: string };

export interface SparkReproExactCoverage {
  quantified: boolean;
  tensors: number | null;
  elements: number | null;
  steps: number | null;
  topology: SparkReproTopology;
}

export interface SparkReproNumericalDifference {
  maxAbsDiff: number | null;
  maxUlp: number | null;
  signedZeroEqual: boolean | null;
}

export interface SparkReproNumericalFrontier {
  claims: Record<SparkReproNumericalClaimLevel, "established" | "not_established">;
  lastGood: SparkReproBoundaryClaim;
  firstBad: SparkReproBoundaryClaim;
  equalityRule: "raw_bits" | "normalized_hash" | "tolerance";
  comparedInventory: SparkReproQuantifiedInventory;
  exactCoverage: SparkReproExactCoverage;
  difference: SparkReproNumericalDifference;
  activeBlocker: string;
}

export interface SparkReproActiveExperiment {
  id: string;
  status: "queued" | "running";
  evidenceClass: SparkReproValidationEvidenceClass;
  profile: SparkReproProfile;
  hypothesis: string;
  onlyVariable: string;
  command: string;
  repetitions: number;
  expectedResult: string;
  falsifier: string;
  stopCondition: string;
  outputEvidencePaths: string[];
  evidenceRefs: EvidenceRef[];
}

export interface SparkReproNextAction {
  id: string;
  summary: string;
  passCriterion: string;
}

export type SparkReproTaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface SparkReproWorkTask {
  id: string;
  title: string;
  stage: SparkReproWorkStage;
  status: SparkReproTaskStatus;
  summary?: string;
  taskRef?: TaskRef;
}

export type SparkReproTodoStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export interface SparkReproTodo {
  id: string;
  content: string;
  status: SparkReproTodoStatus;
  taskId?: string;
}

export type SparkReproEvidenceClass = "formal" | "diagnostic";
export type SparkReproEvidenceGateStatus = "open" | "accepted" | "rejected";
export type SparkReproTechnicalCriterion =
  | "reference_ready"
  | "target_ready"
  | "required_steps_aligned"
  | "reference_parity";

export interface SparkReproEvidenceGate {
  id: string;
  title: string;
  stage: SparkReproWorkStage;
  evidenceClass: SparkReproEvidenceClass;
  status: SparkReproEvidenceGateStatus;
  /** Relative weight within one stage. Stage weights remain fixed. */
  weight: number;
  evidenceRefs: EvidenceRef[];
  profile?: SparkReproProfile;
  establishes?: SparkReproTechnicalCriterion[];
}

export type SparkReproConclusionVerdict = "confirmed" | "rejected" | "inconclusive" | "superseded";

export interface SparkReproConclusion {
  id: string;
  claim: string;
  verdict: SparkReproConclusionVerdict;
  profile: SparkReproProfile;
  evidenceRefs: EvidenceRef[];
}

export interface SparkReproTechnicalTarget {
  model: "minimum_complete";
  requiredSteps: number;
  /** The complete distributed capability target: parity only, with no extra strategies. */
  referenceStrategies: SparkReproDistributedStrategy[];
  /** Frozen acceptance topology. One formal run must establish parity at this exact topology. */
  validationTopology: SparkReproTopology;
  /** v2 freezes one exact profile. Legacy callers may omit it and use input.profile. */
  acceptanceProfile?: SparkReproProfile;
}

export interface SparkReproStageProgress {
  stage: SparkReproWorkStage;
  stageWeight: number;
  acceptedGateWeight: number;
  totalGateWeight: number | null;
  acceptedGateIds: string[];
  percent: number | null;
  contribution: number | null;
}

export interface SparkReproProgress {
  quantified: boolean;
  percent: number | null;
  stages: SparkReproStageProgress[];
}

export interface SparkReproTechnicalGoal {
  achieved: boolean;
  checks: {
    minimumCompleteReferenceReady: boolean;
    minimumCompleteTargetReady: boolean;
    requiredStepsAligned: boolean;
    referenceParity: boolean;
  };
  alignedSteps: number;
  requiredSteps: number;
  validatedReferenceStrategies: SparkReproDistributedStrategy[];
  requiredReferenceStrategies: SparkReproDistributedStrategy[];
  missing: Array<keyof SparkReproTechnicalGoal["checks"]>;
}

export interface SparkReproWorkSummaryMigration {
  sourceSchema: typeof SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA;
  revision: 1;
  legacyProofAuthority: "not_promoted";
}

export interface SparkReproWorkSummaryInput {
  schema?: typeof SPARK_REPRO_WORK_SUMMARY_SCHEMA;
  migration?: SparkReproWorkSummaryMigration;
  reproId: string;
  title: string;
  stage: SparkReproWorkStage;
  target: SparkReproTechnicalTarget;
  profile: SparkReproProfile;
  gates: SparkReproEvidenceGate[];
  pendingDecisions?: SparkReproDecisionRequest[];
  frontier?: SparkReproFrontier;
  exploreFrontier?: SparkReproExploreFrontier;
  normativeCursor?: SparkReproNormativeCursor;
  schedulerActivity?: SparkReproSchedulerActivity;
  independentReadyCount?: number;
  retirementBlocks?: number | SparkReproRetirementBlock[];
  unresolved?: SparkReproUnresolvedItem[];
  validationMatrix?: SparkReproValidationMatrix;
  numericalFrontier?: SparkReproNumericalFrontier;
  nextAction?: SparkReproNextAction;
  activeExperiment?: SparkReproActiveExperiment;
  tasks?: SparkReproWorkTask[];
  todos?: SparkReproTodo[];
  conclusions?: SparkReproConclusion[];
  artifactRefs?: ArtifactRef[];
  /** Stable per-run Markdown report Document binding. */
  reportArtifactRef?: ArtifactRef;
}

/** Canonical cross-surface write model; legacy session state is an input adapter concern. */
export interface SparkReproWorkSummary {
  schema: typeof SPARK_REPRO_WORK_SUMMARY_SCHEMA;
  migration?: SparkReproWorkSummaryMigration;
  reproId: string;
  title: string;
  status: SparkReproWorkStatus;
  schedulerActivity: SparkReproSchedulerActivity;
  independentReadyCount: number;
  stage: SparkReproWorkStage;
  target: SparkReproTechnicalTarget;
  profile: SparkReproProfile;
  acceptanceProfile: SparkReproProfile;
  progress: SparkReproProgress;
  formalProgress: SparkReproProgress;
  technicalGoal: SparkReproTechnicalGoal;
  exploreFrontier: SparkReproExploreFrontier;
  normativeCursor: SparkReproNormativeCursor;
  retirementBlocks: number;
  retirementBlockers: SparkReproRetirementBlock[];
  unresolved: SparkReproUnresolvedItem[];
  validationMatrix: SparkReproValidationMatrix;
  numericalFrontier: SparkReproNumericalFrontier;
  nextAction: SparkReproNextAction;
  activeExperiment?: SparkReproActiveExperiment;
  pendingDecisions: SparkReproDecisionRequest[];
  gates: SparkReproEvidenceGate[];
  tasks: SparkReproWorkTask[];
  todos: SparkReproTodo[];
  conclusions: SparkReproConclusion[];
  artifactRefs: ArtifactRef[];
  reportArtifactRef?: ArtifactRef;
  /** @deprecated v1 compact compatibility projection. */
  frontier?: SparkReproFrontier;
}

export function buildSparkReproWorkSummary(
  input: SparkReproWorkSummaryInput,
): SparkReproWorkSummary {
  assertNonEmpty(input.reproId, "reproId");
  assertNonEmpty(input.title, "title");
  assertOneOf(input.stage, SPARK_REPRO_WORK_STAGES, "stage");
  const migration = input.migration;
  const outputMigration: SparkReproWorkSummaryMigration | undefined =
    migration ??
    (input.schema === undefined
      ? {
          sourceSchema: SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
          revision: 1,
          legacyProofAuthority: "not_promoted",
        }
      : undefined);
  const strictVNext = input.schema === SPARK_REPRO_WORK_SUMMARY_SCHEMA && migration === undefined;
  if (migration) {
    if (
      migration.sourceSchema !== SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA ||
      migration.revision !== 1 ||
      migration.legacyProofAuthority !== "not_promoted"
    ) {
      throw new Error("work-summary migration binding is invalid");
    }
  }
  validateTechnicalTarget(input.target, strictVNext);

  validateSparkReproProfile(input.profile, input.target, {
    requireVNext: strictVNext,
    field: "profile",
  });
  const profile = canonicalProfile(input.profile);
  const rawAcceptanceProfile = input.target.acceptanceProfile ?? input.profile;
  validateSparkReproProfile(rawAcceptanceProfile, input.target, {
    requireVNext: strictVNext,
    field: "acceptanceProfile",
  });
  const acceptanceProfile = canonicalProfile(rawAcceptanceProfile);
  if (acceptanceProfile.modelScope !== "minimum_complete") {
    throw new Error("acceptanceProfile.modelScope must be minimum_complete in work-summary/v2");
  }
  if (strictVNext) {
    if (acceptanceProfile.computeScope !== "optimizer") {
      throw new Error("acceptanceProfile.computeScope must be optimizer in work-summary/v2");
    }
    if (
      acceptanceProfile.steps.completed !== input.target.requiredSteps ||
      acceptanceProfile.steps.target !== input.target.requiredSteps
    ) {
      throw new Error("acceptanceProfile steps must equal target.requiredSteps");
    }
    if (!topologyEquals(acceptanceProfile.validationTopology!, input.target.validationTopology)) {
      throw new Error("acceptanceProfile topology must equal target.validationTopology");
    }
  }

  for (const [index, gate] of input.gates.entries()) {
    validateGate(gate, input.target, `gates[${index}]`, strictVNext);
  }
  const gates = input.gates.map(cloneGate);
  validateUniqueIds(gates, "gates");

  const pendingDecisions = (input.pendingDecisions ?? []).map(cloneDecision);
  validateUniqueIds(pendingDecisions, "pendingDecisions");
  for (const [index, decision] of pendingDecisions.entries()) {
    validateDecision(decision, `pendingDecisions[${index}]`);
  }

  const tasks = (input.tasks ?? []).map((task) => ({ ...task }));
  validateUniqueIds(tasks, "tasks");
  for (const [index, task] of tasks.entries()) validateTask(task, index);

  const todos = (input.todos ?? []).map((todo) => ({ ...todo }));
  validateUniqueIds(todos, "todos");
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const [index, todo] of todos.entries()) validateTodo(todo, index, taskIds);

  const rawConclusions = input.conclusions ?? [];
  for (const [index, conclusion] of rawConclusions.entries()) {
    validateSparkReproProfile(conclusion.profile, input.target, {
      requireVNext: strictVNext,
      field: `conclusions[${index}].profile`,
    });
  }
  const conclusions = rawConclusions.map(cloneConclusion);
  validateUniqueIds(conclusions, "conclusions");
  for (const [index, conclusion] of conclusions.entries()) {
    assertNonEmpty(conclusion.claim, `conclusions[${index}].claim`);
    assertOneOf(
      conclusion.verdict,
      ["confirmed", "rejected", "inconclusive", "superseded"] as const,
      `conclusions[${index}].verdict`,
    );
    validateSparkReproProfile(conclusion.profile, input.target, {
      requireVNext: strictVNext,
      field: `conclusions[${index}].profile`,
    });
    validateEvidenceRefs(conclusion.evidenceRefs, `conclusions[${index}].evidenceRefs`);
    if (
      (conclusion.verdict === "confirmed" || conclusion.verdict === "rejected") &&
      conclusion.evidenceRefs.length === 0
    ) {
      throw new Error(`conclusions[${index}] requires evidence for ${conclusion.verdict}`);
    }
  }

  if (input.frontier) validateFrontier(input.frontier, input.stage, input.target, strictVNext);
  const frontier = input.frontier ? cloneFrontier(input.frontier) : undefined;
  if (frontier) validateFrontier(frontier, input.stage, input.target, strictVNext);
  const rawExploreFrontier = input.exploreFrontier ?? legacyExploreFrontier(input, profile);
  validateExploreFrontier(rawExploreFrontier, input.target, strictVNext);
  const exploreFrontier = cloneExploreFrontier(rawExploreFrontier);

  const rawNormativeCursor =
    input.normativeCursor ?? emptyNormativeCursor(exploreFrontier.planRevision);
  validateNormativeCursor(rawNormativeCursor, input.target, acceptanceProfile, strictVNext);
  const normativeCursor = cloneNormativeCursor(rawNormativeCursor);

  const unresolved = (input.unresolved ?? []).map(cloneUnresolved);
  validateUniqueIds(unresolved, "unresolved");
  for (const [index, item] of unresolved.entries()) {
    validateUnresolved(item, index);
    validateUnresolvedCursorBinding(item, normativeCursor, index, strictVNext);
  }
  validateUnresolvedSupersessionGraph(unresolved);
  validateExploreCursorBinding(exploreFrontier, normativeCursor, unresolved, strictVNext);

  const retirementBlockers = normalizeRetirementBlocks(input.retirementBlocks, pendingDecisions);
  validateUniqueIds(retirementBlockers, "retirementBlockers");
  for (const [index, block] of retirementBlockers.entries()) validateRetirementBlock(block, index);

  if (strictVNext && !input.validationMatrix) {
    throw new Error("validationMatrix is required for strict work-summary/v2");
  }
  const validationMatrix = outputMigration
    ? migrationValidationMatrix(gates, acceptanceProfile)
    : input.validationMatrix
      ? (() => {
          validateValidationMatrix(input.validationMatrix!, input.gates, input.target, strictVNext);
          return cloneValidationMatrix(input.validationMatrix!);
        })()
      : compatibilityValidationMatrix(gates, acceptanceProfile);
  if (!input.validationMatrix) {
    validateValidationMatrix(validationMatrix, gates, input.target, strictVNext);
  }

  const rawNumericalFrontier =
    input.numericalFrontier ?? unknownNumericalFrontier(profile.validationTopology!);
  validateNumericalFrontier(rawNumericalFrontier, input.target, strictVNext);
  const numericalFrontier = cloneNumericalFrontier(rawNumericalFrontier);

  if (input.activeExperiment) {
    validateActiveExperiment(input.activeExperiment, input.target, strictVNext);
  }
  const activeExperiment = input.activeExperiment
    ? cloneActiveExperiment(input.activeExperiment)
    : undefined;

  const nextAction = { ...(input.nextAction ?? unknownNextAction(normativeCursor)) };
  validateNextAction(nextAction);

  const artifactRefs = uniqueArtifactRefs([
    ...(input.reportArtifactRef ? [input.reportArtifactRef] : []),
    ...(input.artifactRefs ?? []),
  ]);
  if (input.reportArtifactRef) validateArtifactRef(input.reportArtifactRef, "reportArtifactRef");

  const progress = calculateSparkReproProgress(gates, validationMatrix, acceptanceProfile);
  const technicalGoal = deriveSparkReproTechnicalGoal(
    input.target,
    gates,
    new Set(progress.stages.flatMap((stage) => stage.acceptedGateIds)),
  );
  const independentReadyCount = input.independentReadyCount ?? 0;
  assertNonNegativeInteger(independentReadyCount, "independentReadyCount");

  const allTasksTerminal = tasks.every(
    (task) => task.status === "done" || task.status === "cancelled",
  );
  const completionRequiredUnresolved = unresolved.filter(
    (item) => item.completionRequired && !isUnresolvedChainDischarged(item, unresolved),
  );
  const normativeComplete =
    normativeCursor.currentStepId === undefined &&
    normativeCursor.retiredStepIds.length === normativeCursor.orderedStepIds.length;
  const completeCandidate =
    input.stage === "delivery" &&
    normativeComplete &&
    progress.quantified &&
    progress.percent === 100 &&
    technicalGoal.achieved &&
    retirementBlockers.length === 0 &&
    completionRequiredUnresolved.length === 0 &&
    activeExperiment === undefined &&
    allTasksTerminal;
  const humanRetirementBlocks = retirementBlockers.filter(
    (block) => block.kind === "decision" || block.kind === "approval",
  );
  const status: SparkReproWorkStatus = completeCandidate
    ? "complete"
    : humanRetirementBlocks.length > 0
      ? "waiting_decision"
      : "active";
  const schedulerActivity = deriveSchedulerActivity(
    input.schedulerActivity,
    status,
    independentReadyCount,
    tasks,
    activeExperiment,
  );

  return {
    schema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
    ...(outputMigration ? { migration: { ...outputMigration } } : {}),
    reproId: input.reproId.trim(),
    title: input.title.trim(),
    status,
    schedulerActivity,
    independentReadyCount,
    stage: input.stage,
    target: cloneTechnicalTarget(input.target, acceptanceProfile),
    profile,
    acceptanceProfile,
    progress,
    formalProgress: structuredClone(progress),
    technicalGoal,
    exploreFrontier,
    normativeCursor,
    retirementBlocks: retirementBlockers.length,
    retirementBlockers,
    unresolved,
    validationMatrix,
    numericalFrontier,
    nextAction,
    ...(activeExperiment ? { activeExperiment } : {}),
    pendingDecisions,
    gates,
    tasks,
    todos,
    conclusions,
    artifactRefs,
    ...(input.reportArtifactRef ? { reportArtifactRef: input.reportArtifactRef } : {}),
    ...(frontier ? { frontier } : {}),
  };
}

export function calculateSparkReproProgress(
  gates: readonly SparkReproEvidenceGate[],
  validationMatrix?: SparkReproValidationMatrix,
  acceptanceProfile?: SparkReproProfile,
): SparkReproProgress {
  const matrix = validationMatrix;
  const acceptedRowGateIds = matrix
    ? new Set(
        matrix.rows
          .filter(
            (row) =>
              row.evidenceClass === "entrypoint" &&
              row.verdict === "accepted" &&
              (row.exactScope === "compatibility gate projection" ||
                !acceptanceProfile ||
                profileMatchesAcceptance(row.profile, acceptanceProfile)),
          )
          .map((row) => row.gateId),
      )
    : undefined;
  const stages = SPARK_REPRO_WORK_STAGES.map((stage): SparkReproStageProgress => {
    const eligible = gates.filter((gate) => gate.stage === stage && gateCountsTowardProgress(gate));
    const totalGateWeight = matrix
      ? matrix.denominators[stage]
      : eligible.reduce((total, gate) => total + gate.weight, 0);
    if (!matrix && totalGateWeight === 0) {
      throw new Error(`stage ${stage} requires at least one formal minimum-complete gate`);
    }
    const accepted = eligible.filter(
      (gate) =>
        gate.status === "accepted" && (!acceptedRowGateIds || acceptedRowGateIds.has(gate.id)),
    );
    const acceptedGateWeight = accepted.reduce((total, gate) => total + gate.weight, 0);
    const stageWeight = SPARK_REPRO_STAGE_WEIGHTS[stage];
    if (totalGateWeight === null) {
      return {
        stage,
        stageWeight,
        acceptedGateWeight,
        totalGateWeight: null,
        acceptedGateIds: accepted.map((gate) => gate.id),
        percent: null,
        contribution: null,
      };
    }
    if (!Number.isFinite(totalGateWeight) || totalGateWeight <= 0) {
      throw new Error(`validationMatrix.denominators.${stage} must be positive or null`);
    }
    if (acceptedGateWeight > totalGateWeight) {
      throw new Error(`accepted ${stage} gate weight exceeds the frozen denominator`);
    }
    const fraction = acceptedGateWeight / totalGateWeight;
    return {
      stage,
      stageWeight,
      acceptedGateWeight,
      totalGateWeight,
      acceptedGateIds: accepted.map((gate) => gate.id),
      percent: roundPercent(fraction * 100),
      contribution: roundPercent(fraction * stageWeight),
    };
  });
  const quantified = stages.every((stage) => stage.contribution !== null);
  return {
    quantified,
    percent: quantified
      ? roundPercent(stages.reduce((total, stage) => total + (stage.contribution ?? 0), 0))
      : null,
    stages,
  };
}

export function deriveSparkReproTechnicalGoal(
  target: SparkReproTechnicalTarget,
  gates: readonly SparkReproEvidenceGate[],
  acceptedGateIds?: ReadonlySet<string>,
): SparkReproTechnicalGoal {
  const accepted = gates.filter(
    (gate) =>
      gate.status === "accepted" &&
      gateCountsTowardProgress(gate) &&
      (!acceptedGateIds || acceptedGateIds.has(gate.id)),
  );
  const establishes = (criterion: SparkReproTechnicalCriterion) =>
    accepted.filter((gate) => gate.establishes?.includes(criterion));
  const referenceReady = establishes("reference_ready").some(hasMinimumCompleteTrainingStep);
  const targetReady = establishes("target_ready").some(hasMinimumCompleteTrainingStep);
  const alignedSteps = Math.max(
    0,
    ...establishes("required_steps_aligned")
      .filter(hasMinimumCompleteOptimizerProfile)
      .map((gate) => gate.profile!.steps.completed),
  );
  const parityGate = establishes("reference_parity").find(
    (gate) =>
      hasMinimumCompleteTrainingStep(gate) &&
      topologyEquals(profileTopology(gate.profile!), target.validationTopology),
  );
  const validatedReferenceStrategies = parityGate
    ? activeTopologyStrategies(profileTopology(parityGate.profile!))
    : [];
  const referenceParity = target.referenceStrategies.length === 0 || parityGate !== undefined;
  const checks = {
    minimumCompleteReferenceReady: referenceReady,
    minimumCompleteTargetReady: targetReady,
    requiredStepsAligned: alignedSteps >= target.requiredSteps,
    referenceParity,
  };
  const missing = (Object.keys(checks) as Array<keyof typeof checks>).filter(
    (check) => !checks[check],
  );
  return {
    achieved: missing.length === 0,
    checks,
    alignedSteps,
    requiredSteps: target.requiredSteps,
    validatedReferenceStrategies,
    requiredReferenceStrategies: orderedStrategies(target.referenceStrategies),
    missing,
  };
}

export function sparkReproCompletionEvidenceRefs(work: SparkReproWorkSummary): EvidenceRef[] {
  const acceptedGateIds = new Set(work.progress.stages.flatMap((stage) => stage.acceptedGateIds));
  return uniqueEvidenceRefs([
    ...work.gates
      .filter(
        (gate) =>
          gate.evidenceClass === "formal" &&
          gate.status === "accepted" &&
          acceptedGateIds.has(gate.id),
      )
      .flatMap((gate) => gate.evidenceRefs),
    ...work.validationMatrix.rows
      .filter(
        (row) =>
          row.evidenceClass === "entrypoint" &&
          row.invocationClass === "owning_entrypoint" &&
          row.verdict === "accepted" &&
          acceptedGateIds.has(row.gateId),
      )
      .flatMap((row) => row.evidenceRefs),
    ...work.normativeCursor.retirementLog.flatMap((record) => record.evidenceRefs),
    ...work.unresolved
      .filter((item) => item.status === "discharged")
      .flatMap((item) => item.evidenceRefs),
  ]);
}

export function validateSparkReproProfile(
  profile: SparkReproProfile,
  target: SparkReproTechnicalTarget,
  options: { requireVNext?: boolean; field?: string } = {},
): void {
  const field = options.field ?? "profile";
  assertNonEmpty(profile.id, `${field}.id`);
  assertOneOf(profile.model, SPARK_REPRO_MODEL_SCOPES, `${field}.model`);
  assertOneOf(profile.compute, SPARK_REPRO_COMPUTE_SCOPES, `${field}.compute`);
  if (profile.modelScope !== undefined) {
    assertOneOf(profile.modelScope, SPARK_REPRO_MODEL_SCOPES, `${field}.modelScope`);
    if (profile.modelScope !== profile.model) {
      throw new Error(`${field}.modelScope must match the v1 model alias`);
    }
  }
  if (profile.computeScope !== undefined) {
    assertOneOf(profile.computeScope, SPARK_REPRO_COMPUTE_SCOPES, `${field}.computeScope`);
    if (profile.computeScope !== profile.compute) {
      throw new Error(`${field}.computeScope must match the v1 compute alias`);
    }
  }
  assertNonNegativeInteger(profile.steps.completed, `${field}.steps.completed`);
  assertPositiveInteger(profile.steps.target, `${field}.steps.target`);
  if (profile.steps.completed > profile.steps.target) {
    throw new Error(`${field}.steps.completed cannot exceed target`);
  }
  validateTopology(profile.topology, `${field}.topology`, false);
  if (profile.validationTopology) {
    validateTopology(
      profile.validationTopology,
      `${field}.validationTopology`,
      options.requireVNext,
    );
    if (!topologyEquals(profile.topology, profile.validationTopology)) {
      throw new Error(`${field}.validationTopology must match the v1 topology alias`);
    }
  }
  if (options.requireVNext) {
    if (profile.modelScope === undefined) throw new Error(`${field}.modelScope is required`);
    if (profile.computeScope === undefined) throw new Error(`${field}.computeScope is required`);
    if (profile.validationTopology === undefined) {
      throw new Error(`${field}.validationTopology is required`);
    }
    validateRuntimeProfile(profile.runtime, `${field}.runtime`);
  } else if (profile.runtime) {
    validateRuntimeProfile(profile.runtime, `${field}.runtime`);
  }
  if (profile.unknownFields !== undefined) {
    validateStringIds(profile.unknownFields, `${field}.unknownFields`);
    if (profile.unknownFields.some((value) => value !== "runtime")) {
      throw new Error(`${field}.unknownFields contains an unsupported field`);
    }
  }
  if (options.requireVNext && profile.unknownFields?.length) {
    throw new Error(`${field}.unknownFields must be empty for strict v2`);
  }
  const unsupported = activeTopologyStrategies(profileTopology(profile)).filter(
    (strategy) => !target.referenceStrategies.includes(strategy),
  );
  if (unsupported.length > 0) {
    throw new Error(`${field}.topology expands beyond reference parity: ${unsupported.join(", ")}`);
  }
}

export interface SparkReproDualLaneState {
  acceptanceProfile: SparkReproProfile;
  exploreFrontier: SparkReproExploreFrontier;
  normativeCursor: SparkReproNormativeCursor;
  unresolved: SparkReproUnresolvedItem[];
}

export interface SparkReproExploreObservation {
  id: string;
  stage: SparkReproWorkStage;
  profile: SparkReproProfile;
  planRevision: number;
  ownerStepId: string;
  stepDefinitionDigest: string;
  evidenceRefs: EvidenceRef[];
  unresolvedIds: string[];
}

/** DL-01: Explore can advance reachability without changing Normative retirement. */
export function advanceSparkReproExploreFrontier(
  state: SparkReproDualLaneState,
  observation: SparkReproExploreObservation,
): SparkReproDualLaneState {
  if (observation.planRevision !== state.normativeCursor.planRevision) {
    throw new Error("stale Explore observation plan revision");
  }
  assertNonEmpty(observation.ownerStepId, "observation.ownerStepId");
  assertNonEmpty(observation.stepDefinitionDigest, "observation.stepDefinitionDigest");
  const expectedDigest = state.normativeCursor.stepDefinitionDigests?.[observation.ownerStepId];
  if (expectedDigest !== undefined && expectedDigest !== observation.stepDefinitionDigest) {
    throw new Error("stale Explore observation step definition digest");
  }
  validateEvidenceRefs(observation.evidenceRefs, "observation.evidenceRefs");
  const openIds = new Set(
    state.unresolved.filter((item) => item.status === "open").map((item) => item.id),
  );
  for (const id of observation.unresolvedIds) {
    if (!openIds.has(id))
      throw new Error(`Explore observation references a non-open unresolved item: ${id}`);
  }
  const currentIndex = stageIndex(state.exploreFrontier.stage);
  const nextIndex = stageIndex(observation.stage);
  return {
    ...structuredClone(state),
    ...(nextIndex >= currentIndex
      ? {
          exploreFrontier: {
            stage: observation.stage,
            profile: canonicalProfile(observation.profile),
            planRevision: observation.planRevision,
            observationId: observation.id,
            ownerStepId: observation.ownerStepId,
            stepDefinitionDigest: observation.stepDefinitionDigest,
            evidenceRefs: [...observation.evidenceRefs],
            unresolvedIds: [...observation.unresolvedIds],
          },
        }
      : {}),
  };
}

/** DL-02: a bypass is not dispatchable until its stable unresolved item exists. */
export function registerSparkReproUnresolved(
  state: SparkReproDualLaneState,
  item: SparkReproUnresolvedItem,
): SparkReproDualLaneState {
  validateUnresolved(item, 0);
  if (item.status !== "open") throw new Error("a newly registered unresolved item must be open");
  if (item.planRevision !== state.normativeCursor.planRevision) {
    throw new Error("stale unresolved registration plan revision");
  }
  if (!state.normativeCursor.orderedStepIds.includes(item.ownerStepId)) {
    throw new Error("unresolved registration owner step is not in the Normative plan");
  }
  const expectedDigest = state.normativeCursor.stepDefinitionDigests?.[item.ownerStepId];
  if (expectedDigest !== undefined && expectedDigest !== item.stepDefinitionDigest) {
    throw new Error("stale unresolved registration step definition digest");
  }
  const existing = state.unresolved.find((candidate) => candidate.id === item.id);
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(item)) return structuredClone(state);
    throw new Error(`unresolved id was retried with a different binding: ${item.id}`);
  }
  return { ...structuredClone(state), unresolved: [...state.unresolved, cloneUnresolved(item)] };
}

export function dischargeSparkReproUnresolved(
  state: SparkReproDualLaneState,
  input: {
    id: string;
    planRevision: number;
    stepDefinitionDigest: string;
    evidenceRefs: EvidenceRef[];
  },
): SparkReproDualLaneState {
  const item = state.unresolved.find((candidate) => candidate.id === input.id);
  if (!item) throw new Error(`unknown unresolved item: ${input.id}`);
  if (
    input.planRevision !== state.normativeCursor.planRevision ||
    input.planRevision !== item.planRevision ||
    input.stepDefinitionDigest !== item.stepDefinitionDigest
  ) {
    throw new Error("stale unresolved discharge binding");
  }
  const cursorDigest = state.normativeCursor.stepDefinitionDigests?.[item.ownerStepId];
  if (cursorDigest !== undefined && cursorDigest !== item.stepDefinitionDigest) {
    throw new Error("stale unresolved discharge cursor binding");
  }
  if (item.status === "discharged") {
    if (JSON.stringify(item.evidenceRefs) === JSON.stringify(input.evidenceRefs)) {
      return structuredClone(state);
    }
    throw new Error("unresolved item was already discharged with different evidence");
  }
  if (item.status !== "open") throw new Error("only an open unresolved item can be discharged");
  validateEvidenceRefs(input.evidenceRefs, "discharge.evidenceRefs");
  if (input.evidenceRefs.length === 0) {
    throw new Error("unresolved discharge requires formal evidence");
  }
  return {
    ...structuredClone(state),
    unresolved: state.unresolved.map((candidate) =>
      candidate.id === input.id
        ? {
            ...cloneUnresolved(candidate),
            status: "discharged",
            evidenceRefs: [...input.evidenceRefs],
          }
        : cloneUnresolved(candidate),
    ),
  };
}

export function supersedeSparkReproUnresolved(
  state: SparkReproDualLaneState,
  input: { id: string; supersededBy: string; planRevision: number },
): SparkReproDualLaneState {
  if (input.planRevision !== state.normativeCursor.planRevision) {
    throw new Error("stale unresolved supersede binding");
  }
  if (input.id === input.supersededBy)
    throw new Error("an unresolved item cannot supersede itself");
  const successor = state.unresolved.find((item) => item.id === input.supersededBy);
  if (!successor || successor.status !== "open") {
    throw new Error("unresolved successor must exist and remain open");
  }
  const original = state.unresolved.find((item) => item.id === input.id);
  if (!original) throw new Error(`unknown unresolved item: ${input.id}`);
  if (original.status !== "open") throw new Error("only an open unresolved item can be superseded");
  return {
    ...structuredClone(state),
    unresolved: state.unresolved.map((item) =>
      item.id === input.id
        ? { ...cloneUnresolved(item), status: "superseded", supersededBy: input.supersededBy }
        : cloneUnresolved(item),
    ),
  };
}

/** DL-03: candidate arrival never retires a step by itself. */
export function recordSparkReproRetirementCandidate(
  state: SparkReproDualLaneState,
  candidate: SparkReproRetirementCandidate,
): SparkReproDualLaneState {
  if (candidate.planRevision !== state.normativeCursor.planRevision) {
    throw new Error("stale retirement candidate plan revision");
  }
  const stepIndex = state.normativeCursor.orderedStepIds.indexOf(candidate.stepId);
  if (stepIndex < 0) throw new Error(`candidate references an unknown step: ${candidate.stepId}`);
  for (const dependency of candidate.dependsOn) {
    const dependencyIndex = state.normativeCursor.orderedStepIds.indexOf(dependency);
    if (dependencyIndex < 0 || dependencyIndex >= stepIndex) {
      throw new Error(`candidate dependency is not earlier in Normative order: ${dependency}`);
    }
  }
  const existingCandidate = state.normativeCursor.candidateBuffer.find(
    (item) => item.id === candidate.id,
  );
  if (existingCandidate) {
    if (JSON.stringify(existingCandidate) === JSON.stringify(candidate)) {
      return structuredClone(state);
    }
    throw new Error(
      `retirement candidate id was retried with a different binding: ${candidate.id}`,
    );
  }
  const expectedDependencies = state.normativeCursor.stepDependencies?.[candidate.stepId];
  if (
    expectedDependencies !== undefined &&
    JSON.stringify(expectedDependencies) !== JSON.stringify(candidate.dependsOn)
  ) {
    throw new Error("retirement candidate dependencies do not match the Normative plan");
  }
  if (!profileMatchesAcceptance(candidate.profile, state.acceptanceProfile)) {
    throw new Error("retirement candidate profile does not match the frozen acceptance Profile");
  }
  const expectedDigest = state.normativeCursor.stepDefinitionDigests?.[candidate.stepId];
  if (expectedDigest !== undefined && expectedDigest !== candidate.stepDefinitionDigest) {
    throw new Error("stale retirement candidate step definition digest");
  }
  validateCandidate(candidate, "candidate");
  return {
    ...structuredClone(state),
    normativeCursor: {
      ...cloneNormativeCursor(state.normativeCursor),
      candidateBuffer: [
        ...state.normativeCursor.candidateBuffer.map(cloneCandidate),
        cloneCandidate(candidate),
      ],
    },
  };
}

/** DL-04: accepted candidates retire only in dependency/cursor order. */
export function reconcileSparkReproNormativeRetirement(
  state: SparkReproDualLaneState,
): SparkReproDualLaneState {
  const next = structuredClone(state) as SparkReproDualLaneState;
  const retired = new Set(next.normativeCursor.retiredStepIds);
  for (const stepId of next.normativeCursor.orderedStepIds) {
    if (retired.has(stepId)) continue;
    const candidates = next.normativeCursor.candidateBuffer.filter(
      (candidate) => candidate.stepId === stepId && candidate.verdict === "accepted",
    );
    const candidate = candidates.find(
      (entry) =>
        entry.planRevision === next.normativeCursor.planRevision &&
        next.normativeCursor.stepDefinitionDigests?.[entry.stepId] === entry.stepDefinitionDigest &&
        JSON.stringify(next.normativeCursor.stepDependencies?.[entry.stepId] ?? []) ===
          JSON.stringify(entry.dependsOn) &&
        profileMatchesAcceptance(entry.profile, next.acceptanceProfile) &&
        entry.dependsOn.every((dependency) => retired.has(dependency)) &&
        !next.unresolved.some(
          (item) =>
            item.ownerStepId === stepId &&
            item.completionRequired &&
            !isUnresolvedChainDischarged(item, next.unresolved),
        ) &&
        entry.unresolvedIds.every((id) => {
          const item = next.unresolved.find((candidate) => candidate.id === id);
          return item !== undefined && isUnresolvedChainDischarged(item, next.unresolved);
        }),
    );
    if (!candidate) break;
    retired.add(stepId);
    next.normativeCursor.retiredStepIds.push(stepId);
    next.normativeCursor.retirementLog.push({
      stepId,
      candidateId: candidate.id,
      planRevision: candidate.planRevision,
      stepDefinitionDigest: candidate.stepDefinitionDigest,
      profile: canonicalProfile(candidate.profile),
      profileDigest: sparkReproProfileDigest(candidate.profile),
      evidenceRefs: [...candidate.evidenceRefs],
    });
  }
  const nextCurrentStepId = next.normativeCursor.orderedStepIds.find(
    (stepId) => !retired.has(stepId),
  );
  if (nextCurrentStepId) next.normativeCursor.currentStepId = nextCurrentStepId;
  else delete next.normativeCursor.currentStepId;
  return next;
}

/**
 * Explicit storage adapter. Legacy formal/diagnostic proof is preserved as a
 * probe row with unknown denominators; it is never promoted to entrypoint
 * validation, an Explore observation, or unresolved discharge.
 */
export function normalizeSparkReproWorkSummary(value: unknown): SparkReproWorkSummary {
  if (!isRecord(value)) throw new Error("Repro work summary must be an object");
  if (value.schema === SPARK_REPRO_WORK_SUMMARY_SCHEMA) {
    return buildSparkReproWorkSummary(
      workSummaryV2ToInput(value as unknown as SparkReproWorkSummary),
    );
  }
  if (value.schema !== SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA) {
    throw new Error(
      `Repro work summary schema received ${String(value.schema)} at the structured summary payload boundary; supported schemas are ${SPARK_REPRO_WORK_SUMMARY_SCHEMA} and ${SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA}. Migrate the payload with the v1 adapter or upgrade the producer, then retry.`,
    );
  }
  return migrateSparkReproWorkSummaryV1(value);
}

export function migrateSparkReproWorkSummaryV1(
  value: Record<string, unknown>,
): SparkReproWorkSummary {
  const legacy = value as unknown as {
    reproId: string;
    title: string;
    stage: SparkReproWorkStage;
    target: SparkReproTechnicalTarget;
    profile: SparkReproProfile;
    gates: SparkReproEvidenceGate[];
    pendingDecisions?: SparkReproDecisionRequest[];
    frontier?: SparkReproFrontier;
    tasks?: SparkReproWorkTask[];
    todos?: SparkReproTodo[];
    conclusions?: SparkReproConclusion[];
    artifactRefs?: ArtifactRef[];
    reportArtifactRef?: ArtifactRef;
  };
  const profile = canonicalProfile(legacy.profile);
  const gates = legacy.gates.map(cloneGate);
  const validationMatrix: SparkReproValidationMatrix = {
    denominators: Object.fromEntries(
      SPARK_REPRO_WORK_STAGES.map((stage) => [stage, null]),
    ) as Record<SparkReproWorkStage, null>,
    rows: gates.map((gate) => ({
      id: `legacy-probe:${gate.id}`,
      gateId: gate.id,
      stage: gate.stage,
      invocationClass: "isolated_diagnostic",
      evidenceClass: "probe",
      verdict: gate.status,
      profile: canonicalProfile(gate.profile ?? profile),
      repetitions: 1,
      exactScope: "legacy authority unknown",
      evidenceRefs: [...gate.evidenceRefs],
      artifactRefs: [],
    })),
  };
  return buildSparkReproWorkSummary({
    reproId: legacy.reproId,
    migration: {
      sourceSchema: SPARK_REPRO_LEGACY_WORK_SUMMARY_SCHEMA,
      revision: 1,
      legacyProofAuthority: "not_promoted",
    },
    title: legacy.title,
    stage: legacy.stage,
    target: legacy.target,
    profile,
    gates,
    ...(legacy.pendingDecisions ? { pendingDecisions: legacy.pendingDecisions } : {}),
    ...(legacy.frontier ? { frontier: legacy.frontier } : {}),
    validationMatrix,
    ...(legacy.tasks ? { tasks: legacy.tasks } : {}),
    ...(legacy.todos ? { todos: legacy.todos } : {}),
    ...(legacy.conclusions ? { conclusions: legacy.conclusions } : {}),
    ...(legacy.artifactRefs ? { artifactRefs: legacy.artifactRefs } : {}),
    ...(legacy.reportArtifactRef ? { reportArtifactRef: legacy.reportArtifactRef } : {}),
    schedulerActivity: "dormant",
    independentReadyCount: 0,
  });
}

export function sparkReproProfileDigest(profile: SparkReproProfile): string {
  const canonical = canonicalProfile(profile);
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: canonical.id,
        modelScope: canonical.modelScope,
        computeScope: canonical.computeScope,
        steps: canonical.steps,
        validationTopology: canonical.validationTopology,
        runtime: canonical.runtime,
        unknownFields: canonical.unknownFields ?? [],
      }),
    )
    .digest("hex");
}

function gateCountsTowardProgress(gate: SparkReproEvidenceGate): boolean {
  if (gate.evidenceClass !== "formal") return false;
  if (gate.stage === "contract" || gate.stage === "delivery") {
    return gate.profile === undefined || profileModelScope(gate.profile) === "minimum_complete";
  }
  return gate.profile !== undefined && profileModelScope(gate.profile) === "minimum_complete";
}

function hasMinimumCompleteOptimizerProfile(gate: SparkReproEvidenceGate): boolean {
  return (
    gate.profile !== undefined &&
    profileModelScope(gate.profile) === "minimum_complete" &&
    profileComputeScope(gate.profile) === "optimizer"
  );
}

function hasMinimumCompleteTrainingStep(gate: SparkReproEvidenceGate): boolean {
  return hasMinimumCompleteOptimizerProfile(gate) && gate.profile!.steps.completed >= 1;
}

function validateTechnicalTarget(target: SparkReproTechnicalTarget, requireVNext: boolean): void {
  if (target.model !== "minimum_complete") {
    throw new Error("technical target model must be minimum_complete");
  }
  assertPositiveInteger(target.requiredSteps, "target.requiredSteps");
  for (const [index, strategy] of target.referenceStrategies.entries()) {
    assertOneOf(
      strategy,
      SPARK_REPRO_DISTRIBUTED_STRATEGIES,
      `target.referenceStrategies[${index}]`,
    );
  }
  const ordered = orderedStrategies(target.referenceStrategies);
  if (ordered.length !== target.referenceStrategies.length) {
    throw new Error("target.referenceStrategies must be unique");
  }
  validateTopology(target.validationTopology, "target.validationTopology", requireVNext);
  if (requireVNext && target.acceptanceProfile === undefined) {
    throw new Error("target.acceptanceProfile is required");
  }
  const validationStrategies = orderedStrategies(
    activeTopologyStrategies(target.validationTopology),
  );
  if (
    validationStrategies.length !== ordered.length ||
    validationStrategies.some((strategy, index) => strategy !== ordered[index])
  ) {
    throw new Error("target.validationTopology must activate exactly target.referenceStrategies");
  }
}

function validateGate(
  gate: SparkReproEvidenceGate,
  target: SparkReproTechnicalTarget,
  field: string,
  requireVNext: boolean,
): void {
  assertNonEmpty(gate.title, `${field}.title`);
  assertOneOf(gate.stage, SPARK_REPRO_WORK_STAGES, `${field}.stage`);
  assertOneOf(gate.evidenceClass, ["formal", "diagnostic"] as const, `${field}.evidenceClass`);
  assertOneOf(gate.status, ["open", "accepted", "rejected"] as const, `${field}.status`);
  if (!Number.isFinite(gate.weight) || gate.weight <= 0) {
    throw new Error(`${field}.weight must be a positive number`);
  }
  if (gate.profile) {
    validateSparkReproProfile(gate.profile, target, { requireVNext, field: `${field}.profile` });
  }
  validateEvidenceRefs(gate.evidenceRefs, `${field}.evidenceRefs`);
  if (
    gate.evidenceClass === "formal" &&
    gate.status === "accepted" &&
    gate.evidenceRefs.length === 0
  ) {
    throw new Error(`${field} cannot accept a formal gate without evidence`);
  }
  if (!gate.establishes?.length) return;
  if (!gateCountsTowardProgress(gate)) {
    throw new Error(`${field} cannot establish technical completion outside a formal gate`);
  }
  const criteria = new Set<SparkReproTechnicalCriterion>();
  for (const criterion of gate.establishes) {
    assertOneOf(
      criterion,
      ["reference_ready", "target_ready", "required_steps_aligned", "reference_parity"] as const,
      `${field}.establishes`,
    );
    if (criteria.has(criterion)) throw new Error(`${field}.establishes must be unique`);
    criteria.add(criterion);
    validateTechnicalCriterionGate(gate, criterion, target, field);
  }
}

function validateTechnicalCriterionGate(
  gate: SparkReproEvidenceGate,
  criterion: SparkReproTechnicalCriterion,
  target: SparkReproTechnicalTarget,
  field: string,
): void {
  const expectedStage: Record<SparkReproTechnicalCriterion, SparkReproWorkStage> = {
    reference_ready: "reference",
    target_ready: "target",
    required_steps_aligned: "alignment",
    reference_parity: "alignment",
  };
  if (gate.stage !== expectedStage[criterion]) {
    throw new Error(`${field} establishes ${criterion} from the wrong stage`);
  }
  if (!gate.profile || profileModelScope(gate.profile) !== "minimum_complete") {
    throw new Error(`${field} establishes ${criterion} without a minimum_complete profile`);
  }
  if (profileComputeScope(gate.profile) !== "optimizer") {
    throw new Error(`${field} establishes ${criterion} without an optimizer transaction`);
  }
  if (criterion === "required_steps_aligned" && gate.profile.steps.target < target.requiredSteps) {
    throw new Error(`${field} cannot establish required_steps_aligned below requiredSteps`);
  }
  if (
    criterion === "reference_parity" &&
    !topologyEquals(profileTopology(gate.profile), target.validationTopology)
  ) {
    throw new Error(`${field} cannot establish reference_parity outside validationTopology`);
  }
}

function validateDecision(decision: SparkReproDecisionRequest, field: string): void {
  if (decision.status !== "pending") throw new Error(`${field}.status must be pending`);
  assertOneOf(decision.kind, SPARK_REPRO_DECISION_KINDS, `${field}.kind`);
  assertNonEmpty(decision.question, `${field}.question`);
  assertOneOf(
    decision.blockedTransition.from,
    SPARK_REPRO_WORK_STAGES,
    `${field}.blockedTransition.from`,
  );
  assertOneOf(
    decision.blockedTransition.to,
    SPARK_REPRO_WORK_STAGES,
    `${field}.blockedTransition.to`,
  );
  if (decision.options.length < 2 || decision.options.length > 3) {
    throw new Error(`${field}.options must contain two or three choices`);
  }
  const values = new Set<string>();
  let recommended = 0;
  for (const [index, option] of decision.options.entries()) {
    assertNonEmpty(option.value, `${field}.options[${index}].value`);
    assertNonEmpty(option.label, `${field}.options[${index}].label`);
    if (values.has(option.value)) throw new Error(`${field}.options values must be unique`);
    values.add(option.value);
    if (option.recommended) recommended += 1;
  }
  if (recommended > 1) throw new Error(`${field}.options may recommend at most one choice`);
  validateEvidenceRefs(decision.evidenceRefs, `${field}.evidenceRefs`);
  if (typeof decision.askRef !== "string" || !isRef(decision.askRef, "ask")) {
    throw new Error(`${field}.askRef must be an ask: ref`);
  }
}

function validateTask(task: SparkReproWorkTask, index: number): void {
  assertNonEmpty(task.title, `tasks[${index}].title`);
  assertOneOf(task.stage, SPARK_REPRO_WORK_STAGES, `tasks[${index}].stage`);
  assertOneOf(
    task.status,
    ["queued", "running", "blocked", "done", "failed", "cancelled"] as const,
    `tasks[${index}].status`,
  );
  if (task.taskRef !== undefined && !isRef(task.taskRef, "task")) {
    throw new Error(`tasks[${index}].taskRef must be a task: ref`);
  }
}

function validateTodo(todo: SparkReproTodo, index: number, taskIds: ReadonlySet<string>): void {
  assertNonEmpty(todo.content, `todos[${index}].content`);
  assertOneOf(
    todo.status,
    ["pending", "in_progress", "blocked", "done", "cancelled"] as const,
    `todos[${index}].status`,
  );
  if (todo.taskId !== undefined && !taskIds.has(todo.taskId)) {
    throw new Error(`todos[${index}].taskId does not reference a summary task: ${todo.taskId}`);
  }
}

function validateFrontier(
  frontier: SparkReproFrontier,
  currentStage: SparkReproWorkStage,
  target: SparkReproTechnicalTarget,
  requireVNext: boolean,
): void {
  if (frontier.stage !== currentStage)
    throw new Error("frontier.stage must match the summary stage");
  validateSparkReproProfile(frontier.profile, target, { requireVNext, field: "frontier.profile" });
  if (frontier.lastGood) validateOperatorLocation(frontier.lastGood, "frontier.lastGood");
  if (frontier.firstBad) validateOperatorLocation(frontier.firstBad, "frontier.firstBad");
  if (!frontier.activeExperiment) return;
  const experiment = frontier.activeExperiment;
  assertNonEmpty(experiment.id, "frontier.activeExperiment.id");
  assertOneOf(
    experiment.status,
    ["queued", "running", "passed", "failed"] as const,
    "frontier.activeExperiment.status",
  );
  if (experiment.status !== "queued" && experiment.status !== "running") {
    throw new Error("frontier.activeExperiment must be queued or running");
  }
  assertNonEmpty(experiment.hypothesis, "frontier.activeExperiment.hypothesis");
  assertNonEmpty(experiment.singleVariable, "frontier.activeExperiment.singleVariable");
  assertNonEmpty(experiment.expectedOutcome, "frontier.activeExperiment.expectedOutcome");
  assertNonEmpty(experiment.falsificationOutcome, "frontier.activeExperiment.falsificationOutcome");
  validateSparkReproProfile(experiment.profile, target, {
    requireVNext,
    field: "frontier.activeExperiment.profile",
  });
  validateEvidenceRefs(experiment.evidenceRefs, "frontier.activeExperiment.evidenceRefs");
}

function validateExploreFrontier(
  frontier: SparkReproExploreFrontier,
  target: SparkReproTechnicalTarget,
  requireVNext: boolean,
): void {
  assertOneOf(frontier.stage, SPARK_REPRO_WORK_STAGES, "exploreFrontier.stage");
  assertPositiveInteger(frontier.planRevision, "exploreFrontier.planRevision");
  validateSparkReproProfile(frontier.profile, target, {
    requireVNext,
    field: "exploreFrontier.profile",
  });
  validateEvidenceRefs(frontier.evidenceRefs, "exploreFrontier.evidenceRefs");
  validateStringIds(frontier.unresolvedIds, "exploreFrontier.unresolvedIds");
  if (frontier.observationId !== undefined) {
    assertNonEmpty(frontier.observationId, "exploreFrontier.observationId");
    assertNonEmpty(frontier.ownerStepId!, "exploreFrontier.ownerStepId");
    assertNonEmpty(frontier.stepDefinitionDigest!, "exploreFrontier.stepDefinitionDigest");
  } else if (frontier.ownerStepId !== undefined || frontier.stepDefinitionDigest !== undefined) {
    throw new Error("exploreFrontier observation binding requires observationId");
  }
}

function validateNormativeCursor(
  cursor: SparkReproNormativeCursor,
  target: SparkReproTechnicalTarget,
  acceptanceProfile: SparkReproProfile,
  requireVNext: boolean,
): void {
  assertPositiveInteger(cursor.planRevision, "normativeCursor.planRevision");
  validateStringIds(cursor.orderedStepIds, "normativeCursor.orderedStepIds");
  if (requireVNext && cursor.orderedStepIds.length > 0 && !cursor.stepDefinitionDigests) {
    throw new Error("normativeCursor.stepDefinitionDigests is required");
  }
  if (cursor.stepDefinitionDigests) {
    const knownIds = new Set(cursor.orderedStepIds);
    for (const stepId of Object.keys(cursor.stepDefinitionDigests)) {
      if (!knownIds.has(stepId)) {
        throw new Error(`normativeCursor.stepDefinitionDigests contains unknown step: ${stepId}`);
      }
    }
    for (const stepId of cursor.orderedStepIds) {
      assertNonEmpty(
        cursor.stepDefinitionDigests[stepId]!,
        `normativeCursor.stepDefinitionDigests.${stepId}`,
      );
    }
  }
  if (requireVNext && cursor.orderedStepIds.length > 0 && !cursor.stepDependencies) {
    throw new Error("normativeCursor.stepDependencies is required");
  }
  if (cursor.stepDependencies) {
    const knownIds = new Set(cursor.orderedStepIds);
    for (const [stepId, dependencies] of Object.entries(cursor.stepDependencies)) {
      if (!knownIds.has(stepId)) {
        throw new Error(`normativeCursor.stepDependencies contains unknown step: ${stepId}`);
      }
      validateStringIds(dependencies, `normativeCursor.stepDependencies.${stepId}`);
      const stepIndex = cursor.orderedStepIds.indexOf(stepId);
      for (const dependency of dependencies) {
        const dependencyIndex = cursor.orderedStepIds.indexOf(dependency);
        if (dependencyIndex < 0 || dependencyIndex >= stepIndex) {
          throw new Error(
            `normativeCursor.stepDependencies.${stepId} contains a non-prior dependency: ${dependency}`,
          );
        }
      }
    }
    for (const stepId of cursor.orderedStepIds) {
      if (cursor.stepDependencies[stepId] === undefined) {
        throw new Error(`normativeCursor.stepDependencies.${stepId} is required`);
      }
    }
  }
  validateStringIds(cursor.retiredStepIds, "normativeCursor.retiredStepIds");
  const ordered = new Set(cursor.orderedStepIds);
  const expectedRetiredPrefix = cursor.orderedStepIds.slice(0, cursor.retiredStepIds.length);
  if (JSON.stringify(cursor.retiredStepIds) !== JSON.stringify(expectedRetiredPrefix)) {
    throw new Error("normativeCursor.retiredStepIds must be a cursor-ordered prefix");
  }
  for (const stepId of cursor.retiredStepIds) {
    if (!ordered.has(stepId)) throw new Error(`normativeCursor retired unknown step: ${stepId}`);
  }
  const expectedCurrent = cursor.orderedStepIds.find(
    (stepId) => !cursor.retiredStepIds.includes(stepId),
  );
  if (cursor.currentStepId !== expectedCurrent) {
    throw new Error("normativeCursor.currentStepId must be the earliest unretired step");
  }
  validateUniqueIds(cursor.candidateBuffer, "normativeCursor.candidateBuffer");
  for (const [index, candidate] of cursor.candidateBuffer.entries()) {
    validateCandidate(candidate, `normativeCursor.candidateBuffer[${index}]`);
    if (!ordered.has(candidate.stepId)) {
      throw new Error(`normativeCursor candidate references unknown step: ${candidate.stepId}`);
    }
    if (candidate.planRevision !== cursor.planRevision) {
      throw new Error(`normativeCursor candidate has a stale plan revision: ${candidate.id}`);
    }
    const expectedDigest = cursor.stepDefinitionDigests?.[candidate.stepId];
    if (expectedDigest !== undefined && candidate.stepDefinitionDigest !== expectedDigest) {
      throw new Error(
        `normativeCursor candidate has a stale step definition digest: ${candidate.id}`,
      );
    }
    const expectedDependencies = cursor.stepDependencies?.[candidate.stepId];
    if (
      expectedDependencies !== undefined &&
      JSON.stringify(candidate.dependsOn) !== JSON.stringify(expectedDependencies)
    ) {
      throw new Error(`normativeCursor candidate dependencies are stale: ${candidate.id}`);
    }
    validateSparkReproProfile(candidate.profile, target, {
      requireVNext,
      field: `normativeCursor.candidateBuffer[${index}].profile`,
    });
    if (requireVNext && !profileMatchesAcceptance(candidate.profile, acceptanceProfile)) {
      throw new Error(
        `normativeCursor.candidateBuffer[${index}].profile must match acceptanceProfile`,
      );
    }
  }
  for (const [index, record] of cursor.retirementLog.entries()) {
    const field = `normativeCursor.retirementLog[${index}]`;
    if (record.stepId !== cursor.retiredStepIds[index]) {
      throw new Error("normativeCursor.retirementLog must match retiredStepIds in cursor order");
    }
    if (record.planRevision !== cursor.planRevision) {
      throw new Error(`${field}.planRevision is stale`);
    }
    const expectedDigest = cursor.stepDefinitionDigests?.[record.stepId];
    if (expectedDigest !== undefined && record.stepDefinitionDigest !== expectedDigest) {
      throw new Error(`${field}.stepDefinitionDigest is stale`);
    }
    validateSparkReproProfile(record.profile, target, {
      requireVNext,
      field: `${field}.profile`,
    });
    if (requireVNext && !profileMatchesAcceptance(record.profile, acceptanceProfile)) {
      throw new Error(`${field}.profile must match acceptanceProfile`);
    }
    assertNonEmpty(record.profileDigest, `${field}.profileDigest`);
    if (sparkReproProfileDigest(record.profile) !== record.profileDigest) {
      throw new Error(`${field}.profileDigest does not match its retirement Profile`);
    }
    validateEvidenceRefs(record.evidenceRefs, `${field}.evidenceRefs`);
    if (record.evidenceRefs.length === 0) throw new Error(`${field} requires evidence`);
  }
  const logIds = cursor.retirementLog.map((record) => record.stepId);
  if (JSON.stringify(logIds) !== JSON.stringify(cursor.retiredStepIds)) {
    throw new Error("normativeCursor.retirementLog must match retiredStepIds in cursor order");
  }
}

function validateCandidate(candidate: SparkReproRetirementCandidate, field: string): void {
  assertNonEmpty(candidate.id, `${field}.id`);
  assertNonEmpty(candidate.stepId, `${field}.stepId`);
  assertPositiveInteger(candidate.planRevision, `${field}.planRevision`);
  assertNonEmpty(candidate.stepDefinitionDigest, `${field}.stepDefinitionDigest`);
  assertOneOf(
    candidate.verdict,
    ["candidate", "accepted", "rejected", "stale"] as const,
    `${field}.verdict`,
  );
  validateStringIds(candidate.dependsOn, `${field}.dependsOn`);
  validateStringIds(candidate.unresolvedIds, `${field}.unresolvedIds`);
  validateEvidenceRefs(candidate.evidenceRefs, `${field}.evidenceRefs`);
  if (candidate.verdict === "accepted" && candidate.evidenceRefs.length === 0) {
    throw new Error(`${field} accepted candidate requires evidence`);
  }
}

function validateUnresolved(item: SparkReproUnresolvedItem, index: number): void {
  const field = `unresolved[${index}]`;
  assertNonEmpty(item.id, `${field}.id`);
  assertOneOf(
    item.kind,
    ["bridge", "adapter", "fallback", "stub", "assumption", "mismatch"] as const,
    `${field}.kind`,
  );
  assertNonEmpty(item.owner, `${field}.owner`);
  assertNonEmpty(item.impact, `${field}.impact`);
  if (typeof item.reversible !== "boolean")
    throw new Error(`${field}.reversible must be a boolean`);
  assertNonEmpty(item.rollback, `${field}.rollback`);
  assertNonEmpty(item.dischargeCriterion, `${field}.dischargeCriterion`);
  assertOneOf(item.status, ["open", "discharged", "superseded"] as const, `${field}.status`);
  if (typeof item.completionRequired !== "boolean") {
    throw new Error(`${field}.completionRequired must be a boolean`);
  }
  assertPositiveInteger(item.planRevision, `${field}.planRevision`);
  assertNonEmpty(item.ownerStepId, `${field}.ownerStepId`);
  assertNonEmpty(item.stepDefinitionDigest, `${field}.stepDefinitionDigest`);
  validateEvidenceRefs(item.evidenceRefs, `${field}.evidenceRefs`);
  if (item.status === "discharged" && item.evidenceRefs.length === 0) {
    throw new Error(`${field} discharged item requires formal evidence`);
  }
  if (item.status === "superseded" && !item.supersededBy) {
    throw new Error(`${field} superseded item requires supersededBy`);
  }
}

function validateUnresolvedCursorBinding(
  item: SparkReproUnresolvedItem,
  cursor: SparkReproNormativeCursor,
  index: number,
  requireVNext: boolean,
): void {
  const field = `unresolved[${index}]`;
  if (item.planRevision !== cursor.planRevision) {
    throw new Error(`${field}.planRevision is stale`);
  }
  if (requireVNext && !cursor.orderedStepIds.includes(item.ownerStepId)) {
    throw new Error(`${field}.ownerStepId does not reference the Normative plan`);
  }
  const expectedDigest = cursor.stepDefinitionDigests?.[item.ownerStepId];
  if (expectedDigest !== undefined && item.stepDefinitionDigest !== expectedDigest) {
    throw new Error(`${field}.stepDefinitionDigest is stale`);
  }
}

function validateExploreCursorBinding(
  frontier: SparkReproExploreFrontier,
  cursor: SparkReproNormativeCursor,
  unresolved: readonly SparkReproUnresolvedItem[],
  requireVNext: boolean,
): void {
  if (frontier.planRevision !== cursor.planRevision) {
    throw new Error("exploreFrontier.planRevision must match normativeCursor.planRevision");
  }
  if (frontier.observationId) {
    if (requireVNext && !cursor.orderedStepIds.includes(frontier.ownerStepId!)) {
      throw new Error("exploreFrontier.ownerStepId does not reference the Normative plan");
    }
    const expectedDigest = cursor.stepDefinitionDigests?.[frontier.ownerStepId!];
    if (expectedDigest !== undefined && frontier.stepDefinitionDigest !== expectedDigest) {
      throw new Error("exploreFrontier.stepDefinitionDigest is stale");
    }
  }
  const openIds = new Set(
    unresolved.filter((item) => item.status === "open").map((item) => item.id),
  );
  for (const unresolvedId of frontier.unresolvedIds) {
    if (!openIds.has(unresolvedId)) {
      throw new Error(`exploreFrontier references a non-open unresolved item: ${unresolvedId}`);
    }
  }
}

function validateUnresolvedSupersessionGraph(items: readonly SparkReproUnresolvedItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.status !== "superseded") continue;
    const seen = new Set([item.id]);
    let current: SparkReproUnresolvedItem | undefined = item;
    while (current?.status === "superseded") {
      const successorId = current.supersededBy!;
      if (seen.has(successorId)) throw new Error(`unresolved supersession cycle at ${successorId}`);
      seen.add(successorId);
      current = byId.get(successorId);
      if (!current) throw new Error(`unresolved successor does not exist: ${successorId}`);
    }
  }
}

function isUnresolvedChainDischarged(
  item: SparkReproUnresolvedItem,
  items: readonly SparkReproUnresolvedItem[],
): boolean {
  const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current: SparkReproUnresolvedItem | undefined = item;
  while (current) {
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    if (current.status === "discharged") return true;
    if (current.status !== "superseded" || !current.supersededBy) return false;
    current = byId.get(current.supersededBy);
  }
  return false;
}

function validateRetirementBlock(block: SparkReproRetirementBlock, index: number): void {
  const field = `retirementBlockers[${index}]`;
  assertOneOf(
    block.kind,
    ["decision", "approval", "dependency", "verification", "unresolved"] as const,
    `${field}.kind`,
  );
  assertNonEmpty(block.ownerStepId, `${field}.ownerStepId`);
  assertNonEmpty(block.reason, `${field}.reason`);
  if (block.askRef !== undefined && !isRef(block.askRef, "ask")) {
    throw new Error(`${field}.askRef must be an ask: ref`);
  }
}

function validateValidationMatrix(
  matrix: SparkReproValidationMatrix,
  gates: readonly SparkReproEvidenceGate[],
  target: SparkReproTechnicalTarget,
  requireVNext: boolean,
): void {
  for (const stage of SPARK_REPRO_WORK_STAGES) {
    const denominator = matrix.denominators[stage];
    if (denominator !== null && (!Number.isFinite(denominator) || denominator <= 0)) {
      throw new Error(`validationMatrix.denominators.${stage} must be positive or null`);
    }
  }
  validateUniqueIds(matrix.rows, "validationMatrix.rows");
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  for (const [index, row] of matrix.rows.entries()) {
    const field = `validationMatrix.rows[${index}]`;
    const gate = gateById.get(row.gateId);
    if (!gate) throw new Error(`${field}.gateId references an unknown gate: ${row.gateId}`);
    if (gate.stage !== row.stage) throw new Error(`${field}.stage must match its gate stage`);
    assertOneOf(row.stage, SPARK_REPRO_WORK_STAGES, `${field}.stage`);
    assertOneOf(
      row.invocationClass,
      ["owning_entrypoint", "isolated_diagnostic"] as const,
      `${field}.invocationClass`,
    );
    assertOneOf(row.evidenceClass, ["entrypoint", "probe"] as const, `${field}.evidenceClass`);
    if (row.evidenceClass === "entrypoint" && row.invocationClass !== "owning_entrypoint") {
      throw new Error(`${field} entrypoint evidence requires invocationClass=owning_entrypoint`);
    }
    assertOneOf(row.verdict, ["open", "accepted", "rejected"] as const, `${field}.verdict`);
    assertPositiveInteger(row.repetitions, `${field}.repetitions`);
    assertNonEmpty(row.exactScope, `${field}.exactScope`);
    validateSparkReproProfile(row.profile, target, { requireVNext, field: `${field}.profile` });
    validateEvidenceRefs(row.evidenceRefs, `${field}.evidenceRefs`);
    if (requireVNext && row.evidenceClass === "entrypoint") {
      const acceptanceProfile = target.acceptanceProfile;
      if (!acceptanceProfile || !profileMatchesAcceptance(row.profile, acceptanceProfile)) {
        throw new Error(`${field} entrypoint Profile must exactly match target.acceptanceProfile`);
      }
      if (row.verdict === "accepted" && gate.status !== "accepted") {
        throw new Error(`${field} cannot accept entrypoint evidence for an unaccepted gate`);
      }
      for (const ref of gate.evidenceRefs) {
        if (!row.evidenceRefs.includes(ref)) {
          throw new Error(`${field}.evidenceRefs must include the accepted gate receipt ${ref}`);
        }
      }
    }
    for (const [artifactIndex, ref] of row.artifactRefs.entries()) {
      validateArtifactRef(ref, `${field}.artifactRefs[${artifactIndex}]`);
    }
    if (row.verdict === "accepted" && row.evidenceRefs.length === 0) {
      throw new Error(`${field} accepted row requires evidence`);
    }
  }
}

function validateNumericalFrontier(
  frontier: SparkReproNumericalFrontier,
  target: SparkReproTechnicalTarget,
  requireVNext: boolean,
): void {
  for (const level of [
    "native_module_boundary",
    "derived_reference_boundary",
    "native_internal_boundary",
  ] as const) {
    assertOneOf(
      frontier.claims[level],
      ["established", "not_established"] as const,
      `numericalFrontier.claims.${level}`,
    );
  }
  validateBoundaryClaim(frontier.lastGood, "numericalFrontier.lastGood");
  validateBoundaryClaim(frontier.firstBad, "numericalFrontier.firstBad");
  assertOneOf(
    frontier.equalityRule,
    ["raw_bits", "normalized_hash", "tolerance"] as const,
    "numericalFrontier.equalityRule",
  );
  if (frontier.comparedInventory.quantified) {
    assertNonNegativeInteger(
      frontier.comparedInventory.tensors,
      "numericalFrontier.comparedInventory.tensors",
    );
    assertNonNegativeInteger(
      frontier.comparedInventory.elements,
      "numericalFrontier.comparedInventory.elements",
    );
  } else {
    assertNonEmpty(frontier.comparedInventory.reason, "numericalFrontier.comparedInventory.reason");
  }
  if (typeof frontier.exactCoverage.quantified !== "boolean") {
    throw new Error("numericalFrontier.exactCoverage.quantified must be a boolean");
  }
  if (frontier.exactCoverage.quantified) {
    for (const key of ["tensors", "elements", "steps"] as const) {
      const value = frontier.exactCoverage[key];
      if (value === null)
        throw new Error(`numericalFrontier.exactCoverage.${key} is required when quantified`);
      assertNonNegativeInteger(value, `numericalFrontier.exactCoverage.${key}`);
    }
  } else if (
    frontier.exactCoverage.tensors !== null ||
    frontier.exactCoverage.elements !== null ||
    frontier.exactCoverage.steps !== null
  ) {
    throw new Error("unquantified exactCoverage must serialize unknown counts as null");
  }
  validateTopology(
    frontier.exactCoverage.topology,
    "numericalFrontier.exactCoverage.topology",
    requireVNext,
  );
  const difference = frontier.difference;
  for (const key of ["maxAbsDiff", "maxUlp"] as const) {
    const value = difference[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`numericalFrontier.difference.${key} must be non-negative or null`);
    }
  }
  if (difference.signedZeroEqual !== null && typeof difference.signedZeroEqual !== "boolean") {
    throw new Error("numericalFrontier.difference.signedZeroEqual must be boolean or null");
  }
  assertNonEmpty(frontier.activeBlocker, "numericalFrontier.activeBlocker");
  const unsupported = activeTopologyStrategies(frontier.exactCoverage.topology).filter(
    (strategy) => !target.referenceStrategies.includes(strategy),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `numericalFrontier topology expands beyond reference parity: ${unsupported.join(", ")}`,
    );
  }
}

function validateBoundaryClaim(claim: SparkReproBoundaryClaim, field: string): void {
  if (claim.status === "established") validateOperatorLocation(claim.location, `${field}.location`);
  else assertNonEmpty(claim.reason, `${field}.reason`);
  validateEvidenceRefs(claim.evidenceRefs, `${field}.evidenceRefs`);
  if (claim.status === "established" && claim.evidenceRefs.length === 0) {
    throw new Error(`${field} established claim requires evidence`);
  }
}

function validateActiveExperiment(
  experiment: SparkReproActiveExperiment,
  target: SparkReproTechnicalTarget,
  requireVNext: boolean,
): void {
  assertNonEmpty(experiment.id, "activeExperiment.id");
  assertOneOf(experiment.status, ["queued", "running"] as const, "activeExperiment.status");
  assertOneOf(
    experiment.evidenceClass,
    ["entrypoint", "probe"] as const,
    "activeExperiment.evidenceClass",
  );
  validateSparkReproProfile(experiment.profile, target, {
    requireVNext,
    field: "activeExperiment.profile",
  });
  assertNonEmpty(experiment.hypothesis, "activeExperiment.hypothesis");
  assertNonEmpty(experiment.onlyVariable, "activeExperiment.onlyVariable");
  assertNonEmpty(experiment.command, "activeExperiment.command");
  assertPositiveInteger(experiment.repetitions, "activeExperiment.repetitions");
  assertNonEmpty(experiment.expectedResult, "activeExperiment.expectedResult");
  assertNonEmpty(experiment.falsifier, "activeExperiment.falsifier");
  assertNonEmpty(experiment.stopCondition, "activeExperiment.stopCondition");
  if (experiment.outputEvidencePaths.length === 0) {
    throw new Error("activeExperiment.outputEvidencePaths must not be empty");
  }
  for (const [index, path] of experiment.outputEvidencePaths.entries()) {
    assertNonEmpty(path, `activeExperiment.outputEvidencePaths[${index}]`);
    if (path.startsWith("evidence:") || path.startsWith("artifact:")) {
      throw new Error(`activeExperiment.outputEvidencePaths[${index}] must be a workspace path`);
    }
  }
  validateEvidenceRefs(experiment.evidenceRefs, "activeExperiment.evidenceRefs");
}

function validateNextAction(next: SparkReproNextAction): void {
  assertNonEmpty(next.id, "nextAction.id");
  assertNonEmpty(next.summary, "nextAction.summary");
  assertNonEmpty(next.passCriterion, "nextAction.passCriterion");
}

function validateOperatorLocation(location: SparkReproOperatorLocation, field: string): void {
  assertNonNegativeInteger(location.step, `${field}.step`);
  assertNonEmpty(location.boundary, `${field}.boundary`);
  if (location.rank !== undefined) assertNonNegativeInteger(location.rank, `${field}.rank`);
}

function validateTopology(topology: SparkReproTopology, field: string, requireVNext = false): void {
  for (const dimension of ["dp", "tp", "pp", "ep", "cp"] as const) {
    assertPositiveInteger(topology[dimension], `${field}.${dimension}`);
  }
  if (topology.etp !== undefined) assertPositiveInteger(topology.etp, `${field}.etp`);
  if (typeof topology.sp !== "boolean") throw new Error(`${field}.sp must be a boolean`);
  if (topology.worldSize !== undefined) {
    assertPositiveInteger(topology.worldSize, `${field}.worldSize`);
  }
  if (topology.unknownFields !== undefined) {
    validateStringIds(topology.unknownFields, `${field}.unknownFields`);
    const allowed = new Set(["etp", "worldSize", "strategies"]);
    if (topology.unknownFields.some((value) => !allowed.has(value))) {
      throw new Error(`${field}.unknownFields contains an unsupported field`);
    }
  }
  if (requireVNext) {
    if (topology.unknownFields?.length) {
      throw new Error(`${field}.unknownFields must be empty for strict v2`);
    }
    if (topology.etp === undefined) throw new Error(`${field}.etp is required`);
    if (topology.worldSize === undefined) throw new Error(`${field}.worldSize is required`);
    if (topology.strategies === undefined) throw new Error(`${field}.strategies is required`);
    if (topology.worldSize !== expectedTopologyWorldSize(topology)) {
      throw new Error(`${field}.worldSize must equal dp*tp*pp*cp*max(ep,etp) for this topology`);
    }
  }
  if (
    topology.strategies !== undefined &&
    (requireVNext ||
      topology.strategies.length > 0 ||
      activeTopologyStrategies(topology).length === 0)
  ) {
    validateStrategies(topology.strategies, topology, `${field}.strategies`);
  }
}

function validateStrategies(
  strategies: readonly SparkReproStrategyEntry[],
  topology: SparkReproTopology,
  field: string,
): void {
  const keys = new Set<string>();
  const axesSeen = new Set<SparkReproDistributedStrategy>();
  for (const [index, strategy] of strategies.entries()) {
    assertOneOf(strategy.axis, SPARK_REPRO_DISTRIBUTED_STRATEGIES, `${field}[${index}].axis`);
    assertNonEmpty(strategy.id, `${field}[${index}].id`);
    assertOneOf(strategy.source, ["official", "reference"] as const, `${field}[${index}].source`);
    assertNonEmpty(strategy.revision, `${field}[${index}].revision`);
    assertNonEmpty(strategy.configDigest, `${field}[${index}].configDigest`);
    if (axesSeen.has(strategy.axis)) {
      throw new Error(
        `${field} must contain exactly one strategy per active axis: ${strategy.axis}`,
      );
    }
    axesSeen.add(strategy.axis);
    const key = strategyKey(strategy);
    if (keys.has(key)) throw new Error(`${field} contains a duplicate canonical strategy: ${key}`);
    keys.add(key);
  }
  const active = orderedStrategies(activeTopologyStrategies(topology));
  const axes = orderedStrategies(strategies.map((strategy) => strategy.axis));
  if (JSON.stringify(active) !== JSON.stringify(axes)) {
    throw new Error(`${field} must describe exactly the active topology axes`);
  }
}

function expectedTopologyWorldSize(topology: SparkReproTopology): number {
  return (
    topology.dp * topology.tp * topology.pp * topology.cp * Math.max(topology.ep, topology.etp ?? 1)
  );
}

function validateRuntimeProfile(
  runtime: SparkReproRuntimeProfile | undefined,
  field: string,
): void {
  if (!runtime) throw new Error(`${field} is required`);
  for (const key of [
    "framework",
    "device",
    "dtype",
    "hardware",
    "modelRevision",
    "configDigest",
  ] as const) {
    assertNonEmpty(runtime[key], `${field}.${key}`);
  }
}

function deriveSchedulerActivity(
  requested: SparkReproSchedulerActivity | undefined,
  status: SparkReproWorkStatus,
  independentReadyCount: number,
  tasks: readonly SparkReproWorkTask[],
  activeExperiment: SparkReproActiveExperiment | undefined,
): SparkReproSchedulerActivity {
  const derived =
    status === "complete"
      ? "sealed"
      : activeExperiment?.status === "running" || tasks.some((task) => task.status === "running")
        ? "running"
        : independentReadyCount > 0
          ? "ready"
          : "dormant";
  const activity = requested ?? derived;
  assertOneOf(activity, ["running", "ready", "dormant", "sealed"] as const, "schedulerActivity");
  if (status === "complete" && activity !== "sealed") {
    throw new Error("complete work summary requires schedulerActivity=sealed");
  }
  if (status !== "complete" && activity === "sealed") {
    throw new Error("schedulerActivity=sealed requires status=complete");
  }
  if (activity === "ready" && independentReadyCount === 0) {
    throw new Error("schedulerActivity=ready requires independentReadyCount > 0");
  }
  if (
    activity === "dormant" &&
    (independentReadyCount > 0 ||
      activeExperiment?.status === "running" ||
      tasks.some((task) => task.status === "running"))
  ) {
    throw new Error("schedulerActivity=dormant requires no ready or running independent work");
  }
  return activity;
}

function profileMatchesAcceptance(
  profile: SparkReproProfile,
  acceptance: SparkReproProfile,
): boolean {
  const left = canonicalProfile(profile);
  const right = canonicalProfile(acceptance);
  return (
    left.id === right.id &&
    left.modelScope === right.modelScope &&
    left.computeScope === right.computeScope &&
    left.steps.completed === right.steps.completed &&
    left.steps.target === right.steps.target &&
    topologyEquals(left.validationTopology!, right.validationTopology!) &&
    JSON.stringify(canonicalStrategies(left.validationTopology!.strategies ?? [])) ===
      JSON.stringify(canonicalStrategies(right.validationTopology!.strategies ?? [])) &&
    JSON.stringify(left.runtime) === JSON.stringify(right.runtime)
  );
}

function profileModelScope(profile: SparkReproProfile): SparkReproModelScope {
  return profile.modelScope ?? profile.model;
}

function profileComputeScope(profile: SparkReproProfile): SparkReproComputeScope {
  return profile.computeScope ?? profile.compute;
}

function profileTopology(profile: SparkReproProfile): SparkReproTopology {
  return profile.validationTopology ?? profile.topology;
}

function canonicalProfile(profile: SparkReproProfile): SparkReproProfile {
  const topology = canonicalTopology(profileTopology(profile));
  const runtimeUnknown =
    profile.runtime === undefined || profile.unknownFields?.includes("runtime");
  const runtime = profile.runtime
    ? { ...profile.runtime }
    : {
        framework: "unknown",
        device: "unknown",
        dtype: "unknown",
        hardware: "unknown",
        modelRevision: "unknown",
        configDigest: "unknown",
      };
  return {
    id: profile.id,
    model: profileModelScope(profile),
    compute: profileComputeScope(profile),
    modelScope: profileModelScope(profile),
    computeScope: profileComputeScope(profile),
    steps: { ...profile.steps },
    topology: canonicalTopology(topology),
    validationTopology: canonicalTopology(topology),
    runtime,
    ...(runtimeUnknown ? { unknownFields: ["runtime"] as Array<"runtime"> } : {}),
  };
}

function canonicalTopology(topology: SparkReproTopology): SparkReproTopology {
  const unknownFields = new Set(topology.unknownFields ?? []);
  if (topology.etp === undefined) unknownFields.add("etp");
  if (topology.worldSize === undefined) unknownFields.add("worldSize");
  if (topology.strategies === undefined) unknownFields.add("strategies");
  const etp = topology.etp ?? 1;
  const worldSize = topology.worldSize ?? expectedTopologyWorldSize({ ...topology, etp });
  const suppliedStrategies = topology.strategies;
  const strategies =
    suppliedStrategies &&
    (suppliedStrategies.length > 0 || activeTopologyStrategies(topology).length === 0)
      ? suppliedStrategies
      : compatibilityStrategies(topology);
  return {
    dp: topology.dp,
    tp: topology.tp,
    pp: topology.pp,
    ep: topology.ep,
    etp,
    cp: topology.cp,
    sp: topology.sp,
    worldSize,
    strategies: canonicalStrategies(strategies),
    ...(unknownFields.size > 0
      ? { unknownFields: [...unknownFields].sort() as Array<"etp" | "worldSize" | "strategies"> }
      : {}),
  };
}

function compatibilityStrategies(topology: SparkReproTopology): SparkReproStrategyEntry[] {
  return activeTopologyStrategies(topology).map((axis) => ({
    axis,
    id: `legacy:${axis}`,
    source: "reference",
    revision: "legacy-unknown",
    configDigest: "legacy-unknown",
  }));
}

function canonicalStrategies(
  strategies: readonly SparkReproStrategyEntry[],
): SparkReproStrategyEntry[] {
  return strategies
    .map((strategy) => ({ ...strategy }))
    .sort((left, right) => strategyKey(left).localeCompare(strategyKey(right)));
}

function strategyKey(strategy: SparkReproStrategyEntry): string {
  return [
    strategy.axis,
    strategy.id,
    strategy.source,
    strategy.revision,
    strategy.configDigest,
  ].join("\u0000");
}

function activeTopologyStrategies(topology: SparkReproTopology): SparkReproDistributedStrategy[] {
  const active: SparkReproDistributedStrategy[] = [];
  if (topology.dp > 1) active.push("dp");
  if (topology.tp > 1) active.push("tp");
  if (topology.pp > 1) active.push("pp");
  if (topology.ep > 1) active.push("ep");
  if ((topology.etp ?? 1) > 1) active.push("etp");
  if (topology.cp > 1) active.push("cp");
  if (topology.sp) active.push("sp");
  return active;
}

function topologyEquals(left: SparkReproTopology, right: SparkReproTopology): boolean {
  const l = canonicalTopology(left);
  const r = canonicalTopology(right);
  return (
    l.dp === r.dp &&
    l.tp === r.tp &&
    l.pp === r.pp &&
    l.ep === r.ep &&
    l.etp === r.etp &&
    l.cp === r.cp &&
    l.sp === r.sp &&
    l.worldSize === r.worldSize &&
    JSON.stringify(l.unknownFields ?? []) === JSON.stringify(r.unknownFields ?? []) &&
    JSON.stringify(canonicalStrategies(l.strategies ?? [])) ===
      JSON.stringify(canonicalStrategies(r.strategies ?? []))
  );
}

function orderedStrategies(
  strategies: readonly SparkReproDistributedStrategy[],
): SparkReproDistributedStrategy[] {
  const values = new Set(strategies);
  return SPARK_REPRO_DISTRIBUTED_STRATEGIES.filter((value) => values.has(value));
}

function migrationValidationMatrix(
  gates: readonly SparkReproEvidenceGate[],
  acceptanceProfile: SparkReproProfile,
): SparkReproValidationMatrix {
  return {
    denominators: Object.fromEntries(
      SPARK_REPRO_WORK_STAGES.map((stage) => [stage, null]),
    ) as Record<SparkReproWorkStage, null>,
    rows: gates.map((gate) => ({
      id: `legacy-probe:${gate.id}`,
      gateId: gate.id,
      stage: gate.stage,
      invocationClass: "isolated_diagnostic",
      evidenceClass: "probe",
      verdict: gate.status,
      profile: canonicalProfile(gate.profile ?? acceptanceProfile),
      repetitions: 1,
      exactScope: "legacy authority unknown",
      evidenceRefs: [...gate.evidenceRefs],
      artifactRefs: [],
    })),
  };
}

function compatibilityValidationMatrix(
  gates: readonly SparkReproEvidenceGate[],
  acceptanceProfile: SparkReproProfile,
): SparkReproValidationMatrix {
  const denominators = Object.fromEntries(
    SPARK_REPRO_WORK_STAGES.map((stage) => [
      stage,
      gates
        .filter((gate) => gate.stage === stage && gateCountsTowardProgress(gate))
        .reduce((total, gate) => total + gate.weight, 0),
    ]),
  ) as Record<SparkReproWorkStage, number>;
  return {
    denominators,
    rows: gates.map((gate) => ({
      id: `compat:${gate.id}`,
      gateId: gate.id,
      stage: gate.stage,
      invocationClass:
        gate.evidenceClass === "formal" ? "owning_entrypoint" : "isolated_diagnostic",
      evidenceClass: gate.evidenceClass === "formal" ? "entrypoint" : "probe",
      verdict: gate.status,
      profile: canonicalProfile(gate.profile ?? acceptanceProfile),
      repetitions: 1,
      exactScope: "compatibility gate projection",
      evidenceRefs: [...gate.evidenceRefs],
      artifactRefs: [],
    })),
  };
}

function normalizeRetirementBlocks(
  input: number | SparkReproRetirementBlock[] | undefined,
  decisions: readonly SparkReproDecisionRequest[],
): SparkReproRetirementBlock[] {
  const blocks = Array.isArray(input)
    ? input.map((block) => ({ ...block }))
    : (() => {
        const count = input ?? 0;
        assertNonNegativeInteger(count, "retirementBlocks");
        return Array.from(
          { length: count },
          (_, index): SparkReproRetirementBlock => ({
            id: `unspecified:${index + 1}`,
            kind: "decision",
            ownerStepId: "unknown",
            reason: "A required Normative retirement remains blocked",
          }),
        );
      })();
  const ids = new Set(blocks.map((block) => block.id));
  for (const decision of decisions) {
    const id = `decision:${decision.id}`;
    if (ids.has(id)) continue;
    blocks.push({
      id,
      kind: decision.kind === "external_publish" ? "approval" : "decision",
      ownerStepId: `${decision.blockedTransition.from}->${decision.blockedTransition.to}`,
      reason: decision.question,
      askRef: decision.askRef,
    });
  }
  return blocks;
}

function legacyExploreFrontier(
  input: SparkReproWorkSummaryInput,
  profile: SparkReproProfile,
): SparkReproExploreFrontier {
  return {
    stage: input.frontier?.stage ?? input.stage,
    profile: canonicalProfile(input.frontier?.profile ?? profile),
    planRevision: 1,
    evidenceRefs: [],
    unresolvedIds: [],
  };
}

function emptyNormativeCursor(planRevision: number): SparkReproNormativeCursor {
  return {
    planRevision,
    orderedStepIds: [],
    retiredStepIds: [],
    candidateBuffer: [],
    retirementLog: [],
  };
}

function unknownNumericalFrontier(topology: SparkReproTopology): SparkReproNumericalFrontier {
  const unknown = (reason: string): SparkReproBoundaryClaim => ({
    status: "not_established",
    reason,
    evidenceRefs: [],
  });
  return {
    claims: {
      native_module_boundary: "not_established",
      derived_reference_boundary: "not_established",
      native_internal_boundary: "not_established",
    },
    lastGood: unknown("no accepted numerical boundary evidence"),
    firstBad: unknown("no accepted numerical boundary evidence"),
    equalityRule: "raw_bits",
    comparedInventory: { quantified: false, reason: "inventory denominator is unknown" },
    exactCoverage: {
      quantified: false,
      tensors: null,
      elements: null,
      steps: null,
      topology: canonicalTopology(topology),
    },
    difference: { maxAbsDiff: null, maxUlp: null, signedZeroEqual: null },
    activeBlocker: "numerical frontier is not established",
  };
}

function unknownNextAction(cursor: SparkReproNormativeCursor): SparkReproNextAction {
  return cursor.currentStepId
    ? {
        id: `retire:${cursor.currentStepId}`,
        summary: `Retire Normative step ${cursor.currentStepId}`,
        passCriterion: "A current revision-bound typed verifier accepts the step",
      }
    : {
        id: "record-next-action",
        summary: "Record the next typed Repro action",
        passCriterion: "A bounded action and binary pass criterion are present",
      };
}

function cloneTechnicalTarget(
  target: SparkReproTechnicalTarget,
  acceptanceProfile: SparkReproProfile,
): SparkReproTechnicalTarget {
  return {
    model: "minimum_complete",
    requiredSteps: target.requiredSteps,
    referenceStrategies: orderedStrategies(target.referenceStrategies),
    validationTopology: canonicalTopology(target.validationTopology),
    acceptanceProfile: canonicalProfile(acceptanceProfile),
  };
}

function cloneGate(gate: SparkReproEvidenceGate): SparkReproEvidenceGate {
  return {
    ...gate,
    evidenceRefs: [...gate.evidenceRefs],
    ...(gate.profile ? { profile: canonicalProfile(gate.profile) } : {}),
    ...(gate.establishes ? { establishes: [...gate.establishes] } : {}),
  };
}

function cloneDecision(decision: SparkReproDecisionRequest): SparkReproDecisionRequest {
  return {
    ...decision,
    options: decision.options.map((option) => ({ ...option })),
    blockedTransition: { ...decision.blockedTransition },
    evidenceRefs: [...decision.evidenceRefs],
  };
}

function cloneExperiment(experiment: SparkReproExperiment): SparkReproExperiment {
  return {
    ...experiment,
    profile: canonicalProfile(experiment.profile),
    evidenceRefs: [...experiment.evidenceRefs],
  };
}

function cloneFrontier(frontier: SparkReproFrontier): SparkReproFrontier {
  return {
    ...frontier,
    profile: canonicalProfile(frontier.profile),
    ...(frontier.lastGood ? { lastGood: { ...frontier.lastGood } } : {}),
    ...(frontier.firstBad ? { firstBad: { ...frontier.firstBad } } : {}),
    ...(frontier.activeExperiment
      ? { activeExperiment: cloneExperiment(frontier.activeExperiment) }
      : {}),
  };
}

function cloneExploreFrontier(frontier: SparkReproExploreFrontier): SparkReproExploreFrontier {
  return {
    ...frontier,
    profile: canonicalProfile(frontier.profile),
    evidenceRefs: [...frontier.evidenceRefs],
    unresolvedIds: [...frontier.unresolvedIds],
  };
}

function cloneCandidate(candidate: SparkReproRetirementCandidate): SparkReproRetirementCandidate {
  return {
    ...candidate,
    dependsOn: [...candidate.dependsOn],
    profile: canonicalProfile(candidate.profile),
    evidenceRefs: [...candidate.evidenceRefs],
    unresolvedIds: [...candidate.unresolvedIds],
  };
}

function cloneNormativeCursor(cursor: SparkReproNormativeCursor): SparkReproNormativeCursor {
  return {
    ...cursor,
    orderedStepIds: [...cursor.orderedStepIds],
    ...(cursor.stepDefinitionDigests
      ? { stepDefinitionDigests: { ...cursor.stepDefinitionDigests } }
      : {}),
    ...(cursor.stepDependencies
      ? {
          stepDependencies: Object.fromEntries(
            Object.entries(cursor.stepDependencies).map(([stepId, dependencies]) => [
              stepId,
              [...dependencies],
            ]),
          ),
        }
      : {}),
    retiredStepIds: [...cursor.retiredStepIds],
    candidateBuffer: cursor.candidateBuffer.map(cloneCandidate),
    retirementLog: cursor.retirementLog.map((record) => ({
      ...record,
      profile: canonicalProfile(record.profile),
      evidenceRefs: [...record.evidenceRefs],
    })),
  };
}

function cloneUnresolved(item: SparkReproUnresolvedItem): SparkReproUnresolvedItem {
  return { ...item, evidenceRefs: [...item.evidenceRefs] };
}

function cloneValidationMatrix(matrix: SparkReproValidationMatrix): SparkReproValidationMatrix {
  return {
    denominators: { ...matrix.denominators },
    rows: matrix.rows.map((row) => ({
      ...row,
      profile: canonicalProfile(row.profile),
      evidenceRefs: [...row.evidenceRefs],
      artifactRefs: [...row.artifactRefs],
    })),
  };
}

function cloneBoundaryClaim(claim: SparkReproBoundaryClaim): SparkReproBoundaryClaim {
  return claim.status === "established"
    ? {
        status: "established",
        location: { ...claim.location },
        evidenceRefs: [...claim.evidenceRefs],
      }
    : { status: "not_established", reason: claim.reason, evidenceRefs: [...claim.evidenceRefs] };
}

function cloneNumericalFrontier(
  frontier: SparkReproNumericalFrontier,
): SparkReproNumericalFrontier {
  return {
    claims: { ...frontier.claims },
    lastGood: cloneBoundaryClaim(frontier.lastGood),
    firstBad: cloneBoundaryClaim(frontier.firstBad),
    equalityRule: frontier.equalityRule,
    comparedInventory: { ...frontier.comparedInventory },
    exactCoverage: {
      ...frontier.exactCoverage,
      topology: canonicalTopology(frontier.exactCoverage.topology),
    },
    difference: { ...frontier.difference },
    activeBlocker: frontier.activeBlocker,
  };
}

function cloneActiveExperiment(experiment: SparkReproActiveExperiment): SparkReproActiveExperiment {
  return {
    ...experiment,
    profile: canonicalProfile(experiment.profile),
    outputEvidencePaths: [...experiment.outputEvidencePaths],
    evidenceRefs: [...experiment.evidenceRefs],
  };
}

function cloneConclusion(conclusion: SparkReproConclusion): SparkReproConclusion {
  return {
    ...conclusion,
    profile: canonicalProfile(conclusion.profile),
    evidenceRefs: [...conclusion.evidenceRefs],
  };
}

function workSummaryV2ToInput(summary: SparkReproWorkSummary): SparkReproWorkSummaryInput {
  return {
    schema: SPARK_REPRO_WORK_SUMMARY_SCHEMA,
    ...(summary.migration ? { migration: summary.migration } : {}),
    reproId: summary.reproId,
    title: summary.title,
    stage: summary.stage,
    target: summary.target,
    profile: summary.profile,
    gates: summary.gates,
    pendingDecisions: summary.pendingDecisions,
    ...(summary.frontier ? { frontier: summary.frontier } : {}),
    exploreFrontier: summary.exploreFrontier,
    normativeCursor: summary.normativeCursor,
    schedulerActivity: summary.schedulerActivity,
    independentReadyCount: summary.independentReadyCount,
    retirementBlocks: summary.retirementBlockers,
    unresolved: summary.unresolved,
    validationMatrix: summary.validationMatrix,
    numericalFrontier: summary.numericalFrontier,
    nextAction: summary.nextAction,
    ...(summary.activeExperiment ? { activeExperiment: summary.activeExperiment } : {}),
    tasks: summary.tasks,
    todos: summary.todos,
    conclusions: summary.conclusions,
    artifactRefs: summary.artifactRefs,
    ...(summary.reportArtifactRef ? { reportArtifactRef: summary.reportArtifactRef } : {}),
  };
}

function uniqueEvidenceRefs(refs: readonly EvidenceRef[]): EvidenceRef[] {
  return [...new Set(refs)];
}

function validateEvidenceRefs(refs: readonly EvidenceRef[], field: string): void {
  for (const [index, ref] of refs.entries()) {
    if (typeof ref !== "string" || !isRef(ref, "evidence")) {
      throw new Error(`${field}[${index}] must be an evidence: ref`);
    }
  }
}

function validateArtifactRef(ref: ArtifactRef, field: string): void {
  if (typeof ref !== "string" || !isRef(ref, "artifact")) {
    throw new Error(`${field} must be an artifact: ref`);
  }
}

function uniqueArtifactRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const unique: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const [index, ref] of refs.entries()) {
    validateArtifactRef(ref, `artifactRefs[${index}]`);
    if (seen.has(ref)) continue;
    seen.add(ref);
    unique.push(ref);
  }
  return unique;
}

function validateUniqueIds(values: readonly { id: string }[], field: string): void {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    assertNonEmpty(value.id, `${field}[${index}].id`);
    if (ids.has(value.id)) throw new Error(`${field} ids must be unique: ${value.id}`);
    ids.add(value.id);
  }
}

function validateStringIds(values: readonly string[], field: string): void {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    assertNonEmpty(value, `${field}[${index}]`);
    if (ids.has(value)) throw new Error(`${field} must be unique: ${value}`);
    ids.add(value);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty`);
}

function assertOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${field} has an unsupported value: ${String(value)}`);
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function stageIndex(stage: SparkReproWorkStage): number {
  return SPARK_REPRO_WORK_STAGES.indexOf(stage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
