import { describe, expect, it } from "vitest";

import { parsePendingHumanInteractions } from "./pending-human-interactions.ts";

function listedWithQuestions(questions: unknown[]) {
  return {
    waits: [
      {
        humanRequestId: "hreq-1",
        interactionRequestId: "interaction-1",
        sessionId: "session-1",
        invocationId: "invocation-1",
        workspaceBindingId: "",
        workspaceId: "",
        projectId: "",
        toolCallId: "tool-1",
        delivery: "blocking" as const,
        mode: "decision" as const,
        kind: "ask_user",
        title: "Decision",
        prompt: "Choose",
        questions,
        context: {},
        contextArtifactRefs: [],
        respondent: { kind: "user" as const },
        status: "pending" as const,
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
    ],
  };
}

describe("pending human interaction projection", () => {
  it("preserves typed mode, defaults, and questions", () => {
    expect(
      parsePendingHumanInteractions(
        listedWithQuestions([
          {
            id: "lane",
            prompt: "Lane",
            type: "single",
            required: true,
            defaultValues: ["safe"],
            options: [{ value: "safe", label: "Safe" }],
          },
        ]),
      ),
    ).toMatchObject([
      {
        mode: "decision",
        questions: [{ id: "lane", defaultValues: ["safe"] }],
      },
    ]);
  });

  it.each([
    ["empty", []],
    ["malformed", [{ id: "", prompt: "Broken" }]],
  ])("rejects %s owner question collections", (_label, questions) => {
    expect(() => parsePendingHumanInteractions(listedWithQuestions(questions))).toThrow();
  });
});
