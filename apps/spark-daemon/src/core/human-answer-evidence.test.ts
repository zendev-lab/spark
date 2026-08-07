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
      interactionRequestId: "ask_async:request",
      humanResponseId: "hres-answer",
      provenance: "direct_user" as const,
      binding: {
        schema: "spark.evidence-request/v1" as const,
        askRef: "ask:request",
        ownerSessionId: "session:owner",
        goalOrReproId: "repro:glm52",
        modeScope: "repro" as const,
        planRevision: 3,
        ownerStepOrUnresolvedId: "step:reference",
        stepDefinitionDigest: "reference-digest",
        requestHash: "b".repeat(64),
        expectedAnswerKind: "single" as const,
      },
      answers: { reference: "official" },
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
        links: [{ to: "ask:request", relation: "answer-to" }],
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
      askRef: "ask:restart",
      ownerSessionId: "session:owner",
      goalOrReproId: "goal:restart",
      modeScope: "goal" as const,
      planRevision: 2,
      ownerStepOrUnresolvedId: "unresolved:restart",
      stepDefinitionDigest: "restart-digest",
      requestHash: "c".repeat(64),
      expectedAnswerKind: "single" as const,
    };
    try {
      const waits = new SparkDaemonHumanWaitRegistry(db);
      waits.register({
        humanRequestId: "hreq-restart",
        interactionRequestId: "ask_async:restart",
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

      const projected = vi.fn(async () => undefined);
      const first = await reconcileHumanAnswerEventEvidence(
        waits,
        () => cwd,
        () => undefined,
        projected,
      );
      const restarted = new SparkDaemonHumanWaitRegistry(db);
      const replay = await reconcileHumanAnswerEventEvidence(
        restarted,
        () => cwd,
        () => undefined,
        projected,
      );

      expect(first).toEqual({ projected: 1, existing: 0, skipped: 0, failed: 0 });
      expect(replay).toEqual({ projected: 0, existing: 1, skipped: 0, failed: 0 });
      expect(projected).toHaveBeenCalledTimes(1);
      expect(restarted.listEvidenceAnswerEvents()).toHaveLength(1);
      expect(await defaultEvidenceStore(cwd).list({ producer: "ask" })).toHaveLength(1);
    } finally {
      db.close();
      await rm(cwd, { recursive: true, force: true });
    }
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
      const awakenedEvent = {
        schema: "spark.evidence-answer-event/v1" as const,
        answerEventId: `answer-event:${"d".repeat(64)}`,
        humanRequestId: "hreq-wake",
        interactionRequestId: "ask_async:wake",
        humanResponseId: "hres-wake",
        provenance: "direct_user" as const,
        binding: {
          schema: "spark.evidence-request/v1" as const,
          askRef: "ask:wake",
          ownerSessionId: "session:owner",
          goalOrReproId: "repro:glm52",
          modeScope: "repro" as const,
          planRevision: 3,
          ownerStepOrUnresolvedId: "step:decision",
          stepDefinitionDigest: "wake-digest",
          requestHash: "e".repeat(64),
          expectedAnswerKind: "single" as const,
        },
        answers: { decision: "continue" },
        acceptedAt: "2026-08-07T00:00:00.000Z",
      };
      const awakened = wakeHumanAnswerEvidenceOwner(loops, awakenedEvent);

      expect(awakened).toHaveLength(1);
      expect(loops.require("loop-matching")).toMatchObject({
        status: "scheduled",
        reason: "direct-user AnswerEvent accepted for step:decision",
      });
      expect(loops.require("loop-other").status).toBe("dormant");
      expect(wakeHumanAnswerEvidenceOwner(loops, awakenedEvent)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
