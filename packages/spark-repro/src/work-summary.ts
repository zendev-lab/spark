import {
  isRef,
  type ArtifactRef,
  type AskRef,
  type EvidenceRef,
  type TaskRef,
} from "@zendev-lab/spark-core";

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
export type SparkReproModelScope = "minimum_complete" | "reduced" | "probe";
export type SparkReproComputeScope = "forward" | "backward" | "optimizer" | "checkpoint";
export type SparkReproDistributedStrategy = "dp" | "tp" | "pp" | "ep" | "cp" | "sp";

const SPARK_REPRO_MODEL_SCOPES = ["minimum_complete", "reduced", "probe"] as const;
const SPARK_REPRO_COMPUTE_SCOPES = ["forward", "backward", "optimizer", "checkpoint"] as const;
const SPARK_REPRO_DISTRIBUTED_STRATEGIES = ["dp", "tp", "pp", "ep", "cp", "sp"] as const;

export interface SparkReproTopology {
  dp: number;
  tp: number;
  pp: number;
  ep: number;
  cp: number;
  sp: boolean;
}

export const SPARK_REPRO_SINGLE_PROCESS_TOPOLOGY: SparkReproTopology = {
  dp: 1,
  tp: 1,
  pp: 1,
  ep: 1,
  cp: 1,
  sp: false,
};

export interface SparkReproProfile {
  id: string;
  model: SparkReproModelScope;
  compute: SparkReproComputeScope;
  steps: {
    completed: number;
    target: number;
  };
  topology: SparkReproTopology;
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
  operator?: string;
  tensor?: string;
  rank?: number;
}

export type SparkReproExperimentStatus = "queued" | "running" | "passed" | "failed";

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

export interface SparkReproFrontier {
  stage: SparkReproWorkStage;
  profile: SparkReproProfile;
  lastGood?: SparkReproOperatorLocation;
  firstBad?: SparkReproOperatorLocation;
  activeExperiment?: SparkReproExperiment;
  blocker?: string;
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
}

export interface SparkReproStageProgress {
  stage: SparkReproWorkStage;
  stageWeight: number;
  acceptedGateWeight: number;
  totalGateWeight: number;
  acceptedGateIds: string[];
  percent: number;
  contribution: number;
}

export interface SparkReproProgress {
  percent: number;
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

export interface SparkReproWorkSummaryInput {
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
  /** Stable per-run Markdown report Document binding. */
  reportArtifactRef?: ArtifactRef;
}

/** Canonical cross-surface write model; legacy session state is an input adapter concern. */
export interface SparkReproWorkSummary {
  schema: "spark.repro.work-summary/v1";
  reproId: string;
  title: string;
  status: SparkReproWorkStatus;
  stage: SparkReproWorkStage;
  target: SparkReproTechnicalTarget;
  profile: SparkReproProfile;
  progress: SparkReproProgress;
  technicalGoal: SparkReproTechnicalGoal;
  pendingDecisions: SparkReproDecisionRequest[];
  gates: SparkReproEvidenceGate[];
  tasks: SparkReproWorkTask[];
  todos: SparkReproTodo[];
  conclusions: SparkReproConclusion[];
  artifactRefs: ArtifactRef[];
  reportArtifactRef?: ArtifactRef;
  frontier?: SparkReproFrontier;
}

export function buildSparkReproWorkSummary(
  input: SparkReproWorkSummaryInput,
): SparkReproWorkSummary {
  assertNonEmpty(input.reproId, "reproId");
  assertNonEmpty(input.title, "title");
  assertOneOf(input.stage, SPARK_REPRO_WORK_STAGES, "stage");
  validateTechnicalTarget(input.target);

  const profile = cloneProfile(input.profile);
  validateProfile(profile, input.target, "profile");
  const gates = input.gates.map(cloneGate);
  validateUniqueIds(gates, "gates");
  for (const [index, gate] of gates.entries()) {
    validateGate(gate, input.target, `gates[${index}]`);
  }

  const pendingDecisions = (input.pendingDecisions ?? []).map(cloneDecision);
  validateUniqueIds(pendingDecisions, "pendingDecisions");
  for (const [index, decision] of pendingDecisions.entries()) {
    validateDecision(decision, `pendingDecisions[${index}]`);
  }

  const tasks = (input.tasks ?? []).map((task) => ({ ...task }));
  validateUniqueIds(tasks, "tasks");
  for (const [index, task] of tasks.entries()) {
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
  const todos = (input.todos ?? []).map((todo) => ({ ...todo }));
  validateUniqueIds(todos, "todos");
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const [index, todo] of todos.entries()) {
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

  const conclusions = (input.conclusions ?? []).map(cloneConclusion);
  validateUniqueIds(conclusions, "conclusions");
  for (const [index, conclusion] of conclusions.entries()) {
    assertNonEmpty(conclusion.claim, `conclusions[${index}].claim`);
    assertOneOf(
      conclusion.verdict,
      ["confirmed", "rejected", "inconclusive", "superseded"] as const,
      `conclusions[${index}].verdict`,
    );
    validateProfile(conclusion.profile, input.target, `conclusions[${index}].profile`);
    validateEvidenceRefs(conclusion.evidenceRefs, `conclusions[${index}].evidenceRefs`);
    if (
      (conclusion.verdict === "confirmed" || conclusion.verdict === "rejected") &&
      conclusion.evidenceRefs.length === 0
    ) {
      throw new Error(`conclusions[${index}] requires evidence for ${conclusion.verdict}`);
    }
  }

  const frontier = input.frontier ? cloneFrontier(input.frontier) : undefined;
  if (frontier) validateFrontier(frontier, input.stage, input.target);
  const artifactRefs = uniqueArtifactRefs([
    ...(input.reportArtifactRef ? [input.reportArtifactRef] : []),
    ...(input.artifactRefs ?? []),
  ]);
  if (input.reportArtifactRef) {
    validateArtifactRef(input.reportArtifactRef, "reportArtifactRef");
  }

  const progress = calculateSparkReproProgress(gates);
  const technicalGoal = deriveSparkReproTechnicalGoal(input.target, gates);
  const status: SparkReproWorkStatus =
    pendingDecisions.length > 0
      ? "waiting_decision"
      : progress.percent === 100 && technicalGoal.achieved
        ? "complete"
        : "active";
  if (status === "complete" && input.stage !== "delivery") {
    throw new Error("a complete work summary must be at the delivery stage");
  }

  return {
    schema: "spark.repro.work-summary/v1",
    reproId: input.reproId.trim(),
    title: input.title.trim(),
    status,
    stage: input.stage,
    target: {
      model: "minimum_complete",
      requiredSteps: input.target.requiredSteps,
      referenceStrategies: orderedStrategies(input.target.referenceStrategies),
      validationTopology: { ...input.target.validationTopology },
    },
    profile,
    progress,
    technicalGoal,
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
): SparkReproProgress {
  const stages = SPARK_REPRO_WORK_STAGES.map((stage): SparkReproStageProgress => {
    const eligible = gates.filter((gate) => gate.stage === stage && gateCountsTowardProgress(gate));
    if (eligible.length === 0) {
      throw new Error(`stage ${stage} requires at least one formal minimum-complete gate`);
    }
    const totalGateWeight = eligible.reduce((total, gate) => total + gate.weight, 0);
    const accepted = eligible.filter((gate) => gate.status === "accepted");
    const acceptedGateWeight = accepted.reduce((total, gate) => total + gate.weight, 0);
    const percent = roundPercent((acceptedGateWeight / totalGateWeight) * 100);
    const stageWeight = SPARK_REPRO_STAGE_WEIGHTS[stage];
    return {
      stage,
      stageWeight,
      acceptedGateWeight,
      totalGateWeight,
      acceptedGateIds: accepted.map((gate) => gate.id),
      percent,
      contribution: roundPercent((acceptedGateWeight / totalGateWeight) * stageWeight),
    };
  });
  return {
    percent: roundPercent(stages.reduce((total, stage) => total + stage.contribution, 0)),
    stages,
  };
}

export function deriveSparkReproTechnicalGoal(
  target: SparkReproTechnicalTarget,
  gates: readonly SparkReproEvidenceGate[],
): SparkReproTechnicalGoal {
  const accepted = gates.filter(
    (gate) => gate.status === "accepted" && gateCountsTowardProgress(gate),
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
      topologyEquals(gate.profile!.topology, target.validationTopology),
  );
  const validatedReferenceStrategies = parityGate
    ? activeTopologyStrategies(parityGate.profile!.topology)
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

function gateCountsTowardProgress(gate: SparkReproEvidenceGate): boolean {
  if (gate.evidenceClass !== "formal") return false;
  if (gate.stage === "contract" || gate.stage === "delivery") {
    return gate.profile === undefined || gate.profile.model === "minimum_complete";
  }
  return gate.profile?.model === "minimum_complete";
}

function hasMinimumCompleteOptimizerProfile(gate: SparkReproEvidenceGate): boolean {
  return gate.profile?.model === "minimum_complete" && gate.profile.compute === "optimizer";
}

function hasMinimumCompleteTrainingStep(gate: SparkReproEvidenceGate): boolean {
  return hasMinimumCompleteOptimizerProfile(gate) && gate.profile!.steps.completed >= 1;
}

function validateTechnicalTarget(target: SparkReproTechnicalTarget): void {
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
  validateTopology(target.validationTopology, "target.validationTopology");
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
): void {
  assertNonEmpty(gate.title, `${field}.title`);
  assertOneOf(gate.stage, SPARK_REPRO_WORK_STAGES, `${field}.stage`);
  assertOneOf(gate.evidenceClass, ["formal", "diagnostic"] as const, `${field}.evidenceClass`);
  assertOneOf(gate.status, ["open", "accepted", "rejected"] as const, `${field}.status`);
  if (!Number.isFinite(gate.weight) || gate.weight <= 0) {
    throw new Error(`${field}.weight must be a positive number`);
  }
  if (gate.profile) validateProfile(gate.profile, target, `${field}.profile`);
  validateEvidenceRefs(gate.evidenceRefs, `${field}.evidenceRefs`);
  if (
    gate.evidenceClass === "formal" &&
    gate.status === "accepted" &&
    gate.evidenceRefs.length === 0
  ) {
    throw new Error(`${field} cannot accept a formal gate without evidence`);
  }
  if (gate.establishes && gate.establishes.length > 0) {
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
      if (criteria.has(criterion)) {
        throw new Error(`${field}.establishes must be unique`);
      }
      criteria.add(criterion);
      validateTechnicalCriterionGate(gate, criterion, target, field);
    }
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
  if (!gate.profile || gate.profile.model !== "minimum_complete") {
    throw new Error(`${field} establishes ${criterion} without a minimum_complete profile`);
  }
  if (gate.profile.compute !== "optimizer") {
    throw new Error(`${field} establishes ${criterion} without an optimizer transaction`);
  }
  if (criterion === "required_steps_aligned" && gate.profile.steps.target < target.requiredSteps) {
    throw new Error(`${field} cannot establish required_steps_aligned below requiredSteps`);
  }
  if (
    criterion === "reference_parity" &&
    !topologyEquals(gate.profile.topology, target.validationTopology)
  ) {
    throw new Error(`${field} cannot establish reference_parity outside validationTopology`);
  }
}

function validateProfile(
  profile: SparkReproProfile,
  target: SparkReproTechnicalTarget,
  field: string,
): void {
  assertNonEmpty(profile.id, `${field}.id`);
  assertOneOf(profile.model, SPARK_REPRO_MODEL_SCOPES, `${field}.model`);
  assertOneOf(profile.compute, SPARK_REPRO_COMPUTE_SCOPES, `${field}.compute`);
  assertNonNegativeInteger(profile.steps.completed, `${field}.steps.completed`);
  assertPositiveInteger(profile.steps.target, `${field}.steps.target`);
  if (profile.steps.completed > profile.steps.target) {
    throw new Error(`${field}.steps.completed cannot exceed target`);
  }
  validateTopology(profile.topology, `${field}.topology`);
  const unsupported = activeTopologyStrategies(profile.topology).filter(
    (strategy) => !target.referenceStrategies.includes(strategy),
  );
  if (unsupported.length > 0) {
    throw new Error(`${field}.topology expands beyond reference parity: ${unsupported.join(", ")}`);
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

function validateFrontier(
  frontier: SparkReproFrontier,
  currentStage: SparkReproWorkStage,
  target: SparkReproTechnicalTarget,
): void {
  if (frontier.stage !== currentStage) {
    throw new Error("frontier.stage must match the summary stage");
  }
  validateProfile(frontier.profile, target, "frontier.profile");
  if (frontier.lastGood) validateOperatorLocation(frontier.lastGood, "frontier.lastGood");
  if (frontier.firstBad) validateOperatorLocation(frontier.firstBad, "frontier.firstBad");
  if (frontier.activeExperiment) {
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
    assertNonEmpty(
      experiment.falsificationOutcome,
      "frontier.activeExperiment.falsificationOutcome",
    );
    validateProfile(experiment.profile, target, "frontier.activeExperiment.profile");
    validateEvidenceRefs(experiment.evidenceRefs, "frontier.activeExperiment.evidenceRefs");
  }
}

function validateOperatorLocation(location: SparkReproOperatorLocation, field: string): void {
  assertNonNegativeInteger(location.step, `${field}.step`);
  assertNonEmpty(location.boundary, `${field}.boundary`);
  if (location.rank !== undefined) assertNonNegativeInteger(location.rank, `${field}.rank`);
}

function activeTopologyStrategies(topology: SparkReproTopology): SparkReproDistributedStrategy[] {
  const active: SparkReproDistributedStrategy[] = [];
  if (topology.dp > 1) active.push("dp");
  if (topology.tp > 1) active.push("tp");
  if (topology.pp > 1) active.push("pp");
  if (topology.ep > 1) active.push("ep");
  if (topology.cp > 1) active.push("cp");
  if (topology.sp) active.push("sp");
  return active;
}

function validateTopology(topology: SparkReproTopology, field: string): void {
  for (const dimension of ["dp", "tp", "pp", "ep", "cp"] as const) {
    assertPositiveInteger(topology[dimension], `${field}.${dimension}`);
  }
  if (typeof topology.sp !== "boolean") {
    throw new Error(`${field}.sp must be a boolean`);
  }
}

function topologyEquals(left: SparkReproTopology, right: SparkReproTopology): boolean {
  return (
    left.dp === right.dp &&
    left.tp === right.tp &&
    left.pp === right.pp &&
    left.ep === right.ep &&
    left.cp === right.cp &&
    left.sp === right.sp
  );
}

function orderedStrategies(
  strategies: readonly SparkReproDistributedStrategy[],
): SparkReproDistributedStrategy[] {
  const values = new Set(strategies);
  return SPARK_REPRO_DISTRIBUTED_STRATEGIES.filter((value) => values.has(value));
}

function cloneProfile(profile: SparkReproProfile): SparkReproProfile {
  return {
    ...profile,
    steps: { ...profile.steps },
    topology: { ...profile.topology },
  };
}

function cloneGate(gate: SparkReproEvidenceGate): SparkReproEvidenceGate {
  return {
    ...gate,
    evidenceRefs: [...gate.evidenceRefs],
    ...(gate.profile ? { profile: cloneProfile(gate.profile) } : {}),
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
    profile: cloneProfile(experiment.profile),
    evidenceRefs: [...experiment.evidenceRefs],
  };
}

function cloneFrontier(frontier: SparkReproFrontier): SparkReproFrontier {
  return {
    ...frontier,
    profile: cloneProfile(frontier.profile),
    ...(frontier.lastGood ? { lastGood: { ...frontier.lastGood } } : {}),
    ...(frontier.firstBad ? { firstBad: { ...frontier.firstBad } } : {}),
    ...(frontier.activeExperiment
      ? { activeExperiment: cloneExperiment(frontier.activeExperiment) }
      : {}),
  };
}

function cloneConclusion(conclusion: SparkReproConclusion): SparkReproConclusion {
  return {
    ...conclusion,
    profile: cloneProfile(conclusion.profile),
    evidenceRefs: [...conclusion.evidenceRefs],
  };
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
