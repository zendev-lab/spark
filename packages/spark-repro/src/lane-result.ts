import { createHash } from "node:crypto";

import { isRef, type EvidenceRef, type RunRef, type TaskRef } from "@zendev-lab/spark-core";

import {
  acknowledgeSparkReproRoute,
  recordSparkReproResolution,
  recordSparkReproLaneResultReceipt,
  recordSparkReproRoute,
  recordSparkReproWorkHandoff,
  registerSparkReproAlignmentFinding,
  registerSparkReproUnresolvedMismatch,
  sparkReproLaneBinding,
  type SparkReproAlignmentFinding,
  type SparkReproLane,
  type SparkReproMismatchClassification,
  type SparkReproMismatchDisposition,
  type SparkReproRoute,
  type SparkReproThreeLaneSessionState,
  type SparkReproUnresolvedMismatch,
  type SparkReproWorkHandoff,
} from "./three-lane.ts";

export const SPARK_REPRO_LANE_RESULT_SCHEMA = "spark.repro.lane-result/v1" as const;

const COMMON_RESULT_KEYS = [
  "schema",
  "kind",
  "reproId",
  "workItemId",
  "lane",
  "planRevision",
  "bindingRevision",
  "taskRef",
  "runRef",
  "sourceRevision",
  "evidenceRefs",
  "originRouteId",
] as const;
const HANDOFF_KEYS = ["scope", "candidateRevisions", "dependsOnHandoffIds", "doneWhen"] as const;

interface SparkReproLaneResultBase {
  schema: typeof SPARK_REPRO_LANE_RESULT_SCHEMA;
  reproId: string;
  workItemId: string;
  lane: SparkReproLane;
  planRevision: number;
  bindingRevision: number;
  taskRef: TaskRef;
  runRef: RunRef;
  sourceRevision: string;
  evidenceRefs: EvidenceRef[];
  /** Route that materialized this binding; omitted only for an initial Implementation binding. */
  originRouteId?: string;
}

interface SparkReproForwardHandoffPayload {
  scope: string;
  candidateRevisions: string[];
  dependsOnHandoffIds: string[];
  doneWhen: string[];
}

export interface SparkReproImplementationCandidateResult
  extends SparkReproLaneResultBase, SparkReproForwardHandoffPayload {
  kind: "implementation_candidate";
  lane: "implementation";
}

export interface SparkReproExactnessFindingResult
  extends SparkReproLaneResultBase, SparkReproForwardHandoffPayload {
  kind: "exactness_finding";
  lane: "exactness";
  finding: Omit<SparkReproAlignmentFinding, "workItemId" | "evidenceRefs"> & {
    evidenceRefs?: EvidenceRef[];
  };
}

export interface SparkReproExactnessMismatchResult extends SparkReproLaneResultBase {
  kind: "exactness_mismatch";
  lane: "exactness";
  mismatch: Omit<SparkReproUnresolvedMismatch, "workItemId" | "evidenceRefs"> & {
    evidenceRefs?: EvidenceRef[];
  };
  /** Present when the classified mismatch is ready for Formalize. */
  handoff?: SparkReproForwardHandoffPayload;
}

export interface SparkReproFormalizedResult extends SparkReproLaneResultBase {
  kind: "formalized";
  lane: "formalize";
  canonicalRevision: string;
  supersededRevisions: string[];
}

export interface SparkReproRefreshResult extends SparkReproLaneResultBase {
  kind: "refresh";
  lane: "implementation" | "exactness";
  canonicalRevision: string;
  supersededRevisions: string[];
  outcome: "refreshed" | "rebased" | "dropped";
}

export interface SparkReproAttentionResult extends SparkReproLaneResultBase {
  kind: "attention_request";
  decisionKey: string;
  question: string;
  reason: string;
  expectedAnswerKind: "single" | "multi" | "freeform";
}

export type SparkReproLaneResult =
  | SparkReproImplementationCandidateResult
  | SparkReproExactnessFindingResult
  | SparkReproExactnessMismatchResult
  | SparkReproFormalizedResult
  | SparkReproRefreshResult
  | SparkReproAttentionResult;

/** Every Evidence dependency carried by a lane result, including nested facts. */
export function sparkReproLaneResultEvidenceRefs(result: SparkReproLaneResult): EvidenceRef[] {
  const refs = [...result.evidenceRefs];
  if (result.kind === "exactness_finding") {
    refs.push(...(result.finding.evidenceRefs ?? []));
  } else if (result.kind === "exactness_mismatch") {
    refs.push(...(result.mismatch.evidenceRefs ?? []));
  }
  return [...new Set(refs)].sort();
}

export interface SparkReproLaneResultReconciliation {
  state: SparkReproThreeLaneSessionState;
  resultId: string;
  resultDigest: string;
  pendingRoutes: SparkReproRoute[];
}

/** Parse untrusted JSON Evidence without accepting unknown result variants. */
export function parseSparkReproLaneResult(value: unknown): SparkReproLaneResult {
  if (!isRecord(value)) throw new Error("lane result must be a JSON object");
  if (value.schema !== SPARK_REPRO_LANE_RESULT_SCHEMA) {
    throw new Error("unsupported Repro lane-result schema");
  }
  const kind = requiredString(value.kind, "kind");
  const common = parseCommon(value);
  switch (kind) {
    case "implementation_candidate": {
      assertOnlyKeys(value, [...COMMON_RESULT_KEYS, ...HANDOFF_KEYS], kind);
      if (common.lane !== "implementation") throw new Error("candidate result lane is invalid");
      return { ...common, lane: "implementation", kind, ...parseHandoffPayload(value) };
    }
    case "exactness_finding": {
      assertOnlyKeys(value, [...COMMON_RESULT_KEYS, ...HANDOFF_KEYS, "finding"], kind);
      if (common.lane !== "exactness") throw new Error("finding result lane is invalid");
      if (!isRecord(value.finding)) throw new Error("finding result requires finding");
      const finding = parseFinding(value.finding);
      return { ...common, lane: "exactness", kind, finding, ...parseHandoffPayload(value) };
    }
    case "exactness_mismatch": {
      assertOnlyKeys(value, [...COMMON_RESULT_KEYS, "mismatch", "handoff"], kind);
      if (common.lane !== "exactness") throw new Error("mismatch result lane is invalid");
      if (!isRecord(value.mismatch)) throw new Error("mismatch result requires mismatch");
      return {
        ...common,
        lane: "exactness",
        kind,
        mismatch: parseMismatch(value.mismatch),
        ...(value.handoff === undefined
          ? {}
          : isRecord(value.handoff)
            ? (() => {
                assertOnlyKeys(value.handoff, HANDOFF_KEYS, "mismatch.handoff");
                return { handoff: parseHandoffPayload(value.handoff) };
              })()
            : (() => {
                throw new Error("mismatch handoff must be an object");
              })()),
      };
    }
    case "formalized": {
      assertOnlyKeys(
        value,
        [...COMMON_RESULT_KEYS, "canonicalRevision", "supersededRevisions"],
        kind,
      );
      if (common.lane !== "formalize") throw new Error("formalized result lane is invalid");
      return {
        ...common,
        lane: "formalize",
        kind,
        canonicalRevision: requiredString(value.canonicalRevision, "canonicalRevision"),
        supersededRevisions: stringArray(value.supersededRevisions, "supersededRevisions"),
      };
    }
    case "refresh": {
      assertOnlyKeys(
        value,
        [...COMMON_RESULT_KEYS, "canonicalRevision", "supersededRevisions", "outcome"],
        kind,
      );
      if (common.lane !== "implementation" && common.lane !== "exactness") {
        throw new Error("refresh result lane is invalid");
      }
      const outcome = requiredString(value.outcome, "outcome");
      if (outcome !== "refreshed" && outcome !== "rebased" && outcome !== "dropped") {
        throw new Error("refresh outcome is invalid");
      }
      return {
        ...common,
        lane: common.lane,
        kind,
        canonicalRevision: requiredString(value.canonicalRevision, "canonicalRevision"),
        supersededRevisions: stringArray(value.supersededRevisions, "supersededRevisions"),
        outcome,
      };
    }
    case "attention_request": {
      assertOnlyKeys(
        value,
        [...COMMON_RESULT_KEYS, "decisionKey", "question", "reason", "expectedAnswerKind"],
        kind,
      );
      const expectedAnswerKind = requiredString(value.expectedAnswerKind, "expectedAnswerKind");
      if (
        expectedAnswerKind !== "single" &&
        expectedAnswerKind !== "multi" &&
        expectedAnswerKind !== "freeform"
      ) {
        throw new Error("attention expectedAnswerKind is invalid");
      }
      return {
        ...common,
        kind,
        decisionKey: stableId(value.decisionKey, "decisionKey"),
        question: requiredString(value.question, "question"),
        reason: requiredString(value.reason, "reason"),
        expectedAnswerKind,
      };
    }
    default:
      throw new Error(`unsupported Repro lane result kind: ${kind}`);
  }
}

/**
 * Apply one typed result and persist only Repro-owned facts. Returned pending
 * routes are deterministic intents for the extension/daemon adapter.
 */
export function reconcileSparkReproLaneResult(input: {
  state: SparkReproThreeLaneSessionState;
  reproId: string;
  evidenceRef: EvidenceRef;
  result: SparkReproLaneResult;
}): SparkReproLaneResultReconciliation {
  const { result } = input;
  if (!isRef(input.evidenceRef, "evidence")) throw new Error("lane result EvidenceRef is invalid");
  if (result.reproId !== input.reproId) throw new Error("lane result belongs to another Repro");
  const binding = sparkReproLaneBinding(input.state, result.workItemId, result.lane);
  if (!binding) throw new Error("lane result has no schedulable lane binding");
  if (
    result.planRevision !== input.state.planRevision ||
    result.bindingRevision !== binding.bindingRevision ||
    result.taskRef !== binding.taskRef ||
    result.sourceRevision !== binding.sourceRevision
  ) {
    throw new Error("stale or foreign Repro lane result binding");
  }
  const resultId = deterministicResultId(result);
  const resultDigest = digest(result);
  let state = recordSparkReproLaneResultReceipt(input.state, {
    resultId,
    resultDigest,
    evidenceRef: input.evidenceRef,
  });
  if (state === input.state) {
    return {
      state,
      resultId,
      resultDigest,
      pendingRoutes: state.routes.filter((candidate) => candidate.status === "pending"),
    };
  }
  const materializingRoutes = state.routes.filter(
    (candidate) => candidate.workItemId === result.workItemId && candidate.toLane === result.lane,
  );
  const expectedOrigin = materializingRoutes.at(-1);
  if (expectedOrigin?.routeId !== result.originRouteId) {
    throw new Error(
      expectedOrigin
        ? "routed Repro lane result requires its current originRouteId"
        : "lane result origin route does not match its binding",
    );
  }
  if (expectedOrigin) {
    state = acknowledgeSparkReproRoute(state, expectedOrigin.routeId);
  }

  switch (result.kind) {
    case "implementation_candidate": {
      state = recordSparkReproWorkHandoff(
        state,
        forwardHandoff(resultId, result, input.evidenceRef, "exactness"),
      );
      state = recordSparkReproRoute(
        state,
        route(
          resultId,
          resultDigest,
          result,
          input.evidenceRef,
          "materialize_binding",
          "exactness",
        ),
      );
      break;
    }
    case "exactness_finding": {
      state = registerSparkReproAlignmentFinding(state, {
        ...result.finding,
        workItemId: result.workItemId,
        evidenceRefs: evidenceUnion(
          input.evidenceRef,
          result.evidenceRefs,
          result.finding.evidenceRefs,
        ),
      });
      state = recordSparkReproWorkHandoff(
        state,
        forwardHandoff(resultId, result, input.evidenceRef, "formalize"),
      );
      state = recordSparkReproRoute(
        state,
        route(
          resultId,
          resultDigest,
          result,
          input.evidenceRef,
          "materialize_binding",
          "formalize",
        ),
      );
      break;
    }
    case "exactness_mismatch": {
      state = registerSparkReproUnresolvedMismatch(state, {
        ...result.mismatch,
        workItemId: result.workItemId,
        evidenceRefs: evidenceUnion(
          input.evidenceRef,
          result.evidenceRefs,
          result.mismatch.evidenceRefs,
        ),
      });
      if (result.handoff) {
        state = recordSparkReproWorkHandoff(
          state,
          forwardHandoff(
            resultId,
            { ...result, ...result.handoff },
            input.evidenceRef,
            "formalize",
          ),
        );
        state = recordSparkReproRoute(
          state,
          route(
            resultId,
            resultDigest,
            result,
            input.evidenceRef,
            "materialize_binding",
            "formalize",
          ),
        );
      }
      break;
    }
    case "formalized": {
      if (!state.formalize.ownership) throw new Error("Formalize has no canonical integrator");
      state = recordSparkReproResolution(state, {
        resolutionId: deterministicResolutionId(resultId),
        workItemId: result.workItemId,
        from: "formalize",
        to: "exactness",
        status: "resolved",
        canonicalRevision: result.canonicalRevision,
        supersededRevisions: [...result.supersededRevisions],
        evidenceRefs: evidenceUnion(input.evidenceRef, result.evidenceRefs),
      });
      state = recordSparkReproRoute(
        state,
        route(resultId, resultDigest, result, input.evidenceRef, "refresh_binding", "exactness"),
      );
      break;
    }
    case "refresh": {
      if (result.lane === "exactness") {
        const parent = latestFormalResolution(state, result.workItemId, result.canonicalRevision);
        state = recordSparkReproResolution(state, {
          resolutionId: deterministicResolutionId(resultId),
          workItemId: result.workItemId,
          from: "exactness",
          to: "implementation",
          status: result.outcome === "dropped" ? "superseded" : "resolved",
          canonicalRevision: result.canonicalRevision,
          supersededRevisions: [...result.supersededRevisions],
          evidenceRefs: evidenceUnion(input.evidenceRef, result.evidenceRefs),
          parentResolutionId: parent.resolutionId,
        });
        state = markLaneRefreshed(state, result.workItemId, "exactness", result.canonicalRevision);
        state = recordSparkReproRoute(
          state,
          route(
            resultId,
            resultDigest,
            result,
            input.evidenceRef,
            "refresh_binding",
            "implementation",
          ),
        );
      } else {
        latestExactnessResolution(state, result.workItemId, result.canonicalRevision);
        state = markWorkItemConverged(state, result.workItemId, result.canonicalRevision);
      }
      break;
    }
    case "attention_request": {
      state = recordSparkReproRoute(state, {
        ...route(resultId, resultDigest, result, input.evidenceRef, "root_attention"),
        decisionKey: result.decisionKey,
        attention: {
          question: result.question,
          reason: result.reason,
          expectedAnswerKind: result.expectedAnswerKind,
        },
      });
      break;
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
  return {
    state,
    resultId,
    resultDigest,
    pendingRoutes: state.routes.filter((candidate) => candidate.status === "pending"),
  };
}

function markLaneRefreshed(
  state: SparkReproThreeLaneSessionState,
  workItemId: string,
  lane: "implementation" | "exactness",
  canonicalRevision: string,
): SparkReproThreeLaneSessionState {
  const next = structuredClone(state);
  const binding = next.bindings.find(
    (candidate) => candidate.workItemId === workItemId && candidate.lane === lane,
  );
  if (!binding) throw new Error(`refresh result has no ${lane} binding`);
  binding.status = "converged";
  binding.sourceRevision = canonicalRevision;
  return next;
}

export function deterministicResultId(result: SparkReproLaneResult): string {
  return `result:${digest({
    schema: result.schema,
    reproId: result.reproId,
    workItemId: result.workItemId,
    lane: result.lane,
    kind: result.kind,
    planRevision: result.planRevision,
    bindingRevision: result.bindingRevision,
    taskRef: result.taskRef,
    runRef: result.runRef,
    sourceRevision: result.sourceRevision,
  }).slice(0, 32)}`;
}

function deterministicHandoffId(resultId: string): string {
  return `handoff:${digest(resultId).slice(0, 32)}`;
}

function deterministicResolutionId(resultId: string): string {
  return `resolution:${digest(resultId).slice(0, 32)}`;
}

function deterministicRouteId(resultId: string): string {
  return `route:${digest(resultId).slice(0, 32)}`;
}

function forwardHandoff(
  resultId: string,
  result: SparkReproLaneResultBase & SparkReproForwardHandoffPayload,
  evidenceRef: EvidenceRef,
  to: "exactness" | "formalize",
): SparkReproWorkHandoff {
  if (
    (result.lane === "implementation" && to !== "exactness") ||
    (result.lane === "exactness" && to !== "formalize") ||
    result.lane === "formalize"
  ) {
    throw new Error("invalid automatic Repro handoff direction");
  }
  return {
    handoffId: deterministicHandoffId(resultId),
    workItemId: result.workItemId,
    from: result.lane,
    to,
    planRevision: result.planRevision,
    sourceRevision: result.sourceRevision,
    scope: result.scope,
    findingIds:
      "finding" in result &&
      isRecord(result.finding) &&
      typeof result.finding.findingId === "string"
        ? [result.finding.findingId]
        : [],
    evidenceRefs: evidenceUnion(evidenceRef, result.evidenceRefs),
    candidateRevisions: [...result.candidateRevisions],
    dependsOnHandoffIds: [...result.dependsOnHandoffIds],
    doneWhen: [...result.doneWhen],
    status: "accepted",
  };
}

function route(
  resultId: string,
  resultDigest: string,
  result: SparkReproLaneResultBase,
  evidenceRef: EvidenceRef,
  action: SparkReproRoute["action"],
  toLane?: SparkReproLane,
): SparkReproRoute {
  return {
    routeId: deterministicRouteId(resultId),
    resultId,
    resultDigest,
    action,
    workItemId: result.workItemId,
    fromLane: result.lane,
    ...(toLane ? { toLane } : {}),
    planRevision: result.planRevision,
    sourceBindingRevision: result.bindingRevision,
    sourceRevision: result.sourceRevision,
    evidenceRef,
    status: "pending",
  };
}

function latestFormalResolution(
  state: SparkReproThreeLaneSessionState,
  workItemId: string,
  canonicalRevision: string,
) {
  const resolution = [...state.resolutions]
    .reverse()
    .find(
      (candidate) =>
        candidate.workItemId === workItemId &&
        candidate.from === "formalize" &&
        candidate.canonicalRevision === canonicalRevision &&
        candidate.status !== "rejected",
    );
  if (!resolution) throw new Error("Exactness refresh has no matching Formalize resolution");
  return resolution;
}

function latestExactnessResolution(
  state: SparkReproThreeLaneSessionState,
  workItemId: string,
  canonicalRevision: string,
) {
  const resolution = [...state.resolutions]
    .reverse()
    .find(
      (candidate) =>
        candidate.workItemId === workItemId &&
        candidate.from === "exactness" &&
        candidate.canonicalRevision === canonicalRevision &&
        candidate.status !== "rejected",
    );
  if (!resolution) throw new Error("Implementation refresh has no matching Exactness resolution");
  return resolution;
}

function markWorkItemConverged(
  state: SparkReproThreeLaneSessionState,
  workItemId: string,
  canonicalRevision: string,
): SparkReproThreeLaneSessionState {
  const next = structuredClone(state);
  const item = next.workItems.find((candidate) => candidate.workItemId === workItemId);
  if (!item) throw new Error(`unknown Repro work item: ${workItemId}`);
  item.status = "completed";
  item.sourceRevision = canonicalRevision;
  for (const binding of next.bindings) {
    if (binding.workItemId !== workItemId) continue;
    binding.status = "converged";
    binding.sourceRevision = canonicalRevision;
  }
  return next;
}

function parseCommon(value: Record<string, unknown>): SparkReproLaneResultBase {
  const lane = requiredString(value.lane, "lane");
  if (lane !== "implementation" && lane !== "exactness" && lane !== "formalize") {
    throw new Error("lane result lane is invalid");
  }
  const taskRef = requiredString(value.taskRef, "taskRef");
  const runRef = requiredString(value.runRef, "runRef");
  if (!isRef(taskRef, "task")) throw new Error("lane result taskRef is invalid");
  if (!isRef(runRef, "run")) throw new Error("lane result runRef is invalid");
  return {
    schema: SPARK_REPRO_LANE_RESULT_SCHEMA,
    reproId: stableId(value.reproId, "reproId"),
    workItemId: stableId(value.workItemId, "workItemId"),
    lane,
    planRevision: positiveInteger(value.planRevision, "planRevision"),
    bindingRevision: positiveInteger(value.bindingRevision, "bindingRevision"),
    taskRef,
    runRef,
    sourceRevision: requiredString(value.sourceRevision, "sourceRevision"),
    evidenceRefs: evidenceArray(value.evidenceRefs, "evidenceRefs"),
    ...(value.originRouteId === undefined
      ? {}
      : { originRouteId: stableId(value.originRouteId, "originRouteId") }),
  };
}

function parseHandoffPayload(value: Record<string, unknown>): SparkReproForwardHandoffPayload {
  const candidateRevisions = stringArray(value.candidateRevisions, "candidateRevisions");
  const doneWhen = stringArray(value.doneWhen, "doneWhen");
  if (candidateRevisions.length === 0) throw new Error("lane result requires candidate revisions");
  if (doneWhen.length === 0) throw new Error("lane result requires doneWhen criteria");
  return {
    scope: requiredString(value.scope, "scope"),
    candidateRevisions,
    dependsOnHandoffIds: stringArray(value.dependsOnHandoffIds ?? [], "dependsOnHandoffIds"),
    doneWhen,
  };
}

function parseFinding(value: Record<string, unknown>): SparkReproExactnessFindingResult["finding"] {
  assertOnlyKeys(
    value,
    [
      "findingId",
      "firstBadBoundary",
      "classification",
      "disposition",
      "confidence",
      "evidenceRefs",
    ],
    "finding",
  );
  const classification = mismatchClassification(value.classification);
  const disposition = mismatchDisposition(value.disposition);
  if (disposition === "skip") throw new Error("finding disposition cannot be skip");
  const confidence = requiredString(value.confidence, "finding.confidence");
  if (confidence !== "suspected" && confidence !== "confirmed") {
    throw new Error("finding confidence is invalid");
  }
  return {
    findingId: stableId(value.findingId, "finding.findingId"),
    firstBadBoundary: requiredString(value.firstBadBoundary, "finding.firstBadBoundary"),
    classification,
    disposition,
    confidence,
    ...(value.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: evidenceArray(value.evidenceRefs, "finding.evidenceRefs") }),
  };
}

function parseMismatch(
  value: Record<string, unknown>,
): SparkReproExactnessMismatchResult["mismatch"] {
  assertOnlyKeys(
    value,
    [
      "mismatchId",
      "firstBadBoundary",
      "classification",
      "disposition",
      "confidence",
      "evidenceRefs",
      "isolation",
      "resynchronization",
    ],
    "mismatch",
  );
  const confidence = requiredString(value.confidence, "mismatch.confidence");
  if (confidence !== "suspected" && confidence !== "confirmed") {
    throw new Error("mismatch confidence is invalid");
  }
  const isolation = optionalBoundaryEvidence(value.isolation, "isolation", "boundary") as
    | { boundary: string; evidenceRefs: EvidenceRef[] }
    | undefined;
  const resynchronization = optionalBoundaryEvidence(
    value.resynchronization,
    "resynchronization",
    "checkpoint",
  ) as { checkpoint: string; evidenceRefs: EvidenceRef[] } | undefined;
  return {
    mismatchId: stableId(value.mismatchId, "mismatch.mismatchId"),
    firstBadBoundary: requiredString(value.firstBadBoundary, "mismatch.firstBadBoundary"),
    classification: mismatchClassification(value.classification),
    disposition: mismatchDisposition(value.disposition),
    confidence,
    ...(value.evidenceRefs === undefined
      ? {}
      : { evidenceRefs: evidenceArray(value.evidenceRefs, "mismatch.evidenceRefs") }),
    ...(isolation ? { isolation } : {}),
    ...(resynchronization ? { resynchronization } : {}),
  };
}

function optionalBoundaryEvidence(
  value: unknown,
  field: string,
  key: "boundary" | "checkpoint",
):
  | { boundary: string; evidenceRefs: EvidenceRef[] }
  | { checkpoint: string; evidenceRefs: EvidenceRef[] }
  | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertOnlyKeys(value, [key, "evidenceRefs"], field);
  const common = {
    [key]: requiredString(value[key], `${field}.${key}`),
    evidenceRefs: evidenceArray(value.evidenceRefs, `${field}.evidenceRefs`),
  };
  return common as
    | { boundary: string; evidenceRefs: EvidenceRef[] }
    | { checkpoint: string; evidenceRefs: EvidenceRef[] };
}

function mismatchClassification(value: unknown): SparkReproMismatchClassification {
  const candidate = requiredString(value, "classification");
  if (
    candidate !== "implementation_defect" &&
    candidate !== "semantic_difference" &&
    candidate !== "intrinsic_numerical" &&
    candidate !== "contract_environment" &&
    candidate !== "unknown"
  ) {
    throw new Error("mismatch classification is invalid");
  }
  return candidate;
}

function mismatchDisposition(value: unknown): SparkReproMismatchDisposition {
  const candidate = requiredString(value, "disposition");
  if (
    candidate !== "fix" &&
    candidate !== "adapt" &&
    candidate !== "accept" &&
    candidate !== "defer" &&
    candidate !== "skip"
  ) {
    throw new Error("mismatch disposition is invalid");
  }
  return candidate;
}

function evidenceUnion(
  evidenceRef: EvidenceRef,
  ...groups: Array<readonly EvidenceRef[] | undefined>
): EvidenceRef[] {
  return [...new Set([evidenceRef, ...groups.flatMap((group) => group ?? [])])];
}

function evidenceArray(value: unknown, field: string): EvidenceRef[] {
  const values = stringArray(value ?? [], field);
  for (const ref of values) if (!isRef(ref, "evidence")) throw new Error(`${field} is invalid`);
  return values as EvidenceRef[];
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(value);
}

function stableId(value: unknown, field: string): string {
  const candidate = requiredString(value, field);
  if (candidate.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(candidate)) {
    throw new Error(`${field} must be a stable safe identifier`);
  }
  return candidate;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field(s): ${unknown.sort().join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
