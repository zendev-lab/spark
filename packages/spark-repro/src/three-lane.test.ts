import { describe, expect, it } from "vitest";

import type { ArtifactRef, EvidenceRef, TaskRef } from "@zendev-lab/spark-core";

import {
  createSparkSessionRepro,
  migrateSparkSessionReproV7,
  type SparkSessionReproV7,
} from "./index.ts";
import {
  bindSparkReproFormalizeOwnership,
  enqueueSparkReproWork,
  materializeSparkReproRouteBinding,
  recordSparkReproRoute,
  recordSparkReproResolution,
  recordSparkReproWorkHandoff,
  rematerializeSparkReproWorkItem,
  registerSparkReproUnresolvedMismatch,
  registerSparkReproWorkItem,
  resumeSparkReproRouteFromAnswer,
  resumeSparkReproRouteFromRepair,
  type SparkReproResolution,
  type SparkReproUnresolvedMismatch,
  type SparkReproWorkItem,
} from "./three-lane.ts";

const evidence = (id: string) => `evidence:${id}` as EvidenceRef;
const BASE_REVISION = "1111111111111111111111111111111111111111";

describe("Spark Repro three-lane domain", () => {
  it("persists a deterministic launch checkpoint before owner side effects", () => {
    const repro = createSparkSessionRepro("session:enqueue-checkpoint");
    const input = {
      enqueue: {
        schema: "spark.repro.work-enqueue/v1" as const,
        workItemId: "work:glm52",
        title: "Reproduce GLM-5.2",
        scope: "glm52",
      },
      sourceRevision: BASE_REVISION,
    };

    const first = enqueueSparkReproWork(repro.threeLane, input);
    expect(first.changed).toBe(true);
    expect(first.route).toMatchObject({
      action: "start_binding",
      fromLane: "implementation",
      toLane: "implementation",
      sourceBindingRevision: 0,
      status: "pending",
      cause: { kind: "enqueue", id: "work:glm52" },
    });

    const replay = enqueueSparkReproWork(first.state, input);
    expect(replay.changed).toBe(false);
    expect(replay.state).toBe(first.state);
    expect(replay.route.routeId).toBe(first.route.routeId);
    expect(() =>
      enqueueSparkReproWork(first.state, {
        ...input,
        enqueue: { ...input.enqueue, title: "Different intent" },
      }),
    ).toThrow("different identity");

    const materialized = materializeSparkReproRouteBinding(first.state, {
      routeId: first.route.routeId,
      taskRef: "task:glm52-implementation" as TaskRef,
      gitChangeRef: "artifact:glm52-implementation" as ArtifactRef,
    });
    expect(materialized.bindings[0]).toMatchObject({
      lane: "implementation",
      bindingRevision: 1,
      originRouteId: first.route.routeId,
    });
    expect(
      materializeSparkReproRouteBinding(materialized, {
        routeId: first.route.routeId,
        taskRef: "task:glm52-implementation" as TaskRef,
        gitChangeRef: "artifact:glm52-implementation" as ArtifactRef,
      }),
    ).toBe(materialized);
  });

  it("turns one answered attention checkpoint into a same-lane resume route", () => {
    const repro = createSparkSessionRepro("session:attention-resume");
    const enqueued = enqueueSparkReproWork(repro.threeLane, {
      enqueue: {
        schema: "spark.repro.work-enqueue/v1",
        workItemId: "work:glm52",
        title: "Reproduce GLM-5.2",
        scope: "glm52",
      },
      sourceRevision: BASE_REVISION,
    });
    let state = materializeSparkReproRouteBinding(enqueued.state, {
      routeId: enqueued.route.routeId,
      taskRef: "task:glm52-implementation" as TaskRef,
      gitChangeRef: "artifact:glm52-implementation" as ArtifactRef,
    });
    state = recordSparkReproRoute(state, {
      routeId: "route:glm52-attention",
      action: "root_attention",
      workItemId: "work:glm52",
      fromLane: "implementation",
      planRevision: state.planRevision,
      sourceBindingRevision: 1,
      sourceRevision: BASE_REVISION,
      cause: {
        kind: "lane_result",
        id: "result:glm52-attention",
        digest: "attention-digest",
        evidenceRef: evidence("attention"),
      },
      decisionKey: "decision:glm52-config",
      attention: {
        question: "Which GLM-5.2 checkpoint?",
        reason: "The model source must be frozen",
        expectedAnswerKind: "single",
      },
      status: "pending",
    });

    const resumed = resumeSparkReproRouteFromAnswer(state, {
      attentionRouteId: "route:glm52-attention",
      answerId: "answer:glm52-config",
      answerDigest: "answer-digest",
      evidenceRef: evidence("answer"),
    });
    expect(resumed.routes).toMatchObject([
      { action: "start_binding", status: "pending" },
      { action: "root_attention", status: "acknowledged" },
      {
        action: "resume_binding",
        fromLane: "implementation",
        toLane: "implementation",
        sourceBindingRevision: 1,
        status: "pending",
        cause: { kind: "answer", id: "answer:glm52-config" },
      },
    ]);
  });

  it("routes a rolled-back Git conflict to the lane that produced the revision", () => {
    const repro = createSparkSessionRepro("session:repair-resume");
    const enqueued = enqueueSparkReproWork(repro.threeLane, {
      enqueue: {
        schema: "spark.repro.work-enqueue/v1",
        workItemId: "work:glm52",
        title: "Reproduce GLM-5.2",
        scope: "glm52",
      },
      sourceRevision: BASE_REVISION,
    });
    let state = materializeSparkReproRouteBinding(enqueued.state, {
      routeId: enqueued.route.routeId,
      taskRef: "task:glm52-implementation" as TaskRef,
      gitChangeRef: "artifact:glm52-implementation" as ArtifactRef,
    });
    state = recordSparkReproRoute(state, {
      routeId: "route:glm52-to-exactness",
      action: "materialize_binding",
      workItemId: "work:glm52",
      fromLane: "implementation",
      toLane: "exactness",
      planRevision: state.planRevision,
      sourceBindingRevision: 1,
      sourceRevision: "2222222222222222222222222222222222222222",
      cause: {
        kind: "lane_result",
        id: "result:glm52-implementation",
        digest: "result-digest",
        evidenceRef: evidence("implementation-result"),
      },
      status: "pending",
    });

    const repaired = resumeSparkReproRouteFromRepair(state, {
      failedRouteId: "route:glm52-to-exactness",
      repairDigest: "conflict-digest",
      evidenceRef: evidence("git-conflict"),
    });
    expect(repaired.routes.at(-2)).toMatchObject({
      routeId: "route:glm52-to-exactness",
      status: "acknowledged",
    });
    expect(repaired.routes.at(-1)).toMatchObject({
      action: "resume_binding",
      fromLane: "implementation",
      toLane: "implementation",
      sourceBindingRevision: 1,
      sourceRevision: BASE_REVISION,
      status: "pending",
      cause: {
        kind: "repair",
        id: "route:glm52-to-exactness",
        digest: "conflict-digest",
        evidenceRef: evidence("git-conflict"),
      },
    });
    expect(
      resumeSparkReproRouteFromRepair(repaired, {
        failedRouteId: "route:glm52-to-exactness",
        repairDigest: "conflict-digest",
        evidenceRef: evidence("git-conflict"),
      }),
    ).toBe(repaired);
    expect(() =>
      resumeSparkReproRouteFromRepair(repaired, {
        failedRouteId: "route:glm52-to-exactness",
        repairDigest: "different-conflict",
        evidenceRef: evidence("git-conflict"),
      }),
    ).toThrow("different repair checkpoint");
  });

  it("migrates v7 Explore into Implementation without inventing Exactness or formal proof", () => {
    const current = createSparkSessionRepro("session:migrate-v7");
    const { version: _version, threeLane: _threeLane, ...legacyBase } = current;
    const legacy: SparkSessionReproV7 = {
      ...legacyBase,
      version: 7,
      dualLane: {
        schema: "spark.repro.dual-lane-session/v1",
        planRevision: current.plan.currentRevision,
        explore: { stage: "reference", observationIds: ["obs:1"] },
        normative: {
          orderedStepIds: [...current.threeLane.formalize.orderedStepIds],
          ...(current.threeLane.formalize.currentStepId
            ? { currentStepId: current.threeLane.formalize.currentStepId }
            : {}),
          retiredStepIds: [],
          candidateIds: [],
        },
        unresolvedIds: ["unresolved:legacy"],
        migration: { sourceVersion: 7, legacyProofAuthority: "not_promoted" },
      },
    };

    const migrated = migrateSparkSessionReproV7(legacy);

    expect(migrated).toMatchObject({
      version: 9,
      threeLane: {
        schema: "spark.repro.three-lane-session/v2",
        implementation: { stage: "reference", observationIds: ["obs:1"], workItemIds: [] },
        exactness: { workItemIds: [], findingIds: [], mismatchIds: [] },
        workItems: [],
        handoffs: [],
        resolutions: [],
        unresolvedIds: ["unresolved:legacy"],
        migration: { sourceVersion: 7, legacyProofAuthority: "not_promoted" },
      },
    });
    expect(migrated.threeLane.formalize).not.toHaveProperty("formalizedTip");
    expect(migrateSparkSessionReproV7(legacy)).toEqual(migrated);
  });

  it("keeps work identity stable while fencing stale forward handoffs", () => {
    const repro = createSparkSessionRepro("session:handoff");
    const item = workItem(repro.plan.currentRevision);
    const withItem = registerSparkReproWorkItem(repro.threeLane, "implementation", item);
    const handoff = {
      handoffId: "handoff:implementation-exactness",
      workItemId: item.workItemId,
      from: "implementation" as const,
      to: "exactness" as const,
      planRevision: repro.plan.currentRevision,
      sourceRevision: item.sourceRevision,
      scope: "RMSNorm output boundary",
      findingIds: [],
      evidenceRefs: [evidence("candidate")],
      candidateRevisions: ["commit:rebased-a"],
      dependsOnHandoffIds: [],
      doneWhen: ["Classify the first bad boundary"],
      status: "pending" as const,
    };

    const accepted = recordSparkReproWorkHandoff(withItem, handoff);
    expect(accepted.exactness.workItemIds).toEqual([item.workItemId]);
    expect(recordSparkReproWorkHandoff(accepted, handoff)).toEqual(accepted);
    expect(() =>
      recordSparkReproWorkHandoff(withItem, { ...handoff, sourceRevision: "commit:stale" }),
    ).toThrow("stale Repro handoff source revision");
  });

  it("requires isolate and resynchronize evidence before skipping a mismatch", () => {
    const repro = createSparkSessionRepro("session:mismatch");
    const item = workItem(repro.plan.currentRevision);
    const state = registerSparkReproWorkItem(repro.threeLane, "exactness", item);
    const mismatch: SparkReproUnresolvedMismatch = {
      mismatchId: "mismatch:rmsnorm",
      workItemId: item.workItemId,
      firstBadBoundary: "layers.0.input_layernorm",
      classification: "intrinsic_numerical",
      disposition: "skip",
      confidence: "confirmed",
      evidenceRefs: [evidence("first-bad")],
    };

    expect(() => registerSparkReproUnresolvedMismatch(state, mismatch)).toThrow(
      "requires both isolation and resynchronization",
    );

    const recorded = registerSparkReproUnresolvedMismatch(state, {
      ...mismatch,
      isolation: { boundary: "input_layernorm", evidenceRefs: [evidence("isolate")] },
      resynchronization: { checkpoint: "post_norm", evidenceRefs: [evidence("resync")] },
    });
    expect(recorded.exactness.mismatchIds).toEqual([mismatch.mismatchId]);
  });

  it("keeps workItemId stable across rebases and stales prior handoffs", () => {
    const repro = createSparkSessionRepro("session:rematerialize");
    const item = workItem(repro.plan.currentRevision);
    const withItem = registerSparkReproWorkItem(repro.threeLane, "implementation", item);
    const withHandoff = recordSparkReproWorkHandoff(withItem, {
      handoffId: "handoff:before-rebase",
      workItemId: item.workItemId,
      from: "implementation",
      to: "exactness",
      planRevision: repro.plan.currentRevision,
      sourceRevision: item.sourceRevision,
      scope: item.scope,
      findingIds: [],
      evidenceRefs: [evidence("handoff")],
      candidateRevisions: [item.sourceRevision],
      dependsOnHandoffIds: [],
      doneWhen: ["Classify the boundary"],
      status: "accepted",
    });

    const rematerialized = rematerializeSparkReproWorkItem(withHandoff, {
      workItemId: item.workItemId,
      lane: "implementation",
      expectedBindingRevision: 1,
      expectedSourceRevision: item.sourceRevision,
      sourceRevision: "commit:candidate-after-rebase",
      evidenceRefs: [evidence("rebase")],
    });

    expect(rematerialized.bindings[0]).toMatchObject({
      workItemId: item.workItemId,
      sourceRevision: "commit:candidate-after-rebase",
    });
    expect(rematerialized.handoffs[0]?.status).toBe("stale");
    expect(() =>
      rematerializeSparkReproWorkItem(rematerialized, {
        workItemId: item.workItemId,
        lane: "implementation",
        expectedBindingRevision: 1,
        expectedSourceRevision: item.sourceRevision,
        sourceRevision: "commit:stale-write",
        evidenceRefs: [evidence("stale")],
      }),
    ).toThrow("stale work item materialization revision");
  });

  it("isolates source and binding revisions by WorkItem lane", () => {
    const repro = createSparkSessionRepro("session:binding-isolation");
    const item = workItem(repro.plan.currentRevision);
    let state = registerSparkReproWorkItem(repro.threeLane, "implementation", item);
    state = registerSparkReproWorkItem(state, "exactness", {
      ...item,
      taskRef: "task:exactness" as TaskRef,
      gitChangeRef: "artifact:exactness" as ArtifactRef,
    });

    const updated = rematerializeSparkReproWorkItem(state, {
      workItemId: item.workItemId,
      lane: "exactness",
      expectedBindingRevision: 1,
      expectedSourceRevision: item.sourceRevision,
      sourceRevision: "commit:exactness-only",
      taskRef: "task:exactness-refresh" as TaskRef,
      evidenceRefs: [evidence("exactness-refresh")],
    });

    expect(updated.bindings.find((binding) => binding.lane === "implementation")).toMatchObject({
      bindingRevision: 1,
      sourceRevision: item.sourceRevision,
      taskRef: item.taskRef,
    });
    expect(updated.bindings.find((binding) => binding.lane === "exactness")).toMatchObject({
      bindingRevision: 2,
      sourceRevision: "commit:exactness-only",
      taskRef: "task:exactness-refresh",
    });
    expect(updated.workItems[0]?.sourceRevision).toBe(item.sourceRevision);
  });

  it("binds Formalize to one stack integrator idempotently", () => {
    const repro = createSparkSessionRepro("session:formalize-owner");
    const ownership = {
      gitChangeRef: "artifact:git-change" as ArtifactRef,
      integratorSessionId: "session:integrator",
    };

    const bound = bindSparkReproFormalizeOwnership(repro.threeLane, ownership);
    expect(bound.formalize.ownership).toEqual({ ...ownership, generation: 1 });
    expect(bindSparkReproFormalizeOwnership(bound, ownership)).toBe(bound);
    expect(() =>
      bindSparkReproFormalizeOwnership(bound, {
        ...ownership,
        integratorSessionId: "session:specialist",
      }),
    ).toThrow("another stack integrator");

    const replaced = bindSparkReproFormalizeOwnership(bound, {
      ...ownership,
      integratorSessionId: "session:integrator-recovered",
      generation: 2,
    });
    expect(replaced.formalize.ownership).toMatchObject({
      integratorSessionId: "session:integrator-recovered",
      generation: 2,
    });
    expect(() =>
      bindSparkReproFormalizeOwnership(bound, {
        gitChangeRef: "artifact:other-stack" as ArtifactRef,
        integratorSessionId: "session:integrator-recovered",
        generation: 2,
      }),
    ).toThrow("cannot replace the canonical GitChange");
  });

  it("propagates a typed resolution backward and updates only the accepted formalized tip", () => {
    const repro = createSparkSessionRepro("session:resolution");
    const item = workItem(repro.plan.currentRevision);
    const state = registerSparkReproWorkItem(repro.threeLane, "formalize", item);
    const formalResolution: SparkReproResolution = {
      resolutionId: "resolution:formal-exact",
      workItemId: item.workItemId,
      from: "formalize",
      to: "exactness",
      status: "resolved",
      canonicalRevision: "commit:canonical",
      supersededRevisions: [item.sourceRevision],
      evidenceRefs: [evidence("formal")],
    };
    const resolvedExactness = recordSparkReproResolution(state, formalResolution);
    expect(resolvedExactness.formalize.formalizedTip).toBe("commit:canonical");

    const implementationResolution: SparkReproResolution = {
      resolutionId: "resolution:exact-implementation",
      workItemId: item.workItemId,
      from: "exactness",
      to: "implementation",
      status: "superseded",
      canonicalRevision: "commit:canonical",
      supersededRevisions: [item.sourceRevision],
      evidenceRefs: [evidence("backprop")],
      parentResolutionId: formalResolution.resolutionId,
    };
    expect(
      recordSparkReproResolution(resolvedExactness, implementationResolution).resolutions,
    ).toHaveLength(2);
    expect(() => recordSparkReproResolution(state, implementationResolution)).toThrow(
      "requires its matching Formalize resolution",
    );
  });
});

function workItem(planRevision: number): SparkReproWorkItem {
  return {
    workItemId: "work:rmsnorm-boundary",
    title: "Localize RMSNorm divergence",
    scope: "layers.0.input_layernorm",
    planRevision,
    sourceRevision: "commit:candidate-a",
    taskRef: "task:rmsnorm-boundary" as TaskRef,
    status: "open",
    evidenceRefs: [],
    unresolvedIds: [],
  };
}
