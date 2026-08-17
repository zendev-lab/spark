import {
  normalizeSparkA2uiDocument,
  parseSparkSessionView,
  projectSparkConversationMessage,
  sparkAgentTraceEventSchema,
  sparkMessageViewSchema,
  validateCompletedSparkAgentTrace,
  type SparkAgentTraceEvent,
  type SparkMessageView,
} from "@zendev-lab/spark-protocol";

export const SESSION_VIEW_MESSAGE_COUNT = 500;
export const CONVERSATION_PART_COUNT = 500;
export const A2UI_COMPONENT_COUNT = 500;
export const AGENT_TRACE_TOOL_COUNT = 247;

const occurredAt = "2026-08-17T00:00:00.000Z";
const fingerprint = "a".repeat(16);
const hash = "b".repeat(64);
const argumentFingerprint = {
  scheme: "hmac-sha256-v1" as const,
  value: "c".repeat(64),
  keyScope: "installation" as const,
};

export const sessionViewInput = {
  sessionId: "sess_protocol_bench",
  status: "idle" as const,
  messages: Array.from({ length: SESSION_VIEW_MESSAGE_COUNT }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `payload ${index}`,
    status: "done" as const,
  })),
};

export const conversationMessageInput: SparkMessageView = sparkMessageViewSchema.parse({
  id: "message-tools",
  role: "assistant",
  text: "",
  status: "done",
  parts: Array.from({ length: CONVERSATION_PART_COUNT / 2 }, (_, index) => [
    {
      id: `call-${index}`,
      type: "tool-call",
      toolCallId: `call-${index}`,
      toolName: "read",
      summary: `Reading ${index}`,
      status: "running",
    },
    {
      id: `result-${index}`,
      type: "tool-result",
      toolCallId: `call-${index}`,
      toolName: "read",
      summary: `Read ${index}`,
      status: "complete",
    },
  ]).flat(),
});

export const a2uiDocumentJson = JSON.stringify({
  messages: [
    {
      version: "v0.9.1",
      createSurface: {
        surfaceId: "workbench",
        catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
      },
    },
    {
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "workbench",
        components: Array.from({ length: A2UI_COMPONENT_COUNT }, (_, index) => ({
          id: `component-${index}`,
          component: "Text",
          text: `item ${index}`,
        })),
      },
    },
  ],
});

function parseEvent(value: unknown): SparkAgentTraceEvent {
  return sparkAgentTraceEventSchema.parse(value);
}

export const completedAgentTrace: SparkAgentTraceEvent[] = [
  parseEvent({
    schemaVersion: 1,
    eventId: "event:run:start",
    traceId: "invocation:bench",
    spanId: "run:bench",
    occurredAt,
    kind: "agent.run.started",
    source: "user_submit",
    sessionFingerprint: fingerprint,
    phase: "implement",
  }),
  parseEvent({
    schemaVersion: 1,
    eventId: "event:roundtrip:1:start",
    traceId: "invocation:bench",
    spanId: "roundtrip:1",
    parentSpanId: "run:bench",
    occurredAt,
    kind: "model.roundtrip.started",
    roundtrip: 1,
    model: { provider: "openai", id: "gpt-5.6" },
    promptVersion: "spark-prompt-v2",
    stablePromptHash: hash,
    dynamicPromptHash: hash,
    toolProfileFingerprint: fingerprint,
  }),
  parseEvent({
    schemaVersion: 1,
    eventId: "event:roundtrip:1:finish",
    traceId: "invocation:bench",
    spanId: "roundtrip:1",
    parentSpanId: "run:bench",
    occurredAt,
    kind: "model.roundtrip.finished",
    roundtrip: 1,
    outcome: "completed",
    stopReason: "tool_use",
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
  }),
  ...Array.from({ length: AGENT_TRACE_TOOL_COUNT }, (_, index) => [
    parseEvent({
      schemaVersion: 1,
      eventId: `event:tool:${index}:start`,
      traceId: "invocation:bench",
      spanId: `tool:${index}`,
      parentSpanId: "run:bench",
      occurredAt,
      kind: "tool.call.started",
      toolCallId: `call-${index}`,
      toolName: "read_file",
      modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
      effect: "read",
      executionMode: "parallel",
      approval: "none",
      argumentFingerprint,
      argumentBytes: 48,
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: `event:tool:${index}:finish`,
      traceId: "invocation:bench",
      spanId: `tool:${index}`,
      parentSpanId: "run:bench",
      occurredAt,
      kind: "tool.call.finished",
      toolCallId: `call-${index}`,
      toolName: "read_file",
      modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
      status: "succeeded",
      durationMs: 12,
      resultBytes: 128,
      evidenceRefs: [`evidence:tool-output-${index}`],
    }),
  ]).flat(),
  parseEvent({
    schemaVersion: 1,
    eventId: "event:roundtrip:2:start",
    traceId: "invocation:bench",
    spanId: "roundtrip:2",
    parentSpanId: "run:bench",
    occurredAt,
    kind: "model.roundtrip.started",
    roundtrip: 2,
    model: { provider: "openai", id: "gpt-5.6" },
    promptVersion: "spark-prompt-v2",
    stablePromptHash: hash,
    dynamicPromptHash: hash,
    toolProfileFingerprint: fingerprint,
  }),
  parseEvent({
    schemaVersion: 1,
    eventId: "event:roundtrip:2:finish",
    traceId: "invocation:bench",
    spanId: "roundtrip:2",
    parentSpanId: "run:bench",
    occurredAt,
    kind: "model.roundtrip.finished",
    roundtrip: 2,
    outcome: "completed",
    stopReason: "stop",
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
  }),
  parseEvent({
    schemaVersion: 1,
    eventId: "event:run:finish",
    traceId: "invocation:bench",
    spanId: "run:bench",
    occurredAt,
    kind: "agent.run.finished",
    outcome: "completed",
    roundtrips: 2,
    durationMs: 50,
  }),
];

export function runParseSparkSessionView() {
  return parseSparkSessionView(sessionViewInput);
}

export function runProjectSparkConversationMessage() {
  return projectSparkConversationMessage(conversationMessageInput);
}

export function runNormalizeSparkA2uiDocument() {
  return normalizeSparkA2uiDocument(a2uiDocumentJson);
}

export function runValidateCompletedSparkAgentTrace() {
  return validateCompletedSparkAgentTrace(completedAgentTrace);
}
