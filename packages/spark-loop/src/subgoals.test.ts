import { describe, expect, it } from "vitest";

import {
  createSubgoal,
  subgoalDefinitionDigest,
  updateSubgoalStatus,
  decodeSubgoalAssignment,
  decodeSubgoalReceipt,
  encodeSubgoalAssignment,
  encodeSubgoalReceipt,
  verifySubgoalCompletion,
  verifySubgoalReceipt,
} from "./subgoals.ts";
import type {
  EvidenceRef,
  RoleRef,
  SparkSubgoal,
  SparkSubgoalDefinition,
  SubgoalRef,
} from "@zendev-lab/spark-core";

const roleRef = "role:repro-researcher" as RoleRef;
const proofRef = "evidence:experiment-result" as EvidenceRef;
const askRef = "evidence:canonical-ask" as EvidenceRef;
const dependencyRef = "subgoal:baseline" as SubgoalRef;

function subgoal(authority: SparkSubgoalDefinition["authority"] = "safe_local"): SparkSubgoal {
  return createSubgoal({
    ref: "subgoal:training-run" as SubgoalRef,
    goalId: "goal-1",
    roleRef,
    planRevision: 3,
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

describe("subgoal delegation envelopes", () => {
  it("encodes and verifies a matching safe-local done receipt", () => {
    const current = subgoal();
    const assignment = encodeSubgoalAssignment({
      subgoal: current,
      ownerSessionId: "session-owner",
    });
    expect(decodeSubgoalAssignment(assignment)).toMatchObject({
      schema: "spark.subgoal.assignment/v1",
      subgoalRef: current.ref,
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
    });
    const receipt = encodeSubgoalReceipt({
      subgoalRef: current.ref,
      status: "done",
      planRevision: current.planRevision,
      definitionDigest: subgoalDefinitionDigest(current),
      evidenceRefs: [proofRef],
    });
    expect(verifySubgoalReceipt(current, decodeSubgoalReceipt(receipt))).toMatchObject({
      verdict: "Pass",
    });
  });

  it.each(["ask_decision", "ask_approval"] as const)("forbids %s delegation", (authority) => {
    expect(() =>
      encodeSubgoalAssignment({ subgoal: subgoal(authority), ownerSessionId: "owner" }),
    ).toThrow(/only safe_local/);
  });

  it("repairs stale revision, digest, and missing evidence receipts", () => {
    const current = subgoal();
    expect(
      verifySubgoalReceipt(
        current,
        encodeSubgoalReceipt({
          subgoalRef: current.ref,
          status: "done",
          planRevision: current.planRevision - 1,
          definitionDigest: "stale",
          evidenceRefs: [],
        }),
      ),
    ).toMatchObject({ verdict: "Repair" });
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
    expect(reopened.status).toBe("pending");
    expect(reopened.verification).toBeUndefined();
    expect(reopened.evidenceRefs).toEqual([proofRef]);
  });
});
