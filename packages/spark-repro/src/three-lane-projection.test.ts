import type { ArtifactRef, EvidenceRef, RunRef, TaskRef } from "@zendev-lab/spark-core";
import { describe, expect, it } from "vitest";

import { createSparkSessionRepro } from "./index.ts";
import { parseSparkReproLaneResult, reconcileSparkReproLaneResult } from "./lane-result.ts";
import { projectSparkReproLanesView } from "./three-lane-projection.ts";
import { registerSparkReproWorkItem, type SparkReproWorkItem } from "./three-lane.ts";

describe("three-lane session projection", () => {
  it("prioritizes blocked work and caps every lane at six display-safe items", () => {
    const repro = createSparkSessionRepro("session:projection");
    let state = repro.threeLane;
    for (let index = 0; index < 8; index += 1) {
      state = registerSparkReproWorkItem(
        state,
        "implementation",
        item(repro.plan.currentRevision, index),
      );
    }

    const projected = projectSparkReproLanesView(state, {
      latestRunRefByTaskRef: new Map([["task:item-7", "run:item-7"]]),
    });

    expect(projected.implementation).toMatchObject({
      status: "blocked",
      totalCount: 8,
      blockedCount: 1,
      openCount: 7,
    });
    expect(projected.implementation.items).toHaveLength(6);
    expect(projected.implementation.items[0]).toMatchObject({
      workItemId: "work:item-7",
      status: "blocked",
      taskRef: "task:item-7",
      runRef: "run:item-7",
      gitChangeRef: "artifact:item-7",
      evidenceRefs: ["evidence:item-7"],
    });
    expect(projected.implementation.items[0]).not.toHaveProperty("scope");
    expect(JSON.stringify(projected)).not.toContain("/private/worktree");
  });

  it("projects an explicit empty state without inventing formalizedTip", () => {
    const projected = projectSparkReproLanesView(
      createSparkSessionRepro("session:empty").threeLane,
    );

    expect(projected).toMatchObject({
      implementation: { status: "empty", totalCount: 0, items: [] },
      exactness: { status: "empty", totalCount: 0, items: [] },
      formalize: { status: "empty", totalCount: 0, items: [] },
    });
    expect(projected).not.toHaveProperty("formalizedTip");
  });

  it("projects the lane binding, daemon-owned latest run, and pending route", () => {
    const repro = createSparkSessionRepro("session:binding-projection");
    let state = registerSparkReproWorkItem(
      repro.threeLane,
      "implementation",
      item(repro.plan.currentRevision, 0),
    );
    const result = parseSparkReproLaneResult({
      schema: "spark.repro.lane-result/v1",
      kind: "implementation_candidate",
      reproId: repro.reproId,
      workItemId: "work:item-0",
      lane: "implementation",
      planRevision: repro.plan.currentRevision,
      bindingRevision: 1,
      taskRef: "task:item-0",
      runRef: "run:terminal",
      sourceRevision: "commit:0",
      evidenceRefs: [],
      scope: "component-0",
      candidateRevisions: ["commit:0"],
      dependsOnHandoffIds: [],
      doneWhen: ["checked"],
    });
    state = reconcileSparkReproLaneResult({
      state,
      reproId: repro.reproId,
      evidenceRef: "evidence:result" as EvidenceRef,
      result,
    }).state;

    const projected = projectSparkReproLanesView(state, {
      latestRunRefByTaskRef: new Map([["task:item-0", "run:terminal"]]),
    });

    expect(projected.implementation.items[0]).toMatchObject({
      bindingRevision: 1,
      bindingStatus: "active",
      sourceRevision: "commit:0",
      runRef: "run:terminal",
      routeAction: "materialize_binding",
      routeStatus: "pending",
    });
  });
});

function item(planRevision: number, index: number): SparkReproWorkItem {
  return {
    workItemId: `work:item-${index}`,
    title: `Candidate ${index}`,
    scope: `/private/worktree/candidate-${index}`,
    planRevision,
    sourceRevision: `commit:${index}`,
    status: index === 7 ? "blocked" : "open",
    taskRef: `task:item-${index}` as TaskRef,
    runRef: `run:item-${index}` as RunRef,
    gitChangeRef: `artifact:item-${index}` as ArtifactRef,
    evidenceRefs: [`evidence:item-${index}` as EvidenceRef],
    unresolvedIds: [],
  };
}
