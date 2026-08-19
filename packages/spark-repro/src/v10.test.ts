import { describe, expect, it } from "vitest";
import {
  acceptSparkReproLaneResult,
  activateSparkReproV10,
  answerSparkReproAttention,
  bindSparkReproCheckpointRun,
  blockSparkReproV10,
  createSparkReproV10,
  currentSparkReproCheckpoint,
  migrateSparkSessionReproV9,
} from "./v10.ts";

const roles = {
  implementation: "role:spark-repro-implementation",
  exactness: "role:spark-repro-exactness",
  formalize: "role:spark-repro-formalize",
} as const;
const models = {
  implementation: { provider: "test", model: "deterministic", thinkingLevel: "high" },
  exactness: { provider: "test", model: "deterministic", thinkingLevel: "high" },
  formalize: { provider: "test", model: "deterministic", thinkingLevel: "high" },
} as const;

function create() {
  return createSparkReproV10({
    reproId: "repro:test",
    ownerSessionId: "session:root",
    workspaceId: "workspace:test",
    objective: "Reproduce the target behavior",
    laneRoles: roles,
    laneModels: models,
    now: "2026-08-19T00:00:00.000Z",
  });
}

function runCurrent(state: ReturnType<typeof create>, suffix: string) {
  const checkpoint = currentSparkReproCheckpoint(state)!;
  return bindSparkReproCheckpointRun(state, {
    checkpointId: checkpoint.checkpointId,
    runRef: `run:${suffix}`,
    now: "2026-08-19T00:01:00.000Z",
  });
}

function result(state: ReturnType<typeof create>, suffix: string) {
  const checkpoint = currentSparkReproCheckpoint(state)!;
  return {
    schema: "spark.repro.lane-result/v2",
    kind: "checkpoint_result",
    reproId: state.reproId,
    checkpointId: checkpoint.checkpointId,
    ...(checkpoint.sourceCheckpointId ? { sourceCheckpointId: checkpoint.sourceCheckpointId } : {}),
    ...(checkpoint.parentCheckpointId ? { parentCheckpointId: checkpoint.parentCheckpointId } : {}),
    sessionId: checkpoint.sessionId,
    taskRef: checkpoint.taskRef,
    runRef: `run:${suffix}`,
    lane: checkpoint.lane,
    checkpoint: checkpoint.kind,
    summary: `${checkpoint.kind} passed`,
    evidenceRefs: [`evidence:${suffix}`],
    ...(checkpoint.kind === "formalize" ? { formalizedRevision: "commit:canonical" } : {}),
  };
}

describe("SparkSessionRepro v10", () => {
  it("creates three stable lane Sessions and five ordered checkpoints", () => {
    const repro = create();
    expect(new Set(Object.values(repro.lanes).map((lane) => lane.sessionId))).toHaveLength(3);
    expect(repro.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual([
      "implementation",
      "exactness",
      "formalize",
      "exactness_refresh",
      "implementation_refresh",
    ]);
    expect(repro.checkpoints[0]?.sessionId).toBe(repro.checkpoints[4]?.sessionId);
    expect(repro.checkpoints[1]?.sessionId).toBe(repro.checkpoints[3]?.sessionId);
  });

  it("advances only through exact TaskRun provenance and makes Formalize authoritative", () => {
    let repro = activateSparkReproV10(create(), "2026-08-19T00:00:01.000Z");
    for (let index = 0; index < 5; index += 1) {
      const suffix = String(index + 1);
      repro = runCurrent(repro, suffix);
      expect(() =>
        acceptSparkReproLaneResult(
          repro,
          { ...result(repro, suffix), sessionId: "session:foreign" },
          "2026-08-19T00:02:00.000Z",
        ),
      ).toThrow(/provenance/u);
      repro = acceptSparkReproLaneResult(
        repro,
        result(repro, suffix),
        `2026-08-19T00:0${index + 2}:00.000Z`,
      );
      if (index < 2) expect(repro.formalizedRevision).toBeUndefined();
    }
    expect(repro.status).toBe("complete");
    expect(repro.formalizedRevision).toBe("commit:canonical");
    expect(repro.receipts).toHaveLength(5);
  });

  it("keeps attention on one checkpoint and reuses its lane Session", () => {
    let repro = runCurrent(
      activateSparkReproV10(create(), "2026-08-19T00:00:01.000Z"),
      "attention",
    );
    const checkpoint = currentSparkReproCheckpoint(repro)!;
    const laneSessionId = checkpoint.sessionId;
    const { summary: _summary, ...attentionBinding } = result(repro, "attention");
    repro = acceptSparkReproLaneResult(
      repro,
      {
        ...attentionBinding,
        kind: "attention_request",
        decisionKey: "decision:reference",
        question: "Which reference is authoritative?",
        reason: "The workspace contains two candidates.",
        expectedAnswerKind: "single",
      },
      "2026-08-19T00:02:00.000Z",
    );
    repro = answerSparkReproAttention(repro, {
      checkpointId: checkpoint.checkpointId,
      answerEvidenceRef: "evidence:answer",
      answerKind: "single",
      now: "2026-08-19T00:03:00.000Z",
    });
    expect(currentSparkReproCheckpoint(repro)).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      sessionId: laneSessionId,
      status: "pending",
      attempt: 1,
    });
  });

  it("migrates only v9 and blocks unverifiable history without guessing", () => {
    const migrated = migrateSparkSessionReproV9(
      { version: 9, reproId: "repro:legacy", goalContract: { objective: "Legacy target" } },
      {
        ownerSessionId: "session:root",
        workspaceId: "workspace:test",
        laneRoles: roles,
        laneModels: models,
        now: "2026-08-19T00:00:00.000Z",
      },
    );
    expect(migrated).toMatchObject({ version: 10, status: "blocked" });
    expect(() =>
      migrateSparkSessionReproV9(
        { version: 8 },
        {
          ownerSessionId: "session:root",
          workspaceId: "workspace:test",
          laneRoles: roles,
          laneModels: models,
          now: "2026-08-19T00:00:00.000Z",
        },
      ),
    ).toThrow(/only SparkSessionRepro v9/u);
  });

  it("blocks one invalid terminal attempt without changing accepted receipts", () => {
    const active = activateSparkReproV10(create(), "2026-08-19T00:00:01.000Z");
    const blocked = blockSparkReproV10(
      active,
      "terminal TaskRun had no bound lane result",
      "2026-08-19T00:01:00.000Z",
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      blockingReason: "terminal TaskRun had no bound lane result",
      receipts: [],
    });
    expect(
      blockSparkReproV10(
        blocked,
        "terminal TaskRun had no bound lane result",
        "2026-08-19T00:02:00.000Z",
      ),
    ).toBe(blocked);
  });
});
