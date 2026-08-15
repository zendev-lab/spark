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
  migrateSparkReproThreeLaneSessionStateV1,
  rematerializeSparkReproWorkItem,
  registerSparkReproWorkItem,
  type SparkReproThreeLaneSessionStateV1,
  type SparkReproWorkItem,
} from "./three-lane.ts";

const evidence = (id: string) => `evidence:${id}` as EvidenceRef;
const task = (id: string) => `task:${id}` as TaskRef;
const run = (id: string) => `run:${id}` as RunRef;

describe("Spark Repro lane results", () => {
  it("migrates only uniquely provable v8 source bindings", () => {
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

    expect(migrated.bindings).toMatchObject([
      { workItemId: "work:unique", lane: "implementation", bindingRevision: 1 },
    ]);
    expect(migrated.compatibilityBindings).toMatchObject([
      {
        workItemId: "work:ambiguous",
        candidateLanes: ["implementation", "exactness"],
        schedulable: false,
        reason: "ambiguous_lane",
      },
    ]);
    expect(migrateSparkReproThreeLaneSessionStateV1(repro.plan, v1)).toEqual(migrated);
  });

  it("auto-accepts forward handoffs and fails closed on duplicate identity conflicts", () => {
    const repro = createSparkSessionRepro("session:lane-result");
    const state = registerSparkReproWorkItem(
      repro.threeLane,
      "implementation",
      item(repro.plan.currentRevision, "work:concern", task("implementation")),
    );
    const result = implementationResult(repro.reproId, repro.plan.currentRevision);

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
    expect(() =>
      reconcileSparkReproLaneResult({
        state,
        reproId: repro.reproId,
        evidenceRef: evidence("candidate-result"),
        result: { ...result, bindingRevision: 2 },
      }),
    ).toThrow("stale or foreign");
    expect(() =>
      parseSparkReproLaneResult({
        ...result,
        unboundClaim: "must not be ignored",
      }),
    ).toThrow("unknown field");
  });

  it("requires isolate and resynchronize before a skipped mismatch routes", () => {
    const repro = createSparkSessionRepro("session:skip-result");
    const state = registerSparkReproWorkItem(
      repro.threeLane,
      "exactness",
      item(repro.plan.currentRevision, "work:concern", task("exactness")),
    );
    const result = parseSparkReproLaneResult({
      ...common(repro.reproId, repro.plan.currentRevision, "exactness", task("exactness")),
      kind: "exactness_mismatch",
      mismatch: {
        mismatchId: "mismatch:skip",
        firstBadBoundary: "component.boundary",
        classification: "intrinsic_numerical",
        disposition: "skip",
        confidence: "confirmed",
      },
    });

    expect(() =>
      reconcileSparkReproLaneResult({
        state,
        reproId: repro.reproId,
        evidenceRef: evidence("skip"),
        result,
      }),
    ).toThrow("requires both isolation and resynchronization");
  });

  it("converges through Formalize, Exactness refresh, then Implementation refresh", () => {
    const repro = createSparkSessionRepro("session:full-route");
    let state = registerSparkReproWorkItem(
      repro.threeLane,
      "implementation",
      item(repro.plan.currentRevision, "work:concern", task("implementation")),
    );
    const implementation = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("implementation-result"),
      result: implementationResult(repro.reproId, repro.plan.currentRevision),
    });
    const exactnessRoute = implementation.pendingRoutes[0]!;
    state = registerSparkReproWorkItem(
      implementation.state,
      "exactness",
      item(repro.plan.currentRevision, "work:concern", task("exactness")),
    );
    const exactnessResult = parseSparkReproLaneResult({
      ...common(repro.reproId, repro.plan.currentRevision, "exactness", task("exactness")),
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
      candidateRevisions: ["commit:candidate"],
      dependsOnHandoffIds: [state.handoffs[0]!.handoffId],
      doneWhen: ["Integrate the confirmed mechanism"],
    });
    const exactness = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: evidence("exactness-result"),
      result: exactnessResult,
    });
    const formalRoute = exactness.pendingRoutes.find((route) => route.toLane === "formalize")!;
    state = registerSparkReproWorkItem(
      exactness.state,
      "formalize",
      item(repro.plan.currentRevision, "work:concern", task("formalize")),
    );
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
        ...common(repro.reproId, repro.plan.currentRevision, "formalize", task("formalize")),
        kind: "formalized",
        originRouteId: formalRoute.routeId,
        canonicalRevision: "commit:canonical",
        supersededRevisions: ["commit:candidate"],
      }),
    });
    const exactnessRefreshRoute = formalized.pendingRoutes.find(
      (route) => route.action === "refresh_binding" && route.toLane === "exactness",
    )!;
    state = rematerializeSparkReproWorkItem(formalized.state, {
      workItemId: "work:concern",
      lane: "exactness",
      expectedBindingRevision: 1,
      expectedSourceRevision: "commit:candidate",
      sourceRevision: "commit:candidate",
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
          2,
          "commit:candidate",
        ),
        kind: "refresh",
        originRouteId: exactnessRefreshRoute.routeId,
        canonicalRevision: "commit:canonical",
        supersededRevisions: ["commit:candidate"],
        outcome: "rebased",
      }),
    });
    const implementationRefreshRoute = exactnessRefresh.pendingRoutes.find(
      (route) => route.action === "refresh_binding" && route.toLane === "implementation",
    )!;
    state = rematerializeSparkReproWorkItem(exactnessRefresh.state, {
      workItemId: "work:concern",
      lane: "implementation",
      expectedBindingRevision: 1,
      expectedSourceRevision: "commit:candidate",
      sourceRevision: "commit:candidate",
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
          2,
          "commit:candidate",
        ),
        kind: "refresh",
        originRouteId: implementationRefreshRoute.routeId,
        canonicalRevision: "commit:canonical",
        supersededRevisions: ["commit:candidate"],
        outcome: "refreshed",
      }),
    });

    expect(converged.state.workItems[0]).toMatchObject({
      workItemId: "work:concern",
      status: "completed",
      sourceRevision: "commit:canonical",
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
): SparkReproImplementationCandidateResult {
  const result = parseSparkReproLaneResult({
    ...common(reproId, planRevision, "implementation", task("implementation")),
    kind: "implementation_candidate",
    scope: "component.boundary",
    candidateRevisions: ["commit:candidate"],
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
  bindingRevision = 1,
  sourceRevision = "commit:candidate",
) {
  return {
    schema: "spark.repro.lane-result/v1",
    reproId,
    workItemId: "work:concern",
    lane,
    planRevision,
    bindingRevision,
    taskRef,
    runRef: run(`${lane}-${bindingRevision}`),
    sourceRevision,
    evidenceRefs: [],
  };
}
