import { createHash } from "node:crypto";

import { isRef, type EvidenceRef } from "@zendev-lab/spark-core";
import {
  SPARK_REPRO_LANE_RESULT_SCHEMA,
  parseSparkReproLaneResult as parseProtocolLaneResult,
  sparkReproLaneResultEvidenceRefs as protocolLaneResultEvidenceRefs,
  type SparkReproAttentionResult,
  type SparkReproExactnessFindingResult,
  type SparkReproExactnessMismatchResult,
  type SparkReproFormalizedResult,
  type SparkReproImplementationCandidateResult,
  type SparkReproLane,
  type SparkReproLaneResult,
  type SparkReproRefreshResult,
} from "@zendev-lab/spark-protocol/repro-lane";

import {
  acknowledgeSparkReproRoute,
  recordSparkReproResolution,
  recordSparkReproLaneResultReceipt,
  recordSparkReproRoute,
  recordSparkReproWorkHandoff,
  registerSparkReproAlignmentFinding,
  registerSparkReproUnresolvedMismatch,
  sparkReproLaneBinding,
  type SparkReproRoute,
  type SparkReproThreeLaneSessionState,
  type SparkReproWorkHandoff,
} from "./three-lane.ts";

export {
  SPARK_REPRO_LANE_RESULT_SCHEMA,
  type SparkReproAttentionResult,
  type SparkReproExactnessFindingResult,
  type SparkReproExactnessMismatchResult,
  type SparkReproFormalizedResult,
  type SparkReproImplementationCandidateResult,
  type SparkReproLaneResult,
  type SparkReproRefreshResult,
};

type SparkReproLaneResultBase = Pick<
  SparkReproLaneResult,
  | "schema"
  | "reproId"
  | "workItemId"
  | "lane"
  | "planRevision"
  | "bindingRevision"
  | "taskRef"
  | "runRef"
  | "sourceRevision"
  | "evidenceRefs"
  | "originRouteId"
>;
type SparkReproForwardHandoffPayload = Pick<
  SparkReproImplementationCandidateResult,
  "scope" | "candidateRevisions" | "dependsOnHandoffIds" | "doneWhen"
>;

/** Every Evidence dependency carried by a lane result, including nested facts. */
export function sparkReproLaneResultEvidenceRefs(result: SparkReproLaneResult): EvidenceRef[] {
  return protocolLaneResultEvidenceRefs(result) as EvidenceRef[];
}

export interface SparkReproLaneResultReconciliation {
  state: SparkReproThreeLaneSessionState;
  resultId: string;
  resultDigest: string;
  pendingRoutes: SparkReproRoute[];
}

export function rejectSparkReproLaneResult(input: {
  state: SparkReproThreeLaneSessionState;
  evidenceRef: EvidenceRef;
  result: SparkReproLaneResult;
  reason: "missing_evidence" | "invalid_provenance";
}): SparkReproLaneResultReconciliation {
  const resultId = deterministicResultId(input.result);
  const resultDigest = digest(input.result);
  const state = recordSparkReproLaneResultReceipt(input.state, {
    resultId,
    resultDigest,
    evidenceRef: input.evidenceRef,
    status: "rejected",
    reason: input.reason,
  });
  return {
    state,
    resultId,
    resultDigest,
    pendingRoutes: state.routes.filter((candidate) => candidate.status === "pending"),
  };
}

export function parseSparkReproLaneResult(value: unknown): SparkReproLaneResult {
  return parseProtocolLaneResult(value);
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
  const resultId = deterministicResultId(result);
  const resultDigest = digest(result);
  const priorReceipt = input.state.resultReceipts.find((receipt) => receipt.resultId === resultId);
  if (priorReceipt) {
    if (priorReceipt.resultDigest !== resultDigest) {
      throw new Error("resultId already exists with different content");
    }
    return {
      state: input.state,
      resultId,
      resultDigest,
      pendingRoutes: input.state.routes.filter((candidate) => candidate.status === "pending"),
    };
  }
  const binding = sparkReproLaneBinding(input.state, result.workItemId, result.lane);
  const rejection =
    result.reproId !== input.reproId
      ? "foreign_repro"
      : !binding
        ? "missing_binding"
        : result.planRevision !== input.state.planRevision ||
            result.bindingRevision !== binding.bindingRevision ||
            result.taskRef !== binding.taskRef ||
            result.sourceRevision !== binding.sourceRevision
          ? "stale_binding"
          : binding.originRouteId !== result.originRouteId
            ? "foreign_origin_route"
            : undefined;
  if (rejection) {
    const state = recordSparkReproLaneResultReceipt(input.state, {
      resultId,
      resultDigest,
      evidenceRef: input.evidenceRef,
      status: "rejected",
      reason: rejection,
    });
    return {
      state,
      resultId,
      resultDigest,
      pendingRoutes: state.routes.filter((candidate) => candidate.status === "pending"),
    };
  }
  let state = recordSparkReproLaneResultReceipt(input.state, {
    resultId,
    resultDigest,
    evidenceRef: input.evidenceRef,
    status: "accepted",
    reason: "accepted",
  });
  if (state === input.state) {
    return {
      state,
      resultId,
      resultDigest,
      pendingRoutes: state.routes.filter((candidate) => candidate.status === "pending"),
    };
  }
  state = acknowledgeSparkReproRoute(state, result.originRouteId);

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
          result.candidateRevisions.at(-1)!,
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
          result.candidateRevisions.at(-1)!,
        ),
      );
      break;
    }
    case "exactness_mismatch": {
      const { isolation, resynchronization, ...mismatch } = result.mismatch;
      state = registerSparkReproUnresolvedMismatch(state, {
        ...mismatch,
        workItemId: result.workItemId,
        evidenceRefs: evidenceUnion(
          input.evidenceRef,
          result.evidenceRefs,
          result.mismatch.evidenceRefs,
        ),
        ...(isolation
          ? {
              isolation: {
                ...isolation,
                evidenceRefs: isolation.evidenceRefs as EvidenceRef[],
              },
            }
          : {}),
        ...(resynchronization
          ? {
              resynchronization: {
                ...resynchronization,
                evidenceRefs: resynchronization.evidenceRefs as EvidenceRef[],
              },
            }
          : {}),
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
            result.handoff.candidateRevisions.at(-1)!,
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
        route(
          resultId,
          resultDigest,
          result,
          input.evidenceRef,
          "refresh_binding",
          "exactness",
          result.canonicalRevision,
        ),
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
            result.canonicalRevision,
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
        routeId: deterministicRouteId(resultId),
        action: "root_attention",
        workItemId: result.workItemId,
        fromLane: result.lane,
        planRevision: result.planRevision,
        sourceBindingRevision: result.bindingRevision,
        sourceRevision: result.sourceRevision,
        cause: {
          kind: "lane_result",
          id: resultId,
          digest: resultDigest,
          evidenceRef: input.evidenceRef,
        },
        decisionKey: result.decisionKey,
        attention: {
          question: result.question,
          reason: result.reason,
          expectedAnswerKind: result.expectedAnswerKind,
        },
        status: "pending",
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
  action: "materialize_binding" | "refresh_binding",
  toLane: SparkReproLane,
  sourceRevision: string,
): SparkReproRoute {
  const common = {
    routeId: deterministicRouteId(resultId),
    workItemId: result.workItemId,
    planRevision: result.planRevision,
    sourceBindingRevision: result.bindingRevision,
    sourceRevision,
    cause: { kind: "lane_result" as const, id: resultId, digest: resultDigest, evidenceRef },
    status: "pending" as const,
  };
  if (action === "materialize_binding") {
    if (result.lane === "implementation" && toLane === "exactness") {
      return { ...common, action, fromLane: "implementation", toLane: "exactness" };
    }
    if (result.lane === "exactness" && toLane === "formalize") {
      return { ...common, action, fromLane: "exactness", toLane: "formalize" };
    }
  }
  if (action === "refresh_binding") {
    if (result.lane === "formalize" && toLane === "exactness") {
      return { ...common, action, fromLane: "formalize", toLane: "exactness" };
    }
    if (result.lane === "exactness" && toLane === "implementation") {
      return { ...common, action, fromLane: "exactness", toLane: "implementation" };
    }
  }
  throw new Error(`invalid ${action} route from ${result.lane} to ${toLane}`);
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

function evidenceUnion(
  evidenceRef: EvidenceRef,
  ...groups: Array<readonly string[] | undefined>
): EvidenceRef[] {
  return [...new Set([evidenceRef, ...groups.flatMap((group) => group ?? [])])] as EvidenceRef[];
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
