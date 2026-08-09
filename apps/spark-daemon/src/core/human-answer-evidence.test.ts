import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { describe, expect, it, vi } from "vitest";

import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { SparkLoopStore } from "../store/loops.ts";
import { SparkDaemonHumanWaitRegistry } from "./human-waits.ts";
import {
  projectHumanAnswerEventEvidence,
  reconcileHumanAnswerEventEvidence,
  wakeHumanAnswerEvidenceOwner,
} from "./human-answer-evidence.ts";

describe("human AnswerEvent Evidence projection", () => {
  it("projects one deterministic Evidence record across replay and restart", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-answer-event-evidence-"));
    const event = {
      schema: "spark.evidence-answer-event/v1" as const,
      answerEventId: `answer-event:${"a".repeat(64)}`,
      humanRequestId: "hreq-answer",
      interactionRequestId: `ask_async:${"b".repeat(64)}`,
      humanResponseId: "hres-answer",
      provenance: "direct_user" as const,
      binding: {
        schema: "spark.evidence-request/v1" as const,
        askRef: `ask:${"b".repeat(64)}`,
        ownerSessionId: "session:owner",
        goalOrReproId: "repro:glm52",
        modeScope: "repro" as const,
        planRevision: 3,
        ownerStepOrUnresolvedId: "step:reference",
        stepDefinitionDigest: "reference-digest",
        requestHash: "b".repeat(64),
        ownerQuestionId: "reference",
        expectedAnswerKind: "single" as const,
      },
      answers: { reference: { questionId: "reference", values: ["official"] } },
      acceptedAt: "2026-08-07T00:00:00.000Z",
    };
    try {
      const first = await projectHumanAnswerEventEvidence(cwd, event);
      const replayed = await projectHumanAnswerEventEvidence(cwd, event);
      expect(first.ref).toBe(`evidence:${event.answerEventId}`);
      expect(replayed).toEqual(first);
      expect(await defaultEvidenceStore(cwd).get(first.ref)).toMatchObject({
        ref: first.ref,
        provenance: { producer: "ask" },
        body: event,
        links: [{ to: `ask:${"b".repeat(64)}`, relation: "answer-to" }],
      });
      expect(await defaultEvidenceStore(cwd).list({ producer: "ask" })).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reconciles a durable AnswerEvent into exactly one Evidence record after restart", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-answer-event-restart-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const binding = {
      schema: "spark.evidence-request/v1" as const,
      askRef: `ask:${"c".repeat(64)}`,
      ownerSessionId: "session:owner",
      goalOrReproId: "goal:restart",
      modeScope: "goal" as const,
      planRevision: 2,
      ownerStepOrUnresolvedId: "unresolved:restart",
      stepDefinitionDigest: "restart-digest",
      requestHash: "c".repeat(64),
      ownerQuestionId: "decision",
      expectedAnswerKind: "single" as const,
    };
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq-restart",
        interactionRequestId: `ask_async:${binding.requestHash}`,
        sessionId: "session:owner",
        workspaceBindingId: "binding-restart",
        workspaceId: "workspace-restart",
        delivery: "async",
        evidenceRequest: binding,
        kind: "ask_user",
        title: "Choose",
        prompt: "Continue?",
        questions: [
          {
            id: "decision",
            type: "single",
            prompt: "Continue?",
            required: true,
            options: [{ value: "continue", label: "Continue" }],
          },
        ],
      });
      waits.deliver({
        humanRequestId: "hreq-restart",
        humanResponseId: "hres-restart",
        status: "answered",
        provenance: "direct_user",
        answers: { decision: "continue" },
      });

      const projectionError = vi.fn();
      const crashed = await reconcileHumanAnswerEventEvidence(
        waits,
        () => cwd,
        projectionError,
        () => {
          throw new Error("simulated crash after Evidence before wake ack");
        },
      );
      expect(crashed).toEqual({ projected: 0, existing: 0, skipped: 0, failed: 1 });
      expect(projectionError).toHaveBeenCalledTimes(1);
      expect(waits.listPendingEvidenceAnswerEvents()).toHaveLength(1);
      expect(await defaultEvidenceStore(cwd).list({ producer: "ask" })).toHaveLength(1);

      const deferred = await reconcileHumanAnswerEventEvidence(
        waits,
        () => cwd,
        () => undefined,
        () => false,
      );
      expect(deferred).toEqual({ projected: 0, existing: 0, skipped: 1, failed: 0 });
      expect(waits.listPendingEvidenceAnswerEvents()).toHaveLength(1);

      const projected = vi.fn(async () => true);
      const restarted = new SparkDaemonHumanWaitRegistry(db);
      const recovered = await reconcileHumanAnswerEventEvidence(
        restarted,
        () => cwd,
        () => undefined,
        projected,
      );
      const replay = await reconcileHumanAnswerEventEvidence(
        restarted,
        () => cwd,
        () => undefined,
        projected,
      );

      expect(recovered).toEqual({ projected: 0, existing: 1, skipped: 0, failed: 0 });
      expect(replay).toEqual({ projected: 0, existing: 0, skipped: 0, failed: 0 });
      expect(projected).toHaveBeenCalledTimes(1);
      expect(restarted.listPendingEvidenceAnswerEvents()).toEqual([]);
      expect(restarted.listEvidenceAnswerEvents()).toHaveLength(1);
      expect(await defaultEvidenceStore(cwd).list({ producer: "ask" })).toHaveLength(1);
    } finally {
      db.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not invoke a competing wake action after a durable claim is acquired", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    loops.start({
      loopId: "loop-atomic",
      ownerSessionId: "session:atomic",
      cwd: "/workspace",
      prompt: "continue",
      binding: { reproId: "repro:atomic" },
    });
    db.prepare("UPDATE loop_wakeups SET status = 'dormant', due_at = NULL WHERE loop_id = ?").run(
      "loop-atomic",
    );
    const requestHash = "f".repeat(64);
    const binding = {
      schema: "spark.evidence-request/v1" as const,
      askRef: `ask:${requestHash}`,
      ownerSessionId: "session:atomic",
      goalOrReproId: "repro:atomic",
      modeScope: "repro" as const,
      planRevision: 1,
      ownerStepOrUnresolvedId: "step:atomic",
      stepDefinitionDigest: "atomic-digest",
      requestHash,
      ownerQuestionId: "decision",
      expectedAnswerKind: "single" as const,
    };
    const waits = new SparkDaemonHumanWaitRegistry(db);
    waits.register({
      humanRequestId: "hreq-atomic",
      interactionRequestId: `ask_async:${requestHash}`,
      sessionId: "session:atomic",
      delivery: "async",
      evidenceRequest: binding,
      kind: "ask_user",
      title: "Continue",
      prompt: "Continue?",
      questions: [
        {
          id: "decision",
          type: "single",
          prompt: "Continue?",
          required: true,
          options: [{ value: "continue", label: "Continue" }],
        },
      ],
    });
    const delivered = waits.deliver({
      humanRequestId: "hreq-atomic",
      humanResponseId: "hres-atomic",
      status: "answered",
      provenance: "direct_user",
      answers: { decision: "continue" },
    });
    if (!delivered.answerEvent) throw new Error("missing accepted AnswerEvent");
    const first = wakeHumanAnswerEvidenceOwner(loops, delivered.answerEvent, waits);
    const second = wakeHumanAnswerEvidenceOwner(loops, delivered.answerEvent, waits);

    expect(first.woken).toHaveLength(1);
    expect(first.completed).toBe(true);
    expect(second.woken).toHaveLength(0);
    expect(second.completed).toBe(true);
    expect(waits.getEvidenceAnswerEventWakeClaim(delivered.answerEvent.answerEventId)).toEqual({
      loopId: "loop-atomic",
      generation: 2,
    });
    expect(loops.require("loop-atomic").generation).toBe(2);
  });

  it("wakes only the dormant Goal/Repro loop bound to the accepted answer", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const start = (loopId: string, reproId: string, ownerSessionId: string) => {
      loops.start({
        loopId,
        ownerSessionId,
        cwd: "/workspace",
        prompt: "continue",
        binding: { reproId },
      });
      db.prepare("UPDATE loop_wakeups SET status = 'dormant', due_at = NULL WHERE loop_id = ?").run(
        loopId,
      );
    };
    try {
      start("loop-matching", "repro:glm52", "session:owner");
      start("loop-other", "repro:other", "session:other");
      const requestHash = "e".repeat(64);
      const binding = {
        schema: "spark.evidence-request/v1" as const,
        askRef: `ask:${requestHash}`,
        ownerSessionId: "session:owner",
        goalOrReproId: "repro:glm52",
        modeScope: "repro" as const,
        planRevision: 3,
        ownerStepOrUnresolvedId: "step:decision",
        stepDefinitionDigest: "wake-digest",
        requestHash,
        ownerQuestionId: "decision",
        expectedAnswerKind: "single" as const,
      };
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq-wake",
        interactionRequestId: `ask_async:${requestHash}`,
        sessionId: "session:owner",
        delivery: "async",
        evidenceRequest: binding,
        kind: "ask_user",
        title: "Continue",
        prompt: "Continue?",
        questions: [
          {
            id: "decision",
            type: "single",
            prompt: "Continue?",
            required: true,
            options: [{ value: "continue", label: "Continue" }],
          },
        ],
      });
      const delivered = waits.deliver({
        humanRequestId: "hreq-wake",
        humanResponseId: "hres-wake",
        status: "answered",
        provenance: "direct_user",
        answers: { decision: "continue" },
      });
      if (!delivered.answerEvent) throw new Error("missing accepted AnswerEvent");
      const awakenedEvent = delivered.answerEvent;
      const awakened = wakeHumanAnswerEvidenceOwner(loops, awakenedEvent, waits);

      expect(awakened.woken).toHaveLength(1);
      expect(awakened.completed).toBe(true);
      expect(loops.require("loop-matching")).toMatchObject({
        status: "scheduled",
        reason: `direct-user AnswerEvent ${awakenedEvent.answerEventId} accepted for step:decision`,
      });
      expect(waits.getEvidenceAnswerEventWakeClaim(awakenedEvent.answerEventId)).toEqual({
        loopId: "loop-matching",
        generation: awakened.woken[0]?.generation,
      });
      expect(loops.require("loop-other").status).toBe("dormant");
      expect(wakeHumanAnswerEvidenceOwner(loops, awakenedEvent, waits)).toMatchObject({
        woken: [],
        completed: true,
      });
    } finally {
      db.close();
    }
  });
});
