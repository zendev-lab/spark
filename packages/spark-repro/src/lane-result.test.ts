import { describe, expect, it } from "vitest";

import type { ArtifactRef, EvidenceRef, RunRef, TaskRef } from "@zendev-lab/spark-core";

import { createSparkSessionRepro } from "./index.ts";
import {
  parseSparkReproLaneResult,
  reconcileSparkReproLaneResult,
  type SparkReproImplementationCandidateResult,
} from "./lane-result.ts";
import {
  bindSparkReproFormalizeOwnership,
  enqueueSparkReproWork,
  materializeSparkReproRouteBinding,
  migrateSparkReproThreeLaneSessionStateV1,
  registerSparkReproWorkItem,
  type SparkReproThreeLaneSessionStateV1,
  type SparkReproWorkItem,
} from "./three-lane.ts";

const evidence = (id: string) => `evidence:${id}` as EvidenceRef;
const task = (id: string) => `task:${id}` as TaskRef;
const run = (id: string) => `run:${id}` as RunRef;
const BASE_REVISION = "1111111111111111111111111111111111111111";
const CANDIDATE_REVISION = "2222222222222222222222222222222222222222";
const CANONICAL_REVISION = "3333333333333333333333333333333333333333";

describe("Spark Repro lane results", () => {
  it("keeps all v8 bindings blocked because their origin route cannot be proven", () => {
    const repro = createSparkSessionRepro("session:v8-migration");
    let state = registerSparkReproWorkItem(
      repro.threeLane,
      "implementation",
      item(repro.plan.currentRevision, "work:unique", task("unique")),
    );
    state = registerSparkReproWorkItem(
      state,
      "implementation",
      item(repro.plan.currentRevision, "work:ambiguous", task("ambiguous")),
    );
    state = registerSparkReproWorkItem(
      state,
      "exactness",
      item(repro.plan.currentRevision, "work:ambiguous", task("ambiguous-exact")),
    );
    const {
      bindings: _bindings,
      compatibilityBindings: _compatibilityBindings,
      routes: _routes,
      resultReceipts: _resultReceipts,
      schema: _schema,
      migration: _migration,
      ...legacy
    } = state;
    const v1 = {
      ...legacy,
      schema: "spark.repro.three-lane-session/v1",
      migration: { sourceVersion: 8, legacyProofAuthority: "not_promoted" },
    } as SparkReproThreeLaneSessionStateV1;

    const migrated = migrateSparkReproThreeLaneSessionStateV1(repro.plan, v1);

    expect(migrated.bindings).toEqual([]);
    expect(migrated.compatibilityBindings).toMatchObject([
      {
        workItemId: "work:unique",
        candidateLanes: ["implementation"],
        schedulable: false,
        reason: "missing_origin_route",
      },
      {
        workItemId: "work:ambiguous",
        candidateLanes: ["implementation", "exactness"],
        schedulable: false,
        reason: "ambiguous_lane",
      },
    ]);
    const requeued = enqueueSparkReproWork(migrated, {
      enqueue: {
        schema: "spark.repro.work-enqueue/v1",
        workItemId: "work:unique",
        title: "Align bounded concern",
        scope: "component.boundary",
      },
      sourceRevision: BASE_REVISION,
    });
    expect(requeued.changed).toBe(true);
    expect(requeued.route).toMatchObject({ action: "start_binding", status: "pending" });
    expect(migrateSparkReproThreeLaneSessionStateV1(repro.plan, v1)).toEqual(migrated);
  });

  it("auto-accepts forward handoffs and fails closed on duplicate identity conflicts", () => {
    const repro = createSparkSessionRepro("session:lane-result");
    const launched = launchImplementation(repro);
    const state = launched.state;
    const result = implementationResult(
      repro.reproId,
      repro.plan.currentRevision,
      launched.routeId,
    );

    const first = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("candidate-result"),
      result,
    });

    expect(first.state.handoffs).toMatchObject([
      { from: "implementation", to: "exactness", status: "accepted" },
    ]);
    expect(first.pendingRoutes).toMatchObject([
      { action: "materialize_binding", toLane: "exactness", status: "pending" },
    ]);
    expect(
      reconcileSparkReproLaneResult({
        state: first.state,
        reproId: repro.reproId,
        evidenceRef: evidence("candidate-result"),
        result,
      }).state,
    ).toEqual(first.state);
    expect(
      reconcileSparkReproLaneResult({
        state: first.state,
        reproId: repro.reproId,
        evidenceRef: evidence("duplicate-carrier"),
        result,
      }).state,
    ).toEqual(first.state);
    expect(() =>
      reconcileSparkReproLaneResult({
        state: first.state,
        reproId: repro.reproId,
        evidenceRef: evidence("candidate-result"),
        result: { ...result, scope: "different content" },
      }),
    ).toThrow("different content");
    const rejected = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("stale-result"),
      result: { ...result, bindingRevision: 2 },
    });
    expect(rejected.state.resultReceipts).toMatchObject([
      { status: "rejected", reason: "stale_binding" },
    ]);
    const acceptedAfterStale = reconcileSparkReproLaneResult({
      state: rejected.state,
      reproId: repro.reproId,
      evidenceRef: evidence("valid-after-stale"),
      result,
    });
    expect(acceptedAfterStale.state.resultReceipts).toMatchObject([
      { status: "rejected", reason: "stale_binding" },
      { status: "accepted", reason: "accepted" },
    ]);
    expect(acceptedAfterStale.state.handoffs).toHaveLength(1);
    expect(() =>
      parseSparkReproLaneResult({
        ...result,
        unboundClaim: "must not be ignored",
      }),
    ).toThrow("Unrecognized key");
  });

  it("requires isolate and resynchronize before a skipped mismatch routes", () => {
    const repro = createSparkSessionRepro("session:skip-result");
    const exactness = launchExactness(repro);
    expect(() =>
      parseSparkReproLaneResult({
        ...common(
          repro.reproId,
          repro.plan.currentRevision,
          "exactness",
          task("exactness"),
          exactness.routeId,
          1,
          CANDIDATE_REVISION,
        ),
        kind: "exactness_mismatch",
        mismatch: {
          mismatchId: "mismatch:skip",
          firstBadBoundary: "component.boundary",
          classification: "intrinsic_numerical",
          disposition: "skip",
          confidence: "confirmed",
        },
      }),
    ).toThrow("skip requires isolation evidence");
  });

  it("converges through Formalize, Exactness refresh, then Implementation refresh", () => {
    const repro = createSparkSessionRepro("session:full-route");
    const launched = launchImplementation(repro);
    let state = launched.state;
    const implementation = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("implementation-result"),
      result: implementationResult(repro.reproId, repro.plan.currentRevision, launched.routeId),
    });
    const exactnessRoute = implementation.pendingRoutes[0]!;
    state = materializeSparkReproRouteBinding(implementation.state, {
      routeId: exactnessRoute.routeId,
      taskRef: task("exactness"),
    });
    const exactnessResult = parseSparkReproLaneResult({
      ...common(
        repro.reproId,
        repro.plan.currentRevision,
        "exactness",
        task("exactness"),
        exactnessRoute.routeId,
        1,
        CANDIDATE_REVISION,
      ),
      kind: "exactness_finding",
      originRouteId: exactnessRoute.routeId,
      finding: {
        findingId: "finding:concern",
        firstBadBoundary: "component.boundary",
        classification: "implementation_defect",
        disposition: "fix",
        confidence: "confirmed",
      },
      scope: "component.boundary",
      candidateRevisions: [CANDIDATE_REVISION],
      dependsOnHandoffIds: [state.handoffs[0]!.handoffId],
      doneWhen: ["Integrate the confirmed mechanism"],
    });
    const exactness = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("exactness-result"),
      result: exactnessResult,
    });
    const formalRoute = exactness.pendingRoutes.find(
      (route) => route.action !== "root_attention" && route.toLane === "formalize",
    )!;
    state = materializeSparkReproRouteBinding(exactness.state, {
      routeId: formalRoute.routeId,
      taskRef: task("formalize"),
    });
    state = bindSparkReproFormalizeOwnership(state, {
      gitChangeRef: "artifact:canonical" as ArtifactRef,
      integratorSessionId: "session:root",
      generation: 1,
    });
    const formalized = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("formalized-result"),
      result: parseSparkReproLaneResult({
        ...common(
          repro.reproId,
          repro.plan.currentRevision,
          "formalize",
          task("formalize"),
          formalRoute.routeId,
          1,
          CANDIDATE_REVISION,
        ),
        kind: "formalized",
        originRouteId: formalRoute.routeId,
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
      }),
    });
    const exactnessRefreshRoute = formalized.pendingRoutes.find(
      (route) => route.action === "refresh_binding" && route.toLane === "exactness",
    )!;
    state = materializeSparkReproRouteBinding(formalized.state, {
      routeId: exactnessRefreshRoute.routeId,
      taskRef: task("exactness-refresh"),
      evidenceRefs: [evidence("exactness-refresh-binding")],
    });
    const exactnessRefresh = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("exactness-refresh-result"),
      result: parseSparkReproLaneResult({
        ...common(
          repro.reproId,
          repro.plan.currentRevision,
          "exactness",
          task("exactness-refresh"),
          exactnessRefreshRoute.routeId,
          2,
          CANONICAL_REVISION,
        ),
        kind: "refresh",
        originRouteId: exactnessRefreshRoute.routeId,
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
        outcome: "rebased",
      }),
    });
    const implementationRefreshRoute = exactnessRefresh.pendingRoutes.find(
      (route) => route.action === "refresh_binding" && route.toLane === "implementation",
    )!;
    state = materializeSparkReproRouteBinding(exactnessRefresh.state, {
      routeId: implementationRefreshRoute.routeId,
      taskRef: task("implementation-refresh"),
      evidenceRefs: [evidence("implementation-refresh-binding")],
    });
    const converged = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("implementation-refresh-result"),
      result: parseSparkReproLaneResult({
        ...common(
          repro.reproId,
          repro.plan.currentRevision,
          "implementation",
          task("implementation-refresh"),
          implementationRefreshRoute.routeId,
          2,
          CANONICAL_REVISION,
        ),
        kind: "refresh",
        originRouteId: implementationRefreshRoute.routeId,
        canonicalRevision: CANONICAL_REVISION,
        supersededRevisions: [CANDIDATE_REVISION],
        outcome: "refreshed",
      }),
    });

    expect(converged.state.workItems[0]).toMatchObject({
      workItemId: "work:concern",
      status: "completed",
      sourceRevision: CANONICAL_REVISION,
    });
    expect(converged.state.bindings.every((binding) => binding.status === "converged")).toBe(true);
    expect(converged.state.routes.every((route) => route.status === "acknowledged")).toBe(true);
  });
});

function item(planRevision: number, workItemId: string, taskRef: TaskRef): SparkReproWorkItem {
  return {
    workItemId,
    title: "Align bounded concern",
    scope: "component.boundary",
    planRevision,
    sourceRevision: "commit:candidate",
    status: "open",
    taskRef,
    evidenceRefs: [],
    unresolvedIds: [],
  };
}

function implementationResult(
  reproId: string,
  planRevision: number,
  originRouteId: string,
): SparkReproImplementationCandidateResult {
  const result = parseSparkReproLaneResult({
    ...common(
      reproId,
      planRevision,
      "implementation",
      task("implementation"),
      originRouteId,
      1,
      BASE_REVISION,
    ),
    kind: "implementation_candidate",
    scope: "component.boundary",
    candidateRevisions: [CANDIDATE_REVISION],
    dependsOnHandoffIds: [],
    doneWhen: ["Classify the first bad boundary"],
  });
  if (result.kind !== "implementation_candidate") throw new Error("unexpected result kind");
  return result;
}

function common(
  reproId: string,
  planRevision: number,
  lane: "implementation" | "exactness" | "formalize",
  taskRef: TaskRef,
  originRouteId: string,
  bindingRevision = 1,
  sourceRevision = BASE_REVISION,
) {
  return {
    schema: "spark.repro.lane-result/v1",
    reproId,
    workItemId: "work:concern",
    lane,
    planRevision,
    bindingRevision,
    originRouteId,
    taskRef,
    runRef: run(`${lane}-${bindingRevision}`),
    sourceRevision,
    evidenceRefs: [],
  };
}

function launchImplementation(repro: ReturnType<typeof createSparkSessionRepro>): {
  state: typeof repro.threeLane;
  routeId: string;
} {
  const enqueued = enqueueSparkReproWork(repro.threeLane, {
    enqueue: {
      schema: "spark.repro.work-enqueue/v1",
      workItemId: "work:concern",
      title: "Align bounded concern",
      scope: "component.boundary",
    },
    sourceRevision: BASE_REVISION,
  });
  return {
    state: materializeSparkReproRouteBinding(enqueued.state, {
      routeId: enqueued.route.routeId,
      taskRef: task("implementation"),
    }),
    routeId: enqueued.route.routeId,
  };
}

function launchExactness(repro: ReturnType<typeof createSparkSessionRepro>): {
  state: typeof repro.threeLane;
  routeId: string;
} {
  const launched = launchImplementation(repro);
  const implementation = reconcileSparkReproLaneResult({
    state: launched.state,
    reproId: repro.reproId,
    evidenceRef: evidence("setup-implementation-result"),
    result: implementationResult(repro.reproId, repro.plan.currentRevision, launched.routeId),
  });
  const route = implementation.pendingRoutes.find(
    (candidate) => candidate.action === "materialize_binding" && candidate.toLane === "exactness",
  )!;
  return {
    state: materializeSparkReproRouteBinding(implementation.state, {
      routeId: route.routeId,
      taskRef: task("exactness"),
    }),
    routeId: route.routeId,
  };
}
