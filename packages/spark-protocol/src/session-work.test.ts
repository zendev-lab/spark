import { describe, expect, it } from "vitest";
import { parseSparkSessionView } from "./index.ts";

const baseSnapshot = {
  sessionId: "session-1",
  status: "idle" as const,
  messages: [],
  tools: [],
  runs: [],
  tasks: [],
  artifacts: [],
  evidence: [],
};

const lanes = {
  implementation: {
    sessionId: "session:implementation",
    taskRef: "task:implementation",
    roleRef: "role:spark-repro-implementation",
  },
  exactness: {
    sessionId: "session:exactness",
    taskRef: "task:exactness",
    roleRef: "role:spark-repro-exactness",
  },
  formalize: {
    sessionId: "session:formalize",
    taskRef: "task:formalize",
    roleRef: "role:spark-repro-formalize",
  },
} as const;

describe("SparkSessionView work projection", () => {
  it("keeps snapshots without work compatible", () => {
    expect(parseSparkSessionView(baseSnapshot).work).toBeUndefined();
  });

  it("parses the bounded Repro v10 checkpoint projection", () => {
    const parsed = parseSparkSessionView({
      ...baseSnapshot,
      work: {
        goal: {
          goalId: "goal-1",
          objective: "Reproduce target logits",
          status: "waiting_decision",
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
        repro: {
          version: 10,
          reproId: "repro-1",
          status: "active",
          objective: "Reproduce target logits",
          workItemId: "work:repro-1",
          lanes,
          checkpoint: {
            checkpointId: "checkpoint:exactness",
            kind: "exactness",
            lane: "exactness",
            status: "running",
            sessionId: "session:exactness",
            taskRef: "task:exactness",
            runRef: "run:exactness-1",
            attempt: 1,
            evidenceRefs: [],
          },
          progress: { accepted: 1, total: 5 },
          updatedAt: "2026-08-19T00:00:00.000Z",
        },
      },
    });
    expect(parsed.work?.repro).toMatchObject({
      version: 10,
      checkpoint: { kind: "exactness", runRef: "run:exactness-1" },
      progress: { accepted: 1, total: 5 },
    });
  });

  it("rejects unknown legacy fields and view-model v1", () => {
    expect(() =>
      parseSparkSessionView({
        ...baseSnapshot,
        work: {
          repro: {
            version: 10,
            reproId: "repro-1",
            status: "active",
            objective: "Bound the projection",
            workItemId: "work:repro-1",
            lanes,
            progress: { accepted: 0, total: 5 },
            stage: { name: "alignment" },
            updatedAt: "2026-08-19T00:00:00.000Z",
          },
        },
      }),
    ).toThrow(/Unrecognized key/u);
    expect(() => parseSparkSessionView({ ...baseSnapshot, version: 1 })).toThrow();
  });
});
