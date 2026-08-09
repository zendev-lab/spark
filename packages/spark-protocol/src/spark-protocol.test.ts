import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  hasNonEmptySparkHumanAnswer,
  isTerminalSparkHumanInteractionDelivery,
  parseSparkDaemonEvent,
  parseSparkInteractionRequest,
  parseSparkInteractionResponse,
  parseSparkSessionView,
  sparkArtifactProjectionContentRefSchema,
  sparkRunViewSchema,
  sparkTaskViewSchema,
  parseSparkViewModelEvent,
  invocationLogChunkPayloadSchema,
  sparkInteractionRequestSchema,
} from "./index.ts";

const evidenceSurfaceNegativeValues = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../test/fixtures/evidence-surface/negative-values.json"),
    "utf8",
  ),
) as { wrongNamespaceRef: string; wrongArtifactNamespaceRef: string };

test("spark protocol validates core session/message/tool/run/task/artifact view models", () => {
  const session = parseSparkSessionView({
    sessionId: "native-session",
    status: "streaming",
    model: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
    messages: [
      { id: "m1", role: "user", text: "hello" },
      { id: "m2", role: "assistant", text: "hi", status: "streaming" },
    ],
    tools: [{ id: "tc1", name: "read", status: "running", input: { path: "README.md" } }],
    runs: [{ id: "run:1", kind: "task", status: "running", progress: 0.5 }],
    tasks: [{ ref: "task:1", title: "Implement", status: "running" }],
    artifacts: [{ ref: "evidence:1", title: "Evidence", kind: "record", format: "json" }],
  });

  assert.equal(session.version, SPARK_PROTOCOL_VERSION);
  assert.equal(session.messages[1]?.status, "streaming");
  assert.equal(session.tools[0]?.input && typeof session.tools[0].input, "object");
  assert.equal(session.runs[0]?.progress, 0.5);
});

test("run and task views keep Artifacts separate from internal Evidence", () => {
  assert.doesNotThrow(() =>
    sparkRunViewSchema.parse({
      id: "run:separated",
      kind: "task",
      status: "succeeded",
      evidenceRefs: ["evidence:proof"],
      artifactRefs: ["artifact:preview"],
    }),
  );
  assert.throws(
    () =>
      sparkRunViewSchema.parse({
        id: "run:mixed",
        kind: "task",
        status: "succeeded",
        evidenceRefs: [evidenceSurfaceNegativeValues.wrongNamespaceRef],
      }),
    /must be an evidence: ref/,
  );
  assert.throws(
    () =>
      sparkTaskViewSchema.parse({
        ref: "task:mixed",
        title: "Mixed",
        status: "running",
        artifactRefs: [evidenceSurfaceNegativeValues.wrongArtifactNamespaceRef],
      }),
    /must be an artifact: ref/,
  );
  assert.throws(
    () =>
      sparkArtifactProjectionContentRefSchema.parse({
        artifactRef: evidenceSurfaceNegativeValues.wrongArtifactNamespaceRef,
        inlineJson: {},
      }),
    /must be an artifact: ref/,
  );
  assert.throws(() =>
    sparkArtifactProjectionContentRefSchema.parse({
      artifactRef: "artifact:retired-media",
      mediaType: "application/vnd.spark-ui+json",
      revision: 1,
      progress: null,
    }),
  );
});

test("spark protocol centralizes human answer content and terminal delivery semantics", () => {
  assert.equal(hasNonEmptySparkHumanAnswer({ choice: { values: ["approve"] } }), true);
  assert.equal(hasNonEmptySparkHumanAnswer({ choice: { values: [], customText: "  " } }), false);
  assert.equal(isTerminalSparkHumanInteractionDelivery("accepted"), true);
  assert.equal(isTerminalSparkHumanInteractionDelivery("replayed"), true);
  assert.equal(isTerminalSparkHumanInteractionDelivery("transient"), false);
  assert.equal(isTerminalSparkHumanInteractionDelivery("unknown_request"), false);
});

test("spark protocol validates interaction requests and typed responses", () => {
  const ask = parseSparkInteractionRequest({
    requestId: "req-ask",
    kind: "askFlow",
    title: "Choose plan",
    mode: "decision",
    timeoutMs: 60 * 60_000,
    questions: [
      {
        id: "plan",
        prompt: "Which plan?",
        type: "single",
        options: [{ value: "a", label: "Plan A" }],
      },
    ],
  });
  assert.equal(ask.kind, "askFlow");
  assert.equal(ask.timeoutMs, 60 * 60_000);

  const evidenceBinding = {
    schema: "spark.evidence-request/v1" as const,
    askRef: "ask:req-async-evidence",
    ownerSessionId: "session:owner",
    goalOrReproId: "repro:glm52",
    modeScope: "repro" as const,
    planRevision: 7,
    ownerStepOrUnresolvedId: "step:numerical-boundary",
    stepDefinitionDigest: "step-digest",
    requestHash: "a".repeat(64),
    ownerQuestionId: "topology",
    expectedAnswerKind: "single" as const,
  };
  const asyncEvidence = parseSparkInteractionRequest({
    requestId: "req-async-evidence",
    kind: "askFlow",
    title: "Choose reference topology",
    delivery: "async",
    mode: "decision",
    evidenceRequest: evidenceBinding,
    questions: [
      {
        id: "topology",
        prompt: "Use topology A?",
        type: "single",
        options: [{ value: "a", label: "Topology A" }],
      },
    ],
  });
  assert.equal(asyncEvidence.kind, "askFlow");
  assert.deepEqual(asyncEvidence.evidenceRequest, evidenceBinding);
  assert.equal(
    sparkInteractionRequestSchema.safeParse({
      ...asyncEvidence,
      evidenceRequest: { ...evidenceBinding, askRef: undefined },
    }).success,
    false,
  );
  assert.equal(
    sparkInteractionRequestSchema.safeParse({
      ...asyncEvidence,
      evidenceRequest: { ...evidenceBinding, expectedAnswerKind: "unknown" },
    }).success,
    false,
  );
  assert.equal(
    sparkInteractionRequestSchema.safeParse({ ...asyncEvidence, delivery: "blocking" }).success,
    false,
  );

  const model = parseSparkInteractionRequest({
    requestId: "req-model",
    kind: "modelSelect",
    title: "Model",
    options: [
      {
        value: "baidu-oneapi/claude-opus-4.8",
        providerName: "baidu-oneapi",
        modelId: "claude-opus-4.8",
        active: true,
      },
    ],
  });
  assert.equal(model.kind, "modelSelect");

  const approval = parseSparkInteractionRequest({
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run tool?",
    toolName: "edit",
    arguments: { path: "src/index.ts" },
  });
  const blocked = createBlockedInteractionResponse(approval, "no UI available");
  assert.deepEqual(blocked, {
    version: SPARK_PROTOCOL_VERSION,
    kind: "toolApproval",
    requestId: "req-tool",
    status: "blocked",
    approved: false,
    message: "no UI available",
    metadata: {},
  });

  const response = parseSparkInteractionResponse({
    requestId: "req-model",
    kind: "modelSelect",
    status: "answered",
    selection: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
  });
  assert.equal(response.status, "answered");
});

test("spark protocol validates view model events", () => {
  const event = parseSparkViewModelEvent({
    type: "session.message",
    sessionId: "native-session",
    message: { id: "m1", role: "assistant", text: "stream", status: "streaming" },
  });

  assert.equal(event.version, SPARK_PROTOCOL_VERSION);
  assert.equal(event.type, "session.message");
});

test("spark protocol accepts assistant token invocation chunks", () => {
  const chunk = invocationLogChunkPayloadSchema.parse({
    runtimeInvocationId: "inv_0123456789abcdef0123456789abcdef",
    stream: "assistant",
    sequence: 7,
    content: "delta",
    metadata: { source: "stream_event", delta: true },
  });

  assert.equal(chunk.stream, "assistant");
  assert.equal(chunk.content, "delta");
  assert.deepEqual(chunk.metadata, { source: "stream_event", delta: true });
});

test("spark protocol validates daemon-routable view and interaction events", () => {
  const viewEvent = parseSparkDaemonEvent({
    type: "daemon.view_event",
    source: "daemon",
    sessionId: "session-daemon",
    invocationId: "inv:daemon",
    view: {
      type: "session.message",
      sessionId: "session-daemon",
      message: { id: "m1", role: "assistant", text: "hello", status: "done" },
    },
  });
  assert.equal(viewEvent.version, SPARK_PROTOCOL_VERSION);
  assert.equal(viewEvent.type, "daemon.view_event");
  assert.equal(viewEvent.view.type, "session.message");

  const requestEvent = parseSparkDaemonEvent({
    type: "daemon.interaction.request",
    source: "runtime",
    request: {
      requestId: "req-approval",
      kind: "toolApproval",
      title: "Approve edit?",
      toolName: "edit",
    },
  });
  assert.equal(requestEvent.type, "daemon.interaction.request");
  assert.equal(requestEvent.request.kind, "toolApproval");

  const sessionUpdated = parseSparkDaemonEvent({
    type: "daemon.session.updated",
    source: "daemon",
    sessionId: "session-daemon",
    title: "Diagnose daemon startup",
  });
  assert.equal(sessionUpdated.type, "daemon.session.updated");
  assert.equal(sessionUpdated.title, "Diagnose daemon startup");
});

test("spark protocol rejects malformed interaction requests", () => {
  assert.throws(
    () => sparkInteractionRequestSchema.parse({ requestId: "bad", kind: "askFlow", title: "Bad" }),
    /questions/u,
  );
  assert.throws(
    () =>
      sparkInteractionRequestSchema.parse({
        requestId: "bad-timeout",
        kind: "askFlow",
        title: "Bad timeout",
        timeoutMs: 0,
        questions: [{ id: "q", prompt: "Continue?", type: "freeform", options: [] }],
      }),
    /timeoutMs/u,
  );
  assert.throws(
    () =>
      sparkInteractionRequestSchema.parse({
        requestId: "bad",
        kind: "toolApproval",
        title: "Bad",
      }),
    /toolName/u,
  );
});
