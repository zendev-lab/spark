import { describe, expect, it } from "vitest";
import {
  parseSparkReproLaneResult,
  parseSparkReproWorkEnqueue,
  sparkReproLaneResultEvidenceRefs,
} from "./repro-lane.ts";

const revision = (character: string) => character.repeat(40);

describe("Repro lane protocol", () => {
  it("accepts the command-generated work intent and rejects extra owner-derived fields", () => {
    const input = {
      schema: "spark.repro.work-enqueue/v1",
      workItemId: "root:glm52",
      title: "Reproduce GLM-5.2",
      scope: "Reach and verify the frozen GLM-5.2 target",
      evidenceRefs: ["evidence:manifest"],
    };
    expect(parseSparkReproWorkEnqueue(input)).toEqual(input);
    expect(() => parseSparkReproWorkEnqueue({ ...input, lane: "implementation" })).toThrow(
      "Unrecognized key",
    );
    expect(() => parseSparkReproWorkEnqueue({ ...input, sourceRevision: revision("a") })).toThrow(
      "Unrecognized key",
    );
  });

  it.each([
    {
      kind: "implementation_candidate",
      lane: "implementation",
      scope: "model",
      candidateRevisions: [revision("b")],
      dependsOnHandoffIds: [],
      doneWhen: ["classify parity"],
    },
    {
      kind: "exactness_finding",
      lane: "exactness",
      finding: {
        findingId: "finding:glm52",
        firstBadBoundary: "attention.output",
        classification: "implementation_defect",
        disposition: "fix",
        confidence: "confirmed",
      },
      scope: "attention.output",
      candidateRevisions: [revision("c")],
      dependsOnHandoffIds: ["handoff:implementation"],
      doneWhen: ["integrate exact mechanism"],
    },
    {
      kind: "exactness_mismatch",
      lane: "exactness",
      mismatch: {
        mismatchId: "mismatch:glm52",
        firstBadBoundary: "attention.output",
        classification: "intrinsic_numerical",
        disposition: "skip",
        confidence: "confirmed",
        isolation: {
          boundary: "attention.output",
          evidenceRefs: ["evidence:isolation"],
        },
        resynchronization: {
          checkpoint: "layer.2",
          evidenceRefs: ["evidence:checkpoint"],
        },
      },
    },
    {
      kind: "formalized",
      lane: "formalize",
      canonicalRevision: revision("d"),
      supersededRevisions: [revision("c")],
    },
    {
      kind: "refresh",
      lane: "exactness",
      canonicalRevision: revision("d"),
      supersededRevisions: [revision("c")],
      outcome: "rebased",
    },
    {
      kind: "attention_request",
      lane: "implementation",
      decisionKey: "baseline:source",
      question: "Which official baseline should be used?",
      reason: "Two official revisions are reachable",
      expectedAnswerKind: "single",
    },
  ])("accepts strict $kind results", (variant) => {
    expect(parseSparkReproLaneResult({ ...common(), ...variant })).toMatchObject(variant);
  });

  it("rejects unknown fields, missing route provenance, invalid directions, and answer kinds", () => {
    const candidate = {
      ...common(),
      kind: "implementation_candidate",
      lane: "implementation",
      scope: "model",
      candidateRevisions: [revision("b")],
      dependsOnHandoffIds: [],
      doneWhen: ["classify parity"],
    };
    expect(() => parseSparkReproLaneResult({ ...candidate, promptClaim: true })).toThrow(
      "Unrecognized key",
    );
    const { originRouteId: _route, ...missingRoute } = candidate;
    expect(() => parseSparkReproLaneResult(missingRoute)).toThrow("originRouteId");
    expect(() => parseSparkReproLaneResult({ ...candidate, lane: "formalize" })).toThrow("lane");
    expect(() =>
      parseSparkReproLaneResult({
        ...common(),
        kind: "refresh",
        lane: "formalize",
        canonicalRevision: revision("d"),
        supersededRevisions: [revision("c")],
        outcome: "refreshed",
      }),
    ).toThrow("lane");
    expect(() =>
      parseSparkReproLaneResult({
        ...common(),
        kind: "attention_request",
        lane: "exactness",
        decisionKey: "baseline:source",
        question: "Choose",
        reason: "ambiguous",
        expectedAnswerKind: "boolean",
      }),
    ).toThrow("expectedAnswerKind");
  });

  it("rejects nested unknown fields and skip without both checkpoints", () => {
    const finding = {
      ...common(),
      kind: "exactness_finding",
      lane: "exactness",
      finding: {
        findingId: "finding:glm52",
        firstBadBoundary: "attention.output",
        classification: "implementation_defect",
        disposition: "fix",
        confidence: "confirmed",
        inferredFromPrompt: true,
      },
      scope: "attention.output",
      candidateRevisions: [revision("c")],
      dependsOnHandoffIds: [],
      doneWhen: ["fix"],
    };
    expect(() => parseSparkReproLaneResult(finding)).toThrow("inferredFromPrompt");
    expect(() =>
      parseSparkReproLaneResult({
        ...common(),
        kind: "exactness_mismatch",
        lane: "exactness",
        mismatch: {
          mismatchId: "mismatch:glm52",
          firstBadBoundary: "attention.output",
          classification: "intrinsic_numerical",
          disposition: "skip",
          confidence: "confirmed",
        },
      }),
    ).toThrow("isolation");
  });

  it("collects every nested Evidence dependency deterministically", () => {
    const result = parseSparkReproLaneResult({
      ...common(),
      evidenceRefs: ["evidence:root"],
      kind: "exactness_mismatch",
      lane: "exactness",
      mismatch: {
        mismatchId: "mismatch:glm52",
        firstBadBoundary: "attention.output",
        classification: "intrinsic_numerical",
        disposition: "skip",
        confidence: "confirmed",
        evidenceRefs: ["evidence:detail"],
        isolation: {
          boundary: "attention.output",
          evidenceRefs: ["evidence:isolation"],
        },
        resynchronization: {
          checkpoint: "layer.2",
          evidenceRefs: ["evidence:checkpoint", "evidence:root"],
        },
      },
    });
    expect(sparkReproLaneResultEvidenceRefs(result)).toEqual([
      "evidence:checkpoint",
      "evidence:detail",
      "evidence:isolation",
      "evidence:root",
    ]);
  });
});

function common() {
  return {
    schema: "spark.repro.lane-result/v1",
    reproId: "repro:glm52",
    workItemId: "root:glm52",
    planRevision: 1,
    bindingRevision: 1,
    taskRef: "task:implementation",
    runRef: "run:implementation-1",
    sourceRevision: revision("a"),
    evidenceRefs: [],
    originRouteId: "route:implementation:start",
  };
}
