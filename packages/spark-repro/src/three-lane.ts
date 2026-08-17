import {
  isRef,
  type ArtifactRef,
  type EvidenceRef,
  type RunRef,
  type TaskRef,
} from "@zendev-lab/spark-core";

type SparkReproStageName = "contract" | "reference" | "target" | "alignment" | "delivery";

interface SparkReproThreeLanePlanInput {
  currentRevision: number;
  steps: Array<{
    id: string;
    stage: SparkReproStageName;
    status: string;
  }>;
}

interface SparkReproDualLaneSessionInput {
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
}

export const SPARK_REPRO_THREE_LANE_SESSION_SCHEMA = "spark.repro.three-lane-session/v1" as const;

export const SPARK_REPRO_LANES = ["implementation", "exactness", "formalize"] as const;
export type SparkReproLane = (typeof SPARK_REPRO_LANES)[number];

export type SparkReproWorkItemStatus = "open" | "blocked" | "completed" | "superseded";

/**
 * Stable concern identity scoped by the owning Repro id. Commit materialization
 * may change after a rebase without changing `workItemId`.
 */
export interface SparkReproWorkItem {
  workItemId: string;
  title: string;
  scope: string;
  planRevision: number;
  sourceRevision: string;
  status: SparkReproWorkItemStatus;
  taskRef?: TaskRef;
  runRef?: RunRef;
  gitChangeRef?: ArtifactRef;
  evidenceRefs: EvidenceRef[];
  unresolvedIds: string[];
}

export type SparkReproMismatchClassification =
  | "implementation_defect"
  | "semantic_difference"
  | "intrinsic_numerical"
  | "contract_environment"
  | "unknown";
export type SparkReproMismatchDisposition = "fix" | "adapt" | "accept" | "defer" | "skip";
export type SparkReproFindingConfidence = "suspected" | "confirmed";

export interface SparkReproAlignmentFinding {
  findingId: string;
  workItemId: string;
  firstBadBoundary: string;
  classification: SparkReproMismatchClassification;
  disposition: Exclude<SparkReproMismatchDisposition, "skip">;
  confidence: SparkReproFindingConfidence;
  evidenceRefs: EvidenceRef[];
}

export interface SparkReproUnresolvedMismatch {
  mismatchId: string;
  workItemId: string;
  firstBadBoundary: string;
  classification: SparkReproMismatchClassification;
  disposition: SparkReproMismatchDisposition;
  confidence: SparkReproFindingConfidence;
  evidenceRefs: EvidenceRef[];
  isolation?: {
    boundary: string;
    evidenceRefs: EvidenceRef[];
  };
  resynchronization?: {
    checkpoint: string;
    evidenceRefs: EvidenceRef[];
  };
}

export type SparkReproHandoffStatus = "pending" | "accepted" | "stale" | "superseded";

export interface SparkReproWorkHandoff {
  handoffId: string;
  workItemId: string;
  from: "implementation" | "exactness";
  to: "exactness" | "formalize";
  planRevision: number;
  sourceRevision: string;
  scope: string;
  findingIds: string[];
  evidenceRefs: EvidenceRef[];
  candidateRevisions: string[];
  dependsOnHandoffIds: string[];
  doneWhen: string[];
  status: SparkReproHandoffStatus;
}

export type SparkReproResolutionStatus = "resolved" | "superseded" | "rejected";

export interface SparkReproResolution {
  resolutionId: string;
  workItemId: string;
  from: "formalize" | "exactness";
  to: "exactness" | "implementation";
  status: SparkReproResolutionStatus;
  canonicalRevision: string;
  supersededRevisions: string[];
  evidenceRefs: EvidenceRef[];
  parentResolutionId?: string;
}

export interface SparkReproThreeLaneSessionState {
  schema: typeof SPARK_REPRO_THREE_LANE_SESSION_SCHEMA;
  planRevision: number;
  implementation: {
    stage: SparkReproStageName;
    observationIds: string[];
    workItemIds: string[];
  };
  exactness: {
    workItemIds: string[];
    findingIds: string[];
    mismatchIds: string[];
  };
  formalize: {
    orderedStepIds: string[];
    currentStepId?: string;
    retiredStepIds: string[];
    candidateIds: string[];
    workItemIds: string[];
    formalizedTip?: string;
    ownership?: {
      gitChangeRef: ArtifactRef;
      integratorSessionId: string;
    };
  };
  workItems: SparkReproWorkItem[];
  findings: SparkReproAlignmentFinding[];
  mismatches: SparkReproUnresolvedMismatch[];
  handoffs: SparkReproWorkHandoff[];
  resolutions: SparkReproResolution[];
  unresolvedIds: string[];
  migration: {
    sourceVersion: 6 | 7 | 8;
    legacyProofAuthority: "not_promoted";
  };
}

export function createSparkReproThreeLaneSessionState(
  plan: SparkReproThreeLanePlanInput,
  sourceVersion: 6 | 8 = 8,
): SparkReproThreeLaneSessionState {
  const orderedStepIds = normativeOrderedStepIds(plan);
  const retiredStepIds: string[] = [];
  if (sourceVersion === 8) {
    for (const stepId of orderedStepIds) {
      if (plan.steps.find((step) => step.id === stepId)?.status !== "done") break;
      retiredStepIds.push(stepId);
    }
  }
  const retired = new Set(retiredStepIds);
  const candidateIds =
    sourceVersion === 8
      ? orderedStepIds.filter(
          (stepId) =>
            plan.steps.find((step) => step.id === stepId)?.status === "done" &&
            !retired.has(stepId),
        )
      : [];
  const currentStepId = orderedStepIds.find((stepId) => !retired.has(stepId));
  return {
    schema: SPARK_REPRO_THREE_LANE_SESSION_SCHEMA,
    planRevision: plan.currentRevision,
    implementation: {
      stage: plan.steps.find((step) => step.id === orderedStepIds[0])?.stage ?? "contract",
      observationIds: [],
      workItemIds: [],
    },
    exactness: { workItemIds: [], findingIds: [], mismatchIds: [] },
    formalize: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds,
      workItemIds: [],
    },
    workItems: [],
    findings: [],
    mismatches: [],
    handoffs: [],
    resolutions: [],
    unresolvedIds: [],
    migration: { sourceVersion, legacyProofAuthority: "not_promoted" },
  };
}

/** Pure v7 -> v8 migration. It never fabricates Exactness or formal evidence. */
export function migrateSparkReproDualLaneSessionState(
  plan: SparkReproThreeLanePlanInput,
  prior: SparkReproDualLaneSessionInput,
): SparkReproThreeLaneSessionState {
  return {
    schema: SPARK_REPRO_THREE_LANE_SESSION_SCHEMA,
    planRevision: plan.currentRevision,
    implementation: {
      stage: prior.explore.stage,
      observationIds: [...prior.explore.observationIds],
      workItemIds: [],
    },
    exactness: { workItemIds: [], findingIds: [], mismatchIds: [] },
    formalize: {
      orderedStepIds: [...prior.normative.orderedStepIds],
      ...(prior.normative.currentStepId ? { currentStepId: prior.normative.currentStepId } : {}),
      retiredStepIds: [...prior.normative.retiredStepIds],
      candidateIds: [...prior.normative.candidateIds],
      workItemIds: [],
    },
    workItems: [],
    findings: [],
    mismatches: [],
    handoffs: [],
    resolutions: [],
    unresolvedIds: [...prior.unresolvedIds],
    migration: { sourceVersion: 7, legacyProofAuthority: "not_promoted" },
  };
}

export function rebaseSparkReproThreeLaneSessionState(
  plan: SparkReproThreeLanePlanInput,
  prior: SparkReproThreeLaneSessionState,
): SparkReproThreeLaneSessionState {
  const orderedStepIds = normativeOrderedStepIds(plan);
  return {
    ...cloneThreeLane(prior),
    planRevision: plan.currentRevision,
    formalize: {
      orderedStepIds,
      ...(orderedStepIds[0] ? { currentStepId: orderedStepIds[0] } : {}),
      retiredStepIds: [],
      candidateIds: [],
      workItemIds: [...prior.formalize.workItemIds],
      ...(prior.formalize.formalizedTip ? { formalizedTip: prior.formalize.formalizedTip } : {}),
      ...(prior.formalize.ownership ? { ownership: { ...prior.formalize.ownership } } : {}),
    },
  };
}

export function normalizeSparkReproThreeLaneSessionState(
  plan: SparkReproThreeLanePlanInput,
  prior: SparkReproThreeLaneSessionState,
): SparkReproThreeLaneSessionState {
  validateSparkReproThreeLaneSessionState(prior, plan);
  const orderedStepIds = normativeOrderedStepIds(plan);
  const previouslyRetired = new Set(prior.formalize.retiredStepIds);
  const verifiedIds = new Set([...prior.formalize.retiredStepIds, ...prior.formalize.candidateIds]);
  const retiredStepIds: string[] = [];
  for (const stepId of orderedStepIds) {
    const step = plan.steps.find((candidate) => candidate.id === stepId)!;
    if (step.status !== "done" || !previouslyRetired.has(step.id)) break;
    retiredStepIds.push(step.id);
  }
  const retired = new Set(retiredStepIds);
  const currentStepId = orderedStepIds[retiredStepIds.length];
  return {
    ...cloneThreeLane(prior),
    planRevision: plan.currentRevision,
    formalize: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds: orderedStepIds.filter(
        (id) =>
          verifiedIds.has(id) &&
          !retired.has(id) &&
          plan.steps.find((step) => step.id === id)?.status === "done",
      ),
      workItemIds: [...prior.formalize.workItemIds],
      ...(prior.formalize.formalizedTip ? { formalizedTip: prior.formalize.formalizedTip } : {}),
      ...(prior.formalize.ownership ? { ownership: { ...prior.formalize.ownership } } : {}),
    },
  };
}

export function synchronizeSparkReproThreeLaneSessionState(
  plan: SparkReproThreeLanePlanInput,
  prior: SparkReproThreeLaneSessionState,
  stepId: string,
  status: string,
): SparkReproThreeLaneSessionState {
  const orderedStepIds = normativeOrderedStepIds(plan);
  const verifiedIds = new Set([...prior.formalize.retiredStepIds, ...prior.formalize.candidateIds]);
  if (status === "done") verifiedIds.add(stepId);
  else verifiedIds.delete(stepId);
  const retiredStepIds: string[] = [];
  while (retiredStepIds.length < orderedStepIds.length) {
    const nextStepId = orderedStepIds[retiredStepIds.length]!;
    const step = plan.steps.find((candidate) => candidate.id === nextStepId)!;
    if (step.status !== "done" || !verifiedIds.has(nextStepId)) break;
    retiredStepIds.push(nextStepId);
  }
  const retired = new Set(retiredStepIds);
  const currentStepId = orderedStepIds[retiredStepIds.length];
  return {
    ...cloneThreeLane(prior),
    planRevision: plan.currentRevision,
    formalize: {
      orderedStepIds,
      ...(currentStepId ? { currentStepId } : {}),
      retiredStepIds,
      candidateIds: orderedStepIds.filter((id) => verifiedIds.has(id) && !retired.has(id)),
      workItemIds: [...prior.formalize.workItemIds],
      ...(prior.formalize.formalizedTip ? { formalizedTip: prior.formalize.formalizedTip } : {}),
      ...(prior.formalize.ownership ? { ownership: { ...prior.formalize.ownership } } : {}),
    },
  };
}

export function registerSparkReproWorkItem(
  state: SparkReproThreeLaneSessionState,
  lane: SparkReproLane,
  input: SparkReproWorkItem,
): SparkReproThreeLaneSessionState {
  validateWorkItem(input, state.planRevision);
  const existing = state.workItems.find((item) => item.workItemId === input.workItemId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(input)) {
      throw new Error(`workItemId already exists with different content: ${input.workItemId}`);
    }
    return state;
  }
  const next = cloneThreeLane(state);
  next.workItems.push(cloneWorkItem(input));
  laneWorkItemIds(next, lane).push(input.workItemId);
  return next;
}

export function rematerializeSparkReproWorkItem(
  state: SparkReproThreeLaneSessionState,
  input: {
    workItemId: string;
    expectedSourceRevision: string;
    sourceRevision: string;
    evidenceRefs: EvidenceRef[];
  },
): SparkReproThreeLaneSessionState {
  const item = assertWorkItem(state, input.workItemId);
  if (item.sourceRevision !== input.expectedSourceRevision) {
    throw new Error("stale work item materialization revision");
  }
  assertNonEmpty(input.sourceRevision, "sourceRevision");
  if (input.evidenceRefs.length === 0) {
    throw new Error("work item rematerialization requires evidence");
  }
  validateEvidenceRefs(input.evidenceRefs, "rematerialization.evidenceRefs");
  const next = cloneThreeLane(state);
  const index = next.workItems.findIndex((candidate) => candidate.workItemId === input.workItemId);
  next.workItems[index] = {
    ...next.workItems[index]!,
    sourceRevision: input.sourceRevision,
    evidenceRefs: [...new Set([...next.workItems[index]!.evidenceRefs, ...input.evidenceRefs])],
  };
  next.handoffs = next.handoffs.map((handoff) =>
    handoff.workItemId === input.workItemId &&
    handoff.sourceRevision === input.expectedSourceRevision &&
    handoff.status !== "superseded"
      ? { ...handoff, status: "stale" }
      : handoff,
  );
  return next;
}

export function bindSparkReproFormalizeOwnership(
  state: SparkReproThreeLaneSessionState,
  ownership: { gitChangeRef: ArtifactRef; integratorSessionId: string },
): SparkReproThreeLaneSessionState {
  if (!isRef(ownership.gitChangeRef, "artifact")) {
    throw new Error("Formalize ownership requires a git_change Artifact ref");
  }
  assertNonEmpty(ownership.integratorSessionId, "integratorSessionId");
  if (state.formalize.ownership) {
    if (JSON.stringify(state.formalize.ownership) !== JSON.stringify(ownership)) {
      throw new Error("Formalize ownership is already bound to another stack integrator");
    }
    return state;
  }
  const next = cloneThreeLane(state);
  next.formalize.ownership = { ...ownership };
  return next;
}

export function registerSparkReproAlignmentFinding(
  state: SparkReproThreeLaneSessionState,
  finding: SparkReproAlignmentFinding,
): SparkReproThreeLaneSessionState {
  assertStableId(finding.findingId, "findingId");
  assertWorkItem(state, finding.workItemId);
  assertNonEmpty(finding.firstBadBoundary, "firstBadBoundary");
  if (finding.evidenceRefs.length === 0) throw new Error("alignment finding requires evidence");
  validateEvidenceRefs(finding.evidenceRefs, "finding.evidenceRefs");
  const existing = state.findings.find((candidate) => candidate.findingId === finding.findingId);
  if (existing) return idempotentOrThrow(state, existing, finding, "findingId");
  const next = cloneThreeLane(state);
  next.findings.push(structuredClone(finding));
  pushUnique(next.exactness.findingIds, finding.findingId);
  pushUnique(next.exactness.workItemIds, finding.workItemId);
  return next;
}

export function registerSparkReproUnresolvedMismatch(
  state: SparkReproThreeLaneSessionState,
  mismatch: SparkReproUnresolvedMismatch,
): SparkReproThreeLaneSessionState {
  assertStableId(mismatch.mismatchId, "mismatchId");
  assertWorkItem(state, mismatch.workItemId);
  assertNonEmpty(mismatch.firstBadBoundary, "firstBadBoundary");
  validateEvidenceRefs(mismatch.evidenceRefs, "mismatch.evidenceRefs");
  if (mismatch.disposition === "skip") {
    if (!mismatch.isolation || !mismatch.resynchronization) {
      throw new Error("skipped mismatch requires both isolation and resynchronization");
    }
    assertNonEmpty(mismatch.isolation.boundary, "mismatch.isolation.boundary");
    assertNonEmpty(mismatch.resynchronization.checkpoint, "mismatch.resynchronization.checkpoint");
    if (
      mismatch.isolation.evidenceRefs.length === 0 ||
      mismatch.resynchronization.evidenceRefs.length === 0
    ) {
      throw new Error("skipped mismatch isolation and resynchronization require evidence");
    }
  }
  const existing = state.mismatches.find(
    (candidate) => candidate.mismatchId === mismatch.mismatchId,
  );
  if (existing) return idempotentOrThrow(state, existing, mismatch, "mismatchId");
  const next = cloneThreeLane(state);
  next.mismatches.push(structuredClone(mismatch));
  pushUnique(next.exactness.mismatchIds, mismatch.mismatchId);
  pushUnique(next.exactness.workItemIds, mismatch.workItemId);
  pushUnique(next.unresolvedIds, mismatch.mismatchId);
  return next;
}

export function recordSparkReproWorkHandoff(
  state: SparkReproThreeLaneSessionState,
  handoff: SparkReproWorkHandoff,
): SparkReproThreeLaneSessionState {
  const validDirection =
    (handoff.from === "implementation" && handoff.to === "exactness") ||
    (handoff.from === "exactness" && handoff.to === "formalize");
  if (!validDirection) throw new Error("Repro handoff must move one lane forward");
  assertStableId(handoff.handoffId, "handoffId");
  const item = assertWorkItem(state, handoff.workItemId);
  if (handoff.planRevision !== state.planRevision || item.planRevision !== state.planRevision) {
    throw new Error("stale Repro handoff plan revision");
  }
  if (handoff.sourceRevision !== item.sourceRevision) {
    throw new Error("stale Repro handoff source revision");
  }
  assertNonEmpty(handoff.scope, "handoff.scope");
  if (handoff.evidenceRefs.length === 0) {
    throw new Error("Repro handoff requires evidence");
  }
  if (handoff.candidateRevisions.length === 0) {
    throw new Error("Repro handoff requires at least one candidate revision");
  }
  if (handoff.doneWhen.length === 0 || handoff.doneWhen.some((entry) => !entry.trim())) {
    throw new Error("Repro handoff requires non-empty doneWhen criteria");
  }
  validateEvidenceRefs(handoff.evidenceRefs, "handoff.evidenceRefs");
  for (const dependency of handoff.dependsOnHandoffIds) {
    if (!state.handoffs.some((candidate) => candidate.handoffId === dependency)) {
      throw new Error(`unknown handoff dependency: ${dependency}`);
    }
  }
  const existing = state.handoffs.find((candidate) => candidate.handoffId === handoff.handoffId);
  if (existing) return idempotentOrThrow(state, existing, handoff, "handoffId");
  const next = cloneThreeLane(state);
  next.handoffs.push(structuredClone(handoff));
  pushUnique(laneWorkItemIds(next, handoff.to), handoff.workItemId);
  return next;
}

export function recordSparkReproResolution(
  state: SparkReproThreeLaneSessionState,
  resolution: SparkReproResolution,
): SparkReproThreeLaneSessionState {
  const validDirection =
    (resolution.from === "formalize" && resolution.to === "exactness") ||
    (resolution.from === "exactness" && resolution.to === "implementation");
  if (!validDirection) throw new Error("Repro resolution must move one lane backward");
  assertStableId(resolution.resolutionId, "resolutionId");
  assertWorkItem(state, resolution.workItemId);
  assertNonEmpty(resolution.canonicalRevision, "resolution.canonicalRevision");
  if (resolution.evidenceRefs.length === 0) throw new Error("Repro resolution requires evidence");
  validateEvidenceRefs(resolution.evidenceRefs, "resolution.evidenceRefs");
  if (resolution.from === "exactness") {
    const parent = state.resolutions.find(
      (candidate) => candidate.resolutionId === resolution.parentResolutionId,
    );
    if (
      !parent ||
      parent.from !== "formalize" ||
      parent.to !== "exactness" ||
      parent.workItemId !== resolution.workItemId ||
      parent.canonicalRevision !== resolution.canonicalRevision
    ) {
      throw new Error("Exactness resolution requires its matching Formalize resolution");
    }
  }
  const existing = state.resolutions.find(
    (candidate) => candidate.resolutionId === resolution.resolutionId,
  );
  if (existing) return idempotentOrThrow(state, existing, resolution, "resolutionId");
  const next = cloneThreeLane(state);
  next.resolutions.push(structuredClone(resolution));
  if (resolution.from === "formalize" && resolution.status !== "rejected") {
    next.formalize.formalizedTip = resolution.canonicalRevision;
  }
  return next;
}

export function validateSparkReproThreeLaneSessionState(
  state: SparkReproThreeLaneSessionState,
  plan: SparkReproThreeLanePlanInput,
): void {
  if (state.schema !== SPARK_REPRO_THREE_LANE_SESSION_SCHEMA) {
    throw new Error("unsupported Repro three-lane session schema");
  }
  if (state.planRevision !== plan.currentRevision)
    throw new Error("stale three-lane plan revision");
  const orderedStepIds = normativeOrderedStepIds(plan);
  const legacyOrderedStepIds = plan.steps.map((step) => step.id);
  const persistedOrderedStepIds = state.formalize.orderedStepIds;
  if (
    JSON.stringify(persistedOrderedStepIds) !== JSON.stringify(orderedStepIds) &&
    JSON.stringify(persistedOrderedStepIds) !== JSON.stringify(legacyOrderedStepIds)
  ) {
    throw new Error("three-lane Formalize order does not match the current plan");
  }
  assertUnique(
    state.workItems.map((item) => item.workItemId),
    "workItemId",
  );
  assertUnique(
    state.findings.map((item) => item.findingId),
    "findingId",
  );
  assertUnique(
    state.mismatches.map((item) => item.mismatchId),
    "mismatchId",
  );
  assertUnique(
    state.handoffs.map((item) => item.handoffId),
    "handoffId",
  );
  assertUnique(
    state.resolutions.map((item) => item.resolutionId),
    "resolutionId",
  );
  for (const item of state.workItems) validateWorkItem(item, state.planRevision);
  const knownWorkItems = new Set(state.workItems.map((item) => item.workItemId));
  for (const id of [
    ...state.implementation.workItemIds,
    ...state.exactness.workItemIds,
    ...state.formalize.workItemIds,
  ]) {
    if (!knownWorkItems.has(id))
      throw new Error(`three-lane state references unknown work item: ${id}`);
  }
  assertUnique(state.implementation.workItemIds, "implementation.workItemIds");
  assertUnique(state.exactness.workItemIds, "exactness.workItemIds");
  assertUnique(state.formalize.workItemIds, "formalize.workItemIds");
  if (state.formalize.ownership) {
    if (!isRef(state.formalize.ownership.gitChangeRef, "artifact")) {
      throw new Error("invalid Formalize gitChangeRef");
    }
    assertNonEmpty(state.formalize.ownership.integratorSessionId, "integratorSessionId");
  }
  for (const finding of state.findings) {
    assertWorkItem(state, finding.workItemId);
    assertNonEmpty(finding.firstBadBoundary, "finding.firstBadBoundary");
    assertOneOf(
      finding.classification,
      [
        "implementation_defect",
        "semantic_difference",
        "intrinsic_numerical",
        "contract_environment",
        "unknown",
      ] as const,
      "finding.classification",
    );
    assertOneOf(
      finding.disposition,
      ["fix", "adapt", "accept", "defer"] as const,
      "finding.disposition",
    );
    assertOneOf(finding.confidence, ["suspected", "confirmed"] as const, "finding.confidence");
    if (finding.evidenceRefs.length === 0) throw new Error("alignment finding requires evidence");
    validateEvidenceRefs(finding.evidenceRefs, "finding.evidenceRefs");
  }
  for (const mismatch of state.mismatches) {
    assertWorkItem(state, mismatch.workItemId);
    assertNonEmpty(mismatch.firstBadBoundary, "mismatch.firstBadBoundary");
    assertOneOf(
      mismatch.disposition,
      ["fix", "adapt", "accept", "defer", "skip"] as const,
      "mismatch.disposition",
    );
    if (mismatch.disposition === "skip" && (!mismatch.isolation || !mismatch.resynchronization)) {
      throw new Error("skipped mismatch requires both isolation and resynchronization");
    }
    validateEvidenceRefs(mismatch.evidenceRefs, "mismatch.evidenceRefs");
  }
  for (const handoff of state.handoffs) {
    const item = assertWorkItem(state, handoff.workItemId);
    if (
      !(
        (handoff.from === "implementation" && handoff.to === "exactness") ||
        (handoff.from === "exactness" && handoff.to === "formalize")
      )
    ) {
      throw new Error("Repro handoff must move one lane forward");
    }
    if (
      handoff.planRevision !== state.planRevision ||
      (handoff.status !== "stale" &&
        handoff.status !== "superseded" &&
        handoff.sourceRevision !== item.sourceRevision)
    ) {
      throw new Error("stale persisted Repro handoff revision");
    }
    assertOneOf(
      handoff.status,
      ["pending", "accepted", "stale", "superseded"] as const,
      "handoff.status",
    );
    if (handoff.doneWhen.length === 0 || handoff.doneWhen.some((entry) => !entry.trim())) {
      throw new Error("Repro handoff requires non-empty doneWhen criteria");
    }
    if (handoff.evidenceRefs.length === 0) {
      throw new Error("Repro handoff requires evidence");
    }
    if (handoff.candidateRevisions.length === 0) {
      throw new Error("Repro handoff requires at least one candidate revision");
    }
    validateEvidenceRefs(handoff.evidenceRefs, "handoff.evidenceRefs");
  }
  for (const resolution of state.resolutions) {
    assertWorkItem(state, resolution.workItemId);
    if (
      !(
        (resolution.from === "formalize" && resolution.to === "exactness") ||
        (resolution.from === "exactness" && resolution.to === "implementation")
      )
    ) {
      throw new Error("Repro resolution must move one lane backward");
    }
    assertOneOf(
      resolution.status,
      ["resolved", "superseded", "rejected"] as const,
      "resolution.status",
    );
    if (resolution.evidenceRefs.length === 0) throw new Error("Repro resolution requires evidence");
    if (resolution.from === "exactness") {
      const parent = state.resolutions.find(
        (candidate) => candidate.resolutionId === resolution.parentResolutionId,
      );
      if (
        !parent ||
        parent.from !== "formalize" ||
        parent.to !== "exactness" ||
        parent.workItemId !== resolution.workItemId ||
        parent.canonicalRevision !== resolution.canonicalRevision
      ) {
        throw new Error("Exactness resolution requires its matching Formalize resolution");
      }
    }
    validateEvidenceRefs(resolution.evidenceRefs, "resolution.evidenceRefs");
  }
  const acceptedFormalResolution = [...state.resolutions]
    .reverse()
    .find((resolution) => resolution.from === "formalize" && resolution.status !== "rejected");
  if (state.formalize.formalizedTip !== acceptedFormalResolution?.canonicalRevision) {
    throw new Error("formalizedTip must match the latest accepted Formalize resolution");
  }
  const retired = state.formalize.retiredStepIds;
  if (
    JSON.stringify(retired) !== JSON.stringify(persistedOrderedStepIds.slice(0, retired.length))
  ) {
    throw new Error("Formalize retirement must remain an ordered prefix");
  }
}

function normativeOrderedStepIds(plan: SparkReproThreeLanePlanInput): string[] {
  const stageRank = new Map<SparkReproStageName, number>([
    ["contract", 0],
    ["reference", 1],
    ["target", 2],
    ["alignment", 3],
    ["delivery", 4],
  ]);
  return plan.steps
    .map((step, index) => ({ step, index }))
    .sort(
      (left, right) =>
        (stageRank.get(left.step.stage) ?? Number.MAX_SAFE_INTEGER) -
          (stageRank.get(right.step.stage) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index,
    )
    .map(({ step }) => step.id);
}

function laneWorkItemIds(state: SparkReproThreeLaneSessionState, lane: SparkReproLane): string[] {
  return lane === "implementation"
    ? state.implementation.workItemIds
    : lane === "exactness"
      ? state.exactness.workItemIds
      : state.formalize.workItemIds;
}

function validateWorkItem(item: SparkReproWorkItem, planRevision: number): void {
  assertStableId(item.workItemId, "workItemId");
  assertNonEmpty(item.title, "workItem.title");
  assertNonEmpty(item.scope, "workItem.scope");
  assertNonEmpty(item.sourceRevision, "workItem.sourceRevision");
  assertOneOf(
    item.status,
    ["open", "blocked", "completed", "superseded"] as const,
    "workItem.status",
  );
  if (item.planRevision !== planRevision) throw new Error("stale work item plan revision");
  if (item.taskRef && !isRef(item.taskRef, "task")) throw new Error("invalid work item taskRef");
  if (item.runRef && !isRef(item.runRef, "run")) throw new Error("invalid work item runRef");
  if (item.gitChangeRef && !isRef(item.gitChangeRef, "artifact")) {
    throw new Error("invalid work item gitChangeRef");
  }
  validateEvidenceRefs(item.evidenceRefs, "workItem.evidenceRefs");
}

function validateEvidenceRefs(refs: readonly EvidenceRef[], field: string): void {
  for (const ref of refs) {
    if (!isRef(ref, "evidence")) throw new Error(`${field} contains an invalid EvidenceRef`);
  }
}

function assertWorkItem(
  state: SparkReproThreeLaneSessionState,
  workItemId: string,
): SparkReproWorkItem {
  const item = state.workItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`unknown Repro work item: ${workItemId}`);
  return item;
}

function assertStableId(value: string, field: string): void {
  if (!value.trim() || value.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(`${field} must be a stable safe identifier`);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function assertOneOf<T extends string>(value: string, values: readonly T[], field: string): void {
  if (!values.includes(value as T)) throw new Error(`${field} is invalid`);
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function idempotentOrThrow<T>(
  state: SparkReproThreeLaneSessionState,
  existing: T,
  incoming: T,
  field: string,
): SparkReproThreeLaneSessionState {
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`${field} already exists with different content`);
  }
  return state;
}

function cloneWorkItem(item: SparkReproWorkItem): SparkReproWorkItem {
  return structuredClone(item);
}

function cloneThreeLane(state: SparkReproThreeLaneSessionState): SparkReproThreeLaneSessionState {
  return structuredClone(state);
}
