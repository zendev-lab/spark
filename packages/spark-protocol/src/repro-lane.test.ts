import { describe, expect, it } from "vitest";
import { parseSparkReproLaneResult, sparkReproLaneResultSchema } from "./repro-lane.ts";

const implementation = {
  schema: "spark.repro.lane-result/v2",
  kind: "checkpoint_result",
  reproId: "repro:one",
  checkpointId: "checkpoint:implementation",
  sessionId: "session:implementation",
  taskRef: "task:implementation",
  runRef: "run:implementation-1",
  lane: "implementation",
  checkpoint: "implementation",
  summary: "Target entrypoint executes.",
  evidenceRefs: ["evidence:implementation"],
} as const;

describe("spark.repro.lane-result/v2", () => {
  it("accepts checkpoint and attention results and rejects unknown fields", () => {
    expect(parseSparkReproLaneResult(implementation)).toEqual(implementation);
    const { summary: _summary, ...common } = implementation;
    expect(
      sparkReproLaneResultSchema.parse({
        ...common,
        kind: "attention_request",
        decisionKey: "decision:reference",
        question: "Which reference checkpoint should be used?",
        reason: "Two authoritative candidates remain.",
        expectedAnswerKind: "single",
      }),
    ).toMatchObject({ kind: "attention_request" });
    expect(() =>
      parseSparkReproLaneResult({ ...implementation, originRouteId: "retired" }),
    ).toThrow(/Unrecognized key/u);
  });

  it("requires checkpoint provenance and rejects retired Git binding fields", () => {
    const { checkpointId: _checkpointId, ...missing } = implementation;
    expect(() => parseSparkReproLaneResult(missing)).toThrow(/checkpointId/u);
    expect(() =>
      parseSparkReproLaneResult({ ...implementation, sourceRevision: "a".repeat(40) }),
    ).toThrow(/Unrecognized key/u);
  });

  it("allows only Formalize to set formalizedRevision", () => {
    expect(() =>
      parseSparkReproLaneResult({ ...implementation, formalizedRevision: "commit:canonical" }),
    ).toThrow(/only Formalize/u);
    expect(
      parseSparkReproLaneResult({
        ...implementation,
        checkpointId: "checkpoint:formalize",
        sourceCheckpointId: "checkpoint:exactness",
        sessionId: "session:formalize",
        taskRef: "task:formalize",
        runRef: "run:formalize-1",
        lane: "formalize",
        checkpoint: "formalize",
        formalizedRevision: "commit:canonical",
      }),
    ).toMatchObject({ checkpoint: "formalize", formalizedRevision: "commit:canonical" });
  });

  it("requires the Formalize parent only on refresh checkpoints", () => {
    const refresh = {
      ...implementation,
      checkpointId: "checkpoint:exactness-refresh",
      sourceCheckpointId: "checkpoint:formalize",
      sessionId: "session:exactness",
      taskRef: "task:exactness",
      runRef: "run:exactness-2",
      lane: "exactness",
      checkpoint: "exactness_refresh",
    } as const;
    expect(() => parseSparkReproLaneResult(refresh)).toThrow(/parentCheckpointId/u);
    expect(
      parseSparkReproLaneResult({
        ...refresh,
        parentCheckpointId: "checkpoint:formalize",
      }),
    ).toMatchObject({ checkpoint: "exactness_refresh" });
    expect(() =>
      parseSparkReproLaneResult({
        ...implementation,
        parentCheckpointId: "checkpoint:formalize",
      }),
    ).toThrow(/only refresh/u);
  });
});
