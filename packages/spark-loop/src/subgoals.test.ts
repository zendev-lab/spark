import { describe, expect, it } from "vitest";

import {
  createSubgoal,
  subgoalDefinitionDigest,
  updateSubgoalStatus,
  verifySubgoalCompletion,
} from "./subgoals.ts";
import type {
  EvidenceRef,
  SparkSubgoal,
  SparkSubgoalDefinition,
  SubgoalRef,
  TaskRef,
} from "@zendev-lab/spark-core";

const proofRef = "evidence:experiment-result" as EvidenceRef;
const askRef = "evidence:canonical-ask" as EvidenceRef;
const dependencyRef = "subgoal:baseline" as SubgoalRef;
const taskRef = "task:reference-training" as TaskRef;

function subgoal(authority: SparkSubgoalDefinition["authority"] = "safe_local"): SparkSubgoal {
  return createSubgoal({
    ref: "subgoal:training-run" as SubgoalRef,
    planRevision: 3,
    taskRef,
    goal: "Run the reference training experiment",
    doneWhen: ["The command exits with code 0", "The loss curve is captured"],
    evidenceRequired: ["Command result", "Loss curve artifact"],
    authority,
    dependsOn: [dependencyRef],
    now: "2026-07-27T00:00:00.000Z",
  });
}

describe("subgoalDefinitionDigest", () => {
  it("changes for every completion-contract field", () => {
    const baseline = subgoal();
    const digest = subgoalDefinitionDigest(baseline);
    const changedDefinitions: SparkSubgoalDefinition[] = [
      { ...baseline, goal: "Run a different experiment" },
      { ...baseline, doneWhen: ["The validation command exits with code 0"] },
      { ...baseline, evidenceRequired: ["Validation command result"] },
      { ...baseline, authority: "ask_decision" },
      { ...baseline, dependsOn: ["subgoal:scaffold" as SubgoalRef] },
    ];

    for (const definition of changedDefinitions) {
      expect(subgoalDefinitionDigest(definition)).not.toBe(digest);
    }
  });

  it("ignores runtime status and evidence", () => {
    const baseline = subgoal();
    const runtimeChanged: SparkSubgoal = {
      ...baseline,
      status: "done",
      evidenceRefs: [proofRef],
    };

    expect(subgoalDefinitionDigest(runtimeChanged)).toBe(subgoalDefinitionDigest(baseline));
  });
});

describe("createSubgoal", () => {
  it("binds at most one project task and owns no session or role state", () => {
    const current = subgoal();
    expect(current.taskRef).toBe(taskRef);
    expect(current).not.toHaveProperty("taskRefs");
    expect(current).not.toHaveProperty("goalId");
    expect(current).not.toHaveProperty("roleRef");
    expect(current).not.toHaveProperty("delegation");
  });

  it("accepts driver-local authority without making it an Ask authority", () => {
    const current = subgoal("driver_local");
    const result = verifySubgoalCompletion(current, {
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
    });

    expect(result).toMatchObject({
      verdict: "Pass",
      evidenceRefs: [proofRef],
    });
    expect(result).not.toHaveProperty("canonicalAskEvidenceRef");
  });
});

describe("verifySubgoalCompletion", () => {
  it("passes safe-local proof bound to the current plan revision and definition", () => {
    const current = subgoal();
    expect(
      verifySubgoalCompletion(current, {
        planRevision: current.planRevision,
        definitionDigest: subgoalDefinitionDigest(current),
        evidenceRefs: [proofRef],
      }),
    ).toEqual({
      verdict: "Pass",
      subgoalRef: current.ref,
      planRevision: 3,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
      verifiedDoneWhen: current.doneWhen,
    });
  });

  it("repairs a stale plan revision or definition digest", () => {
    const current = subgoal();
    const result = verifySubgoalCompletion(current, {
      planRevision: 2,
      definitionDigest: "stale",
      evidenceRefs: [proofRef],
    });

    expect(result.verdict).toBe("Repair");
    if (result.verdict !== "Repair") throw new Error("expected Repair verdict");
    expect(result.reasons).toEqual([
      "proof planRevision does not match the current subgoal plan revision",
      "proof definitionDigest does not match the current subgoal definition",
    ]);
  });

  it("requires canonical ask evidence for decision authority", () => {
    const current = subgoal("ask_decision");
    const proof = {
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
    };

    const missingAsk = verifySubgoalCompletion(current, proof);
    expect(missingAsk.verdict).toBe("Repair");
    if (missingAsk.verdict !== "Repair") throw new Error("expected Repair verdict");
    expect(missingAsk.reasons).toContain(
      "ask_decision completion requires a canonical ask evidence ref",
    );

    expect(
      verifySubgoalCompletion(current, {
        ...proof,
        evidenceRefs: [proofRef, askRef],
        canonicalAskEvidenceRef: askRef,
      }),
    ).toMatchObject({
      verdict: "Pass",
      canonicalAskEvidenceRef: askRef,
      evidenceRefs: [proofRef, askRef],
    });
  });
});

describe("updateSubgoalStatus", () => {
  it("only writes done with a passing verifier bound to the supplied evidence", () => {
    const current = subgoal();
    const verification = verifySubgoalCompletion(current, {
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
    });
    expect(verification.verdict).toBe("Pass");

    const completed = updateSubgoalStatus(current, {
      status: "done",
      evidenceRefs: [proofRef],
      verifier: verification,
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "done",
      evidenceRefs: [proofRef],
      verification,
      updatedAt: "2026-07-27T00:01:00.000Z",
    });
    expect(() =>
      updateSubgoalStatus(current, { status: "done", evidenceRefs: [proofRef] }),
    ).toThrow(/requires a passing verifier result/);
  });

  it("clears runtime proof when a completed subgoal is reopened", () => {
    const current = subgoal();
    const verification = verifySubgoalCompletion(current, {
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
    });
    if (verification.verdict !== "Pass") throw new Error("expected Pass verdict");
    const completed = updateSubgoalStatus(current, {
      status: "done",
      evidenceRefs: [proofRef],
      verifier: verification,
    });

    const reopened = updateSubgoalStatus(completed, { status: "pending" });
    expect(reopened).toMatchObject({
      status: "pending",
      evidenceRefs: [proofRef],
      verification: undefined,
    });
  });
});
