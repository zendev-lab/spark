import { describe, expect, it } from "vitest";

import {
  createAutonomousAskInteractionRequestId,
  matchesAutonomousAskInteractionRequestId,
  parseSparkHumanWaitRespondent,
  sparkDirectAnswerProvenanceSchema,
  sparkEvidenceAnswerEventSchema,
} from "./human-interaction.ts";

describe("autonomous Ask interaction identity", () => {
  it("derives a stable protocol wire id from the evidence request hash", () => {
    const requestHash = `${"a".repeat(32)}${"b".repeat(32)}`;

    expect(createAutonomousAskInteractionRequestId(requestHash)).toBe(`ask_${"a".repeat(32)}`);
    expect(matchesAutonomousAskInteractionRequestId(`ask_${"a".repeat(32)}`, requestHash)).toBe(
      true,
    );
  });

  it("accepts the retired autonomous id only as a compatibility read", () => {
    const requestHash = "c".repeat(64);

    expect(matchesAutonomousAskInteractionRequestId(`ask_async:${requestHash}`, requestHash)).toBe(
      true,
    );
    expect(matchesAutonomousAskInteractionRequestId(`ask_${"d".repeat(32)}`, requestHash)).toBe(
      false,
    );
    expect(matchesAutonomousAskInteractionRequestId("ask_invalid", "not-a-hash")).toBe(false);
    expect(() => createAutonomousAskInteractionRequestId("not-a-hash")).toThrow(/SHA-256/u);
  });
});

describe("human wait respondent and provenance", () => {
  it("defaults missing respondent rows to user", () => {
    expect(parseSparkHumanWaitRespondent(undefined)).toEqual({ kind: "user" });
    expect(parseSparkHumanWaitRespondent({ kind: "user" })).toEqual({ kind: "user" });
    expect(parseSparkHumanWaitRespondent({ kind: "session", sessionId: "sess_b" })).toEqual({
      kind: "session",
      sessionId: "sess_b",
    });
  });

  it("accepts session provenance without minting an EvidenceAnswerEvent", () => {
    expect(sparkDirectAnswerProvenanceSchema.parse("session")).toBe("session");
    expect(
      sparkEvidenceAnswerEventSchema.safeParse({
        schema: "spark.evidence-answer-event/v1",
        answerEventId: "answer-event:1",
        humanRequestId: "hreq_1",
        interactionRequestId: "ask_1",
        humanResponseId: "hres_1",
        provenance: "session",
        binding: {
          schema: "spark.evidence-request/v1",
          askRef: `ask:${"a".repeat(64)}`,
          ownerSessionId: "sess_a",
          goalOrReproId: "goal_1",
          modeScope: "goal",
          planRevision: 1,
          ownerStepOrUnresolvedId: "step_1",
          stepDefinitionDigest: "d".repeat(64),
          requestHash: "a".repeat(64),
          ownerQuestionId: "q1",
          expectedAnswerKind: "single",
        },
        answers: { q1: { values: ["yes"] } },
        acceptedAt: "2026-08-17T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
