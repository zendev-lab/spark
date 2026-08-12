import { describe, expect, it } from "vitest";
import { createId } from "../refs.ts";
import { runtimeProtocolVersion } from "./envelope.ts";
import {
  humanQuestionOptionSchema,
  humanRequestCreatedPayloadSchema,
  humanResponseRecordedEnvelopeSchema,
  maxRuntimeCommandPayloadBytes,
  runtimeCommandResultEnvelopeSchema,
  runtimeMessageEnvelopeSchema,
  serverHeartbeatAckEnvelopeSchema,
  serverCommandEnvelopeSchema,
} from "./messages.ts";

function recordedChannelResponse() {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "human.response.recorded" as const,
    sentAt: "2026-07-14T00:00:00.000Z",
    runtimeId: createId("rt"),
    workspaceBindingId: createId("rtwb"),
    workspaceId: createId("ws"),
    humanRequestId: createId("hreq"),
    humanResponseId: createId("hres"),
    payload: {
      source: "channel" as const,
      status: "answered" as const,
      answers: { scope: "mvp" },
      responseArtifactRefs: [],
    },
  };
}

describe("typed runtime control messages", () => {
  it("parses bound and unbound workspace assignments from heartbeat acknowledgements", () => {
    const bound = createId("rtwb");
    const unbound = createId("rtwb");
    const parsed = serverHeartbeatAckEnvelopeSchema.parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "server.heartbeat_ack",
      sentAt: "2026-07-20T00:00:00.000Z",
      payload: {
        runtimeSessionId: createId("rtsn"),
        sequence: 1,
        serverTime: "2026-07-20T00:00:00.000Z",
        workspaceBindingAssignments: [
          { bindingId: bound, state: "bound", workspaceId: createId("ws") },
          { bindingId: unbound, state: "unbound" },
        ],
      },
    });

    expect(parsed.payload.workspaceBindingAssignments.map(({ state }) => state)).toEqual([
      "bound",
      "unbound",
    ]);
  });

  const base = {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.command" as const,
    sentAt: "2026-07-15T00:00:00.000Z",
    runtimeId: createId("rt"),
    commandId: createId("cmd"),
  };

  it("parses explicit daemon and workspace command scopes", () => {
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        payload: { kind: "daemon.status.request", scope: "daemon" },
      }).success,
    ).toBe(true);
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: { kind: "workspace.snapshot.request", scope: "workspace" },
      }).success,
    ).toBe(true);
  });

  it("accepts explicit daemon and workspace session scopes with session routing", () => {
    const sessionId = "sess_runtime_control";
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        sessionId,
        payload: {
          kind: "session.get.request",
          scope: "daemon",
          payload: { sessionId },
        },
      }).success,
    ).toBe(true);
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        sessionId,
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: {
          kind: "turn.submit.request",
          scope: "workspace",
          payload: { sessionId, prompt: "continue" },
        },
      }).success,
    ).toBe(true);
  });

  it("reports every missing workspace route at the envelope field", () => {
    const parsed = serverCommandEnvelopeSchema.safeParse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "server.command",
      sentAt: "2026-07-15T00:00:00.000Z",
      payload: { kind: "workspace.snapshot.request", scope: "workspace" },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["runtimeId"],
          message: "server.command requires runtimeId",
        }),
        expect.objectContaining({
          path: ["commandId"],
          message: "server.command requires commandId",
        }),
        expect.objectContaining({
          path: ["workspaceBindingId"],
          message: "server.command requires workspaceBindingId",
        }),
        expect.objectContaining({
          path: ["workspaceId"],
          message: "server.command requires workspaceId",
        }),
      ]),
    );
  });

  it("rejects scope spoofing, unknown routes, secret payloads, RPC tunnels, and oversize input", () => {
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        payload: { kind: "daemon.status.request", scope: "workspace" },
      }).success,
    ).toBe(false);
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        runtimeId: createId("rt"),
        workspaceBindingId: createId("rtwb"),
        workspaceId: createId("ws"),
        payload: { kind: "daemon.status.request", scope: "daemon" },
      }).success,
    ).toBe(false);
    for (const payload of [
      { apiKey: "must-not-cross" },
      { nested: { refresh_token: "must-not-cross" } },
      { method: "daemon.status", params: {} },
      { content: "x".repeat(maxRuntimeCommandPayloadBytes + 1) },
    ]) {
      expect(
        serverCommandEnvelopeSchema.safeParse({
          ...base,
          payload: { kind: "daemon.status.request", scope: "daemon", payload },
        }).success,
      ).toBe(false);
    }
  });

  it("measures the command payload limit in encoded JSON bytes", () => {
    expect(
      serverCommandEnvelopeSchema.safeParse({
        ...base,
        payload: {
          kind: "daemon.status.request",
          scope: "daemon",
          payload: { content: "x".repeat(maxRuntimeCommandPayloadBytes / 2) },
        },
      }).success,
    ).toBe(true);

    const parsed = serverCommandEnvelopeSchema.safeParse({
      ...base,
      payload: {
        kind: "daemon.status.request",
        scope: "daemon",
        payload: { content: "界".repeat(maxRuntimeCommandPayloadBytes / 2) },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual([
      expect.objectContaining({
        path: ["payload", "payload"],
        message: `Payload exceeds ${maxRuntimeCommandPayloadBytes} bytes`,
      }),
    ]);
  });

  it("parses one bounded terminal result and rejects secret or oversize results", () => {
    const result = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "runtime.command.result" as const,
      sentAt: "2026-07-15T00:00:01.000Z",
      runtimeId: base.runtimeId,
      commandId: base.commandId,
      ackOf: base.messageId,
      payload: {
        status: "succeeded" as const,
        result: { invocations: { running: 0 } },
        projection: { kind: "daemon.status" as const, data: { online: true } },
        completedAt: "2026-07-15T00:00:01.000Z",
      },
    };
    expect(runtimeCommandResultEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(runtimeMessageEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({ ...result, runtimeId: undefined }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({ ...result, commandId: undefined }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({
        ...result,
        payload: { ...result.payload, result: { accessToken: "must-not-cross" } },
      }).success,
    ).toBe(false);
    expect(
      runtimeCommandResultEnvelopeSchema.safeParse({
        ...result,
        payload: { ...result.payload, result: { content: "x".repeat(65_536) } },
      }).success,
    ).toBe(false);
  });
});

describe("runtime human response messages", () => {
  it("accepts a routed channel response as an already-recorded runtime fact", () => {
    const envelope = recordedChannelResponse();

    expect(humanResponseRecordedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(runtimeMessageEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("accepts a daemon-originated cancellation as an already-recorded runtime fact", () => {
    const envelope = recordedChannelResponse();
    expect(
      humanResponseRecordedEnvelopeSchema.parse({
        ...envelope,
        payload: {
          ...envelope.payload,
          source: "daemon",
          status: "cancelled",
          answers: {},
        },
      }).payload,
    ).toMatchObject({ source: "daemon", status: "cancelled" });
  });

  it("rejects non-channel sources for runtime-recorded responses", () => {
    const envelope = recordedChannelResponse();

    expect(
      humanResponseRecordedEnvelopeSchema.safeParse({
        ...envelope,
        payload: { ...envelope.payload, source: "hub" },
      }).success,
    ).toBe(false);
  });
});

describe("human question option identity", () => {
  it("preserves one revision-fenced evidence request binding across runtime projection", () => {
    const evidenceRequest = {
      schema: "spark.evidence-request/v1" as const,
      askRef: "ask:publish",
      ownerSessionId: "session:owner",
      goalOrReproId: "goal:release",
      modeScope: "goal" as const,
      planRevision: 3,
      ownerStepOrUnresolvedId: "unresolved:publish",
      stepDefinitionDigest: "publish-definition",
      requestHash: "b".repeat(64),
      ownerQuestionId: "approval",
      expectedAnswerKind: "approval" as const,
    };
    const parsed = humanRequestCreatedPayloadSchema.parse({
      kind: "ask_user",
      delivery: "async",
      interactionRequestId: "interaction-publish",
      evidenceRequest,
      title: "Publish?",
      prompt: "Approve publication?",
      questions: [
        {
          id: "approval",
          type: "single",
          prompt: "Approve?",
          options: [{ value: "approve", label: "Approve" }],
        },
      ],
    });

    expect(parsed.evidenceRequest).toEqual(evidenceRequest);
    expect(
      humanRequestCreatedPayloadSchema.safeParse({
        ...parsed,
        evidenceRequest: { ...evidenceRequest, planRevision: 0 },
      }).success,
    ).toBe(false);
  });

  it("normalizes canonical value and legacy id to the ask option value field", () => {
    expect(humanQuestionOptionSchema.parse({ value: "mvp", label: "MVP" })).toEqual({
      value: "mvp",
      label: "MVP",
    });
    expect(humanQuestionOptionSchema.parse({ id: "legacy", label: "Legacy" })).toEqual({
      value: "legacy",
      label: "Legacy",
    });
    expect(
      humanRequestCreatedPayloadSchema.parse({
        kind: "ask_user",
        title: "Scope",
        prompt: "Pick a scope",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            options: [{ id: "mvp", label: "MVP" }],
          },
        ],
      }).questions[0]?.options,
    ).toEqual([{ value: "mvp", label: "MVP" }]);
  });
});
