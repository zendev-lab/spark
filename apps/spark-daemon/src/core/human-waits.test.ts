import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { addWorkspace } from "../store/workspaces.ts";
import {
  SparkDaemonHumanWaitRegistry,
  SparkDaemonHumanWaitLookupError,
  type SparkDaemonHumanWaitDelivery,
  type SparkDaemonHumanWaitInput,
} from "./human-waits.ts";

function createHarness(): { db: DatabaseSync; waits: SparkDaemonHumanWaitRegistry } {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  return { db, waits: new SparkDaemonHumanWaitRegistry(db) };
}

function waitInput(
  humanRequestId: string,
  delivery: SparkDaemonHumanWaitDelivery = "async",
  context: Record<string, unknown> = {},
): SparkDaemonHumanWaitInput {
  return {
    humanRequestId,
    interactionRequestId: `interaction-${humanRequestId}`,
    sessionId: "session-1",
    invocationId: "invocation-1",
    workspaceBindingId: "binding-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    toolCallId: "tool-call-1",
    delivery,
    kind: "ask_user",
    title: "Choose",
    prompt: "Continue?",
    context,
  };
}

describe("SparkDaemonHumanWaitRegistry", () => {
  it("requires a unique pending interaction and supports session or invocation disambiguation", () => {
    const { db, waits } = createHarness();
    try {
      waits.register({
        ...waitInput("hreq-interaction-a"),
        interactionRequestId: "interaction-shared",
        sessionId: "session-a",
        invocationId: "invocation-a",
      });
      waits.register({
        ...waitInput("hreq-interaction-b"),
        interactionRequestId: "interaction-shared",
        sessionId: "session-b",
        invocationId: "invocation-b",
      });

      expect(() =>
        waits.requireUniquePendingInteraction({ interactionRequestId: "interaction-shared" }),
      ).toThrowError(
        new SparkDaemonHumanWaitLookupError(
          "human_interaction_ambiguous",
          "Multiple pending daemon-owned human interactions matched interaction-shared; include sessionId or invocationId.",
        ),
      );
      expect(
        waits.requireUniquePendingInteraction({
          interactionRequestId: "interaction-shared",
          sessionId: "session-a",
        }).humanRequestId,
      ).toBe("hreq-interaction-a");
      expect(
        waits.requireUniquePendingInteraction({
          interactionRequestId: "interaction-shared",
          invocationId: "invocation-b",
        }).humanRequestId,
      ).toBe("hreq-interaction-b");

      waits.deliver({
        humanRequestId: "hreq-interaction-a",
        status: "answered",
        answers: { decision: "continue" },
      });
      expect(
        waits.requireUniquePendingInteraction({ interactionRequestId: "interaction-shared" })
          .humanRequestId,
      ).toBe("hreq-interaction-b");

      expect(() =>
        waits.requireUniquePendingInteraction({ interactionRequestId: "interaction-missing" }),
      ).toThrowError(/No pending daemon-owned human interaction matched interaction-missing/u);
    } finally {
      db.close();
    }
  });

  it("filters before limiting so one Hub cannot starve another Hub's outbox", () => {
    const { db, waits } = createHarness();
    const runtimeA = "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runtimeB = "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const bindingA = "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bindingB = "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const serverA = "https://a.example.test/";
    const serverB = "https://b.example.test/";
    try {
      addWorkspace(db, {
        id: bindingA,
        serverUrl: serverA,
        localWorkspaceKey: "workspace-a",
        displayName: "Workspace A",
        localPath: "/workspace-a",
      });
      addWorkspace(db, {
        id: bindingB,
        serverUrl: serverB,
        localWorkspaceKey: "workspace-b",
        displayName: "Workspace B",
        localPath: "/workspace-b",
      });
      for (let index = 0; index < 100; index += 1) {
        const suffix = index.toString().padStart(3, "0");
        waits.register(
          {
            ...waitInput(`hreq-a-${suffix}`),
            workspaceBindingId: bindingA,
            workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          {
            messageId: `message-a-${suffix}`,
            kind: "human.request.created",
            envelope: {
              type: "human.request.created",
              runtimeId: runtimeA,
              workspaceBindingId: bindingA,
              workspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              humanRequestId: `hreq-a-${suffix}`,
            },
          },
        );
      }
      waits.register(
        {
          ...waitInput("hreq-b"),
          workspaceBindingId: bindingB,
          workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        {
          messageId: "message-b",
          kind: "human.request.created",
          envelope: {
            type: "human.request.created",
            runtimeId: runtimeB,
            workspaceBindingId: bindingB,
            workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            humanRequestId: "hreq-b",
          },
        },
      );

      expect(waits.listPendingOutboxForRoute({ runtimeId: runtimeB, serverUrl: serverB })).toEqual([
        expect.objectContaining({ messageId: "message-b" }),
      ]);
      expect(
        waits.acknowledgeOutboxForRoute("message-b", {
          runtimeId: runtimeA,
          serverUrl: serverA,
        }),
      ).toBe(false);
      expect(
        waits.acknowledgeOutboxForRoute("message-b", {
          runtimeId: runtimeB,
          serverUrl: serverB,
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("routes daemon-scoped outbox entries by runtime id", () => {
    const { db, waits } = createHarness();
    try {
      waits.register(
        { ...waitInput("hreq-daemon"), workspaceBindingId: "", workspaceId: "" },
        {
          messageId: "message-daemon",
          kind: "human.request.created",
          envelope: {
            type: "human.request.created",
            runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            humanRequestId: "hreq-daemon",
          },
        },
      );

      expect(
        waits.listPendingOutboxForRoute({
          runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          serverUrl: "https://b.example.test/",
        }),
      ).toEqual([]);
      expect(
        waits.listPendingOutboxForRoute({
          runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          serverUrl: null,
        }),
      ).toEqual([expect.objectContaining({ messageId: "message-daemon" })]);
      expect(
        waits.acknowledgeOutboxForRoute("message-daemon", {
          runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          serverUrl: null,
        }),
      ).toBe(false);
      expect(
        waits.acknowledgeOutboxForRoute("message-daemon", {
          runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          serverUrl: null,
        }),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("registers async asks without a suspended Promise and persists a pending outbox", () => {
    const { db, waits } = createHarness();
    try {
      const envelope = {
        type: "human.request.created",
        humanRequestId: "hreq-async",
        payload: { title: "Choose" },
      };
      const registration = waits.register(waitInput("hreq-async"), {
        messageId: "message-async",
        kind: "human.request.created",
        envelope,
      });

      expect("response" in registration).toBe(false);
      expect(registration.response).toBeUndefined();
      expect(registration.wait).toMatchObject({
        humanRequestId: "hreq-async",
        delivery: "async",
        status: "pending",
      });
      expect(waits.hasActive("hreq-async")).toBe(false);
      expect(waits.listPending()).toMatchObject([
        { humanRequestId: "hreq-async", status: "pending" },
      ]);
      expect(waits.listPendingOutbox()).toEqual([
        {
          messageId: "message-async",
          kind: "human.request.created",
          envelope,
        },
      ]);

      expect(waits.acknowledgeOutbox("message-async")).toBe(true);
      expect(waits.acknowledgeOutbox("message-async")).toBe(false);
      expect(waits.listPendingOutbox()).toEqual([]);
      expect(db.prepare("SELECT status FROM outbox WHERE id = ?").get("message-async")).toEqual({
        status: "acked",
      });
    } finally {
      db.close();
    }
  });

  it("rolls back the request row when the matching outbox insert fails", () => {
    const { db, waits } = createHarness();
    try {
      waits.register(waitInput("hreq-first"), {
        messageId: "duplicate-message",
        kind: "human.request.created",
        envelope: { request: "first" },
      });

      expect(() =>
        waits.register(waitInput("hreq-rolled-back"), {
          messageId: "duplicate-message",
          kind: "human.request.created",
          envelope: { request: "second" },
        }),
      ).toThrow();

      expect(waits.get("hreq-rolled-back")).toBeNull();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM daemon_human_waits WHERE human_request_id = ?")
          .get("hreq-rolled-back"),
      ).toEqual({ count: 0 });
      expect(waits.listPendingOutbox()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("uses a first-writer CAS and replays only the winning response id", () => {
    const { db, waits } = createHarness();
    try {
      waits.register(waitInput("hreq-race"));

      const accepted = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-winner",
        status: "answered",
        answers: { decision: "yes" },
      });
      const competing = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-loser",
        status: "answered",
        answers: { decision: "no" },
      });
      const replay = waits.deliver({
        humanRequestId: "hreq-race",
        humanResponseId: "response-winner",
        status: "answered",
        answers: { decision: "tampered" },
      });

      expect(accepted).toMatchObject({
        outcome: "accepted",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(competing).toMatchObject({
        outcome: "already_resolved",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(replay).toMatchObject({
        outcome: "replayed",
        returnedToTool: false,
        winnerResponseId: "response-winner",
        response: { answers: { decision: "yes" } },
      });
      expect(
        db
          .prepare(
            `SELECT status, accepted_response_id AS acceptedResponseId
             FROM daemon_human_waits WHERE human_request_id = ?`,
          )
          .get("hreq-race"),
      ).toEqual({ status: "answered", acceptedResponseId: "response-winner" });
    } finally {
      db.close();
    }
  });

  it("persists a revision-fenced async binding and emits exactly one direct-user AnswerEvent", () => {
    const { db, waits } = createHarness();
    try {
      const evidenceRequest = {
        schema: "spark.evidence-request/v1" as const,
        askRef: `ask:${"c".repeat(64)}`,
        ownerSessionId: "session-1",
        goalOrReproId: "repro:glm52",
        modeScope: "repro" as const,
        planRevision: 7,
        ownerStepOrUnresolvedId: "step:topology",
        stepDefinitionDigest: "topology-digest",
        requestHash: "c".repeat(64),
        ownerQuestionId: "topology",
        expectedAnswerKind: "single" as const,
      };
      expect(() =>
        waits.register({
          ...waitInput("hreq-evidence-bad-identity"),
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          evidenceRequest: { ...evidenceRequest, askRef: "ask:forged" },
        }),
      ).toThrow(/canonical requestHash/u);
      expect(() =>
        waits.register({
          ...waitInput("hreq-evidence-blocking", "blocking"),
          evidenceRequest,
        }),
      ).toThrow(/requires async delivery and correlation/u);
      const firstRegistration = waits.register({
        ...waitInput("hreq-evidence"),
        interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
        questions: [
          {
            id: "topology",
            type: "single",
            prompt: "Topology?",
            required: true,
            options: [{ value: "tp2", label: "TP2" }],
          },
        ],
        evidenceRequest,
      });
      const repeatedRegistration = waits.register({
        ...waitInput("hreq-evidence-retry"),
        interactionRequestId: `ask_${evidenceRequest.requestHash.slice(0, 32)}`,
        evidenceRequest,
      });
      expect(firstRegistration.created).toBe(true);
      expect(repeatedRegistration).toMatchObject({
        created: false,
        wait: {
          humanRequestId: "hreq-evidence",
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          evidenceRequest,
        },
      });
      const restartedPending = new SparkDaemonHumanWaitRegistry(db);
      expect(restartedPending.get("hreq-evidence")).toMatchObject({
        humanRequestId: "hreq-evidence",
        status: "pending",
        evidenceRequest,
      });
      expect(restartedPending.listPending()).toEqual([
        expect.objectContaining({
          humanRequestId: "hreq-evidence",
          status: "pending",
          evidenceRequest,
        }),
      ]);
      expect(() =>
        waits.register({
          ...waitInput("hreq-evidence-conflict"),
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          evidenceRequest: { ...evidenceRequest, planRevision: 8 },
        }),
      ).toThrow(/retried with a different binding/u);

      const accepted = restartedPending.deliver({
        humanRequestId: "hreq-evidence",
        humanResponseId: "hres-evidence",
        status: "answered",
        provenance: "direct_user",
        answers: { topology: "tp2" },
      });
      const replayed = waits.deliver({
        humanRequestId: "hreq-evidence",
        humanResponseId: "hres-evidence",
        status: "answered",
        provenance: "direct_user",
        answers: { topology: "tampered" },
      });

      expect(accepted).toMatchObject({
        outcome: "accepted",
        returnedToTool: false,
        answerEvent: {
          schema: "spark.evidence-answer-event/v1",
          answerEventId: expect.stringMatching(/^answer-event:[a-f0-9]{64}$/u),
          humanRequestId: "hreq-evidence",
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          humanResponseId: "hres-evidence",
          provenance: "direct_user",
          binding: evidenceRequest,
          answers: { topology: { questionId: "topology", values: ["tp2"] } },
        },
      });
      expect(replayed).toMatchObject({
        outcome: "replayed",
        answerEvent: {
          answers: { topology: { questionId: "topology", values: ["tp2"] } },
        },
      });
      const restarted = new SparkDaemonHumanWaitRegistry(db);
      expect(restarted.listEvidenceAnswerEvents("hreq-evidence")).toEqual([accepted.answerEvent]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_human_waits").get()).toEqual({
        count: 1,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM daemon_human_answer_events").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });

  it("rejects side, unknown, invalid-option, and wrong-cardinality owner answers", () => {
    const { db, waits } = createHarness();
    const evidenceRequest = {
      schema: "spark.evidence-request/v1" as const,
      askRef: `ask:${"f".repeat(64)}`,
      ownerSessionId: "session-1",
      goalOrReproId: "repro:owner-question",
      modeScope: "repro" as const,
      planRevision: 3,
      ownerStepOrUnresolvedId: "step:owner-question",
      stepDefinitionDigest: "owner-question-digest",
      requestHash: "f".repeat(64),
      ownerQuestionId: "decision",
      expectedAnswerKind: "single" as const,
    };
    const questions = [
      {
        id: "decision",
        type: "single" as const,
        prompt: "Decision?",
        required: true,
        options: [
          { value: "continue", label: "Continue" },
          { value: "stop", label: "Stop" },
        ],
      },
      {
        id: "notes",
        type: "freeform" as const,
        prompt: "Notes?",
        required: false,
      },
    ];
    try {
      expect(() =>
        waits.register({
          ...waitInput("hreq-owner-mismatch"),
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          questions,
          evidenceRequest: { ...evidenceRequest, ownerQuestionId: "missing" },
        }),
      ).toThrow(/exactly one owner question/u);

      const invalidAnswers = [
        { notes: { customText: "side only" } },
        { unknown: "continue" },
        { decision: "invalid" },
        { decision: ["continue", "stop"] },
        { decision: "continue", unknown: "side" },
      ];
      invalidAnswers.forEach((answers, index) => {
        const humanRequestId = `hreq-owner-${index}`;
        const requestHash = index.toString(16).repeat(64);
        waits.register({
          ...waitInput(humanRequestId),
          interactionRequestId: `ask_async:${requestHash}`,
          questions,
          evidenceRequest: {
            ...evidenceRequest,
            askRef: `ask:${requestHash}`,
            requestHash,
          },
        });
        const delivered = waits.deliver({
          humanRequestId,
          humanResponseId: `hres-owner-${index}`,
          status: "answered",
          provenance: "direct_user",
          answers,
        });
        expect(delivered.answerEvent).toBeUndefined();
        expect(delivered.outcome).toBe("transient");
        expect(waits.get(humanRequestId)?.status).toBe("pending");
      });
      expect(waits.listEvidenceAnswerEvents()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps cancelled, archived, empty, and system answers out of AnswerEvent evidence", () => {
    const { db, waits } = createHarness();
    const evidenceRequest = {
      schema: "spark.evidence-request/v1" as const,
      askRef: `ask:${"d".repeat(64)}`,
      ownerSessionId: "session-1",
      goalOrReproId: "goal:release",
      modeScope: "goal" as const,
      planRevision: 2,
      ownerStepOrUnresolvedId: "unresolved:publish",
      stepDefinitionDigest: "publish-digest",
      requestHash: "d".repeat(64),
      ownerQuestionId: "approval",
      expectedAnswerKind: "approval" as const,
    };
    try {
      for (const [index, [suffix, status, provenance, answers]] of (
        [
          ["cancelled", "cancelled", "direct_user", {}],
          ["archived", "archived", "direct_user", { approval: "approve" }],
          ["empty", "answered", "direct_user", { approval: "  " }],
          ["system", "answered", "system", { approval: "approve" }],
          ["wrong-kind", "answered", "direct_user", { approval: ["approve", "reject"] }],
        ] as const
      ).entries()) {
        const humanRequestId = `hreq-${suffix}`;
        const requestHash = (index + 1).toString(16).repeat(64);
        waits.register({
          ...waitInput(humanRequestId),
          interactionRequestId: `ask_async:${requestHash}`,
          questions: [
            {
              id: "approval",
              type: "single",
              prompt: "Approve?",
              required: true,
              options: [
                { value: "approve", label: "Approve" },
                { value: "reject", label: "Reject" },
              ],
            },
          ],
          evidenceRequest: {
            ...evidenceRequest,
            askRef: `ask:${requestHash}`,
            requestHash,
          },
        });
        const delivered = waits.deliver({
          humanRequestId,
          humanResponseId: `hres-${suffix}`,
          status,
          provenance,
          answers,
        });
        if (status === "answered") {
          expect(delivered.outcome).toBe("transient");
          expect(waits.get(humanRequestId)?.status).toBe("pending");
        }
      }
      expect(waits.listEvidenceAnswerEvents()).toEqual([]);
      expect(
        waits.deliver({
          humanRequestId: "hreq-cancelled",
          humanResponseId: "hres-late",
          status: "answered",
          provenance: "direct_user",
          answers: { approval: "approve" },
        }),
      ).toMatchObject({ outcome: "already_resolved" });
      expect(waits.listEvidenceAnswerEvents()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("distinguishes an attached blocking continuation from an orphaned one", async () => {
    const { db, waits } = createHarness();
    try {
      const attached = waits.register(waitInput("hreq-attached", "blocking"));
      expect(attached.response).toBeDefined();
      expect(waits.hasActive("hreq-attached")).toBe(true);

      const attachedResult = waits.deliver({
        humanRequestId: "hreq-attached",
        humanResponseId: "response-attached",
        status: "answered",
        answers: { decision: "yes" },
      });
      await expect(attached.response).resolves.toMatchObject({
        humanResponseId: "response-attached",
        answers: { decision: "yes" },
      });
      expect(attachedResult).toMatchObject({
        outcome: "accepted",
        returnedToTool: true,
      });
      expect(waits.hasActive("hreq-attached")).toBe(false);

      waits.register(waitInput("hreq-orphaned", "blocking"));
      const restarted = new SparkDaemonHumanWaitRegistry(db);
      expect(restarted.hasActive("hreq-orphaned")).toBe(false);
      expect(
        restarted.deliver({
          humanRequestId: "hreq-orphaned",
          humanResponseId: "response-orphaned",
          status: "answered",
          answers: { decision: "yes" },
        }),
      ).toMatchObject({
        outcome: "orphaned",
        returnedToTool: false,
        winnerResponseId: "response-orphaned",
      });
      expect(restarted.get("hreq-orphaned")).toMatchObject({ status: "answered" });
    } finally {
      db.close();
    }
  });

  it("looks up opaque callback tokens without parsing their contents", () => {
    const { db, waits } = createHarness();
    try {
      const token = "opaque.token/with:+symbols==";
      waits.register(
        waitInput("hreq-callback", "async", {
          channelCallbacks: {
            [token]: {
              questionId: "decision",
              value: "continue",
              label: "Continue",
            },
            [`${token}-other`]: {
              questionId: "decision",
              value: "stop",
              label: "Stop",
            },
          },
        }),
      );

      expect(waits.findCallback(token)).toMatchObject({
        wait: { humanRequestId: "hreq-callback", status: "pending" },
        questionId: "decision",
        value: "continue",
        label: "Continue",
      });
      expect(waits.findCallback(`${token}.missing`)).toBeNull();
      expect(waits.findCallback("")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("defaults respondent to user and looks up pending session asks by respondent", () => {
    const { db, waits } = createHarness();
    try {
      expect(waits.register(waitInput("hreq-user")).wait.respondent).toEqual({ kind: "user" });
      waits.register({
        ...waitInput("hreq-session-older", "async"),
        humanRequestId: "hreq-session-older",
        sessionId: "sess_asker",
        respondent: { kind: "session", sessionId: "sess_target" },
      });
      waits.register({
        ...waitInput("hreq-session-newer", "async"),
        humanRequestId: "hreq-session-newer",
        sessionId: "sess_asker",
        respondent: { kind: "session", sessionId: "sess_target" },
      });
      waits.register({
        ...waitInput("hreq-other-session", "async"),
        humanRequestId: "hreq-other-session",
        respondent: { kind: "session", sessionId: "sess_other" },
      });

      expect(waits.findPendingAskForRespondentSession("sess_target")?.humanRequestId).toBe(
        "hreq-session-older",
      );
      expect(
        waits.requireUniquePendingInteraction({ humanRequestId: "hreq-session-newer" })
          .humanRequestId,
      ).toBe("hreq-session-newer");
      expect(waits.findPendingAskForRespondentSession("sess_missing")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("rejects a session-addressed wait that binds an EvidenceRequest", () => {
    const { db, waits } = createHarness();
    try {
      const evidenceRequest = {
        schema: "spark.evidence-request/v1" as const,
        askRef: `ask:${"d".repeat(64)}`,
        ownerSessionId: "session-1",
        goalOrReproId: "repro:session",
        modeScope: "repro" as const,
        planRevision: 1,
        ownerStepOrUnresolvedId: "step:decision",
        stepDefinitionDigest: "decision-digest",
        requestHash: "d".repeat(64),
        ownerQuestionId: "decision",
        expectedAnswerKind: "single" as const,
      };
      expect(() =>
        waits.register({
          ...waitInput("hreq-session-evidence"),
          interactionRequestId: `ask_async:${evidenceRequest.requestHash}`,
          questions: [
            {
              id: "decision",
              type: "single",
              prompt: "Decide?",
              required: true,
              options: [{ value: "yes", label: "Yes" }],
            },
          ],
          evidenceRequest,
          respondent: { kind: "session", sessionId: "sess_target" },
        }),
      ).toThrow(/cannot bind an EvidenceRequest/u);
    } finally {
      db.close();
    }
  });
});
