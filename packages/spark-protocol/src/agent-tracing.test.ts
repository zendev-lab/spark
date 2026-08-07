import { describe, expect, it } from "vitest";
import {
  sparkAgentTraceEventSchema,
  validateCompletedSparkAgentTrace,
  type SparkAgentTraceEvent,
} from "./index.ts";

const occurredAt = "2026-08-06T10:00:00.000Z";
const fingerprint = "a".repeat(16);
const hash = "b".repeat(64);
const argumentFingerprint = {
  scheme: "hmac-sha256-v1" as const,
  value: "c".repeat(64),
  keyScope: "installation" as const,
};

function parseEvent(value: unknown): SparkAgentTraceEvent {
  return sparkAgentTraceEventSchema.parse(value);
}

function runStarted(): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: "event:run:start",
    traceId: "invocation:123",
    spanId: "run:123",
    occurredAt,
    kind: "agent.run.started",
    source: "user_submit",
    sessionFingerprint: fingerprint,
    phase: "implement",
  });
}

function roundtripStarted(
  roundtrip: number,
  spanId = `roundtrip:${roundtrip}`,
): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: `event:${spanId}:start`,
    traceId: "invocation:123",
    spanId,
    parentSpanId: "run:123",
    occurredAt,
    kind: "model.roundtrip.started",
    roundtrip,
    model: { provider: "openai", id: "gpt-5.6" },
    promptVersion: "spark-prompt-v2",
    stablePromptHash: hash,
    dynamicPromptHash: hash,
    toolProfileFingerprint: fingerprint,
  });
}

function roundtripFinished(
  roundtrip: number,
  spanId = `roundtrip:${roundtrip}`,
): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: `event:${spanId}:finish`,
    traceId: "invocation:123",
    spanId,
    parentSpanId: "run:123",
    occurredAt,
    kind: "model.roundtrip.finished",
    roundtrip,
    outcome: "completed",
    stopReason: roundtrip === 1 ? "tool_use" : "stop",
    durationMs: 20,
    inputTokens: 10,
    outputTokens: 5,
  });
}

function toolStarted(
  overrides: Record<string, unknown> = {},
  spanId = "tool:call-1",
): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: `event:${spanId}:start`,
    traceId: "invocation:123",
    spanId,
    parentSpanId: "run:123",
    occurredAt,
    kind: "tool.call.started",
    toolCallId: "call-1",
    toolName: "read_file",
    modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
    effect: "read",
    executionMode: "parallel",
    approval: "none",
    argumentFingerprint,
    argumentBytes: 48,
    ...overrides,
  });
}

function toolFinished(
  overrides: Record<string, unknown> = {},
  spanId = "tool:call-1",
): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: `event:${spanId}:finish`,
    traceId: "invocation:123",
    spanId,
    parentSpanId: "run:123",
    occurredAt,
    kind: "tool.call.finished",
    toolCallId: "call-1",
    toolName: "read_file",
    modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
    status: "succeeded",
    durationMs: 12,
    resultBytes: 128,
    evidenceRefs: ["evidence:tool-output-1"],
    ...overrides,
  });
}

function runFinished(roundtrips = 2): SparkAgentTraceEvent {
  return parseEvent({
    schemaVersion: 1,
    eventId: "event:run:finish",
    traceId: "invocation:123",
    spanId: "run:123",
    occurredAt,
    kind: "agent.run.finished",
    outcome: "completed",
    roundtrips,
    durationMs: 50,
  });
}

function completeTrace(): SparkAgentTraceEvent[] {
  return [
    runStarted(),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:skills:selected",
      traceId: "invocation:123",
      spanId: "skills:selection:1",
      parentSpanId: "run:123",
      occurredAt,
      kind: "skill.selection.finished",
      appliesFromRoundtrip: 1,
      mode: "automatic",
      skills: [
        { name: "github", version: "v1" },
        { name: "gh-fix-ci", version: "v2" },
      ],
      candidateCount: 4,
      selectorVersion: "skill-router-v2",
      selectionFingerprint: fingerprint,
    }),
    roundtripStarted(1),
    roundtripFinished(1),
    toolStarted(),
    toolFinished(),
    roundtripStarted(2),
    roundtripFinished(2),
    runFinished(),
  ];
}

describe("agent trace protocol", () => {
  it("accepts model-complete then Tool execution as sibling spans under the run", () => {
    expect(validateCompletedSparkAgentTrace(completeTrace())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("does not require metadata-only Skill selection to fabricate a Skill load", () => {
    const trace = completeTrace();
    expect(trace.some((event) => event.kind === "skill.selection.finished")).toBe(true);
    expect(trace.some((event) => event.kind === "skill.load.started")).toBe(false);
    expect(validateCompletedSparkAgentTrace(trace).valid).toBe(true);
  });

  it("accepts a real Skill body load independently of routing selection", () => {
    const trace = completeTrace();
    trace.splice(
      2,
      0,
      parseEvent({
        schemaVersion: 1,
        eventId: "event:skill-load:start",
        traceId: "invocation:123",
        spanId: "skill-load:github",
        parentSpanId: "run:123",
        occurredAt,
        kind: "skill.load.started",
        skill: { name: "github", version: "v1", contentHash: hash },
      }),
      parseEvent({
        schemaVersion: 1,
        eventId: "event:skill-load:finish",
        traceId: "invocation:123",
        spanId: "skill-load:github",
        parentSpanId: "run:123",
        occurredAt,
        kind: "skill.load.finished",
        skill: { name: "github", version: "v1", contentHash: hash },
        status: "succeeded",
        durationMs: 3,
      }),
    );
    expect(validateCompletedSparkAgentTrace(trace).valid).toBe(true);
  });

  it("accepts legacy restart-resume Tool execution when model origin is unavailable", () => {
    const trace = completeTrace().map((event) => {
      if (event.kind !== "tool.call.started" && event.kind !== "tool.call.finished") return event;
      const { modelOrigin: _modelOrigin, ...withoutOrigin } = event;
      return parseEvent(withoutOrigin);
    });
    expect(validateCompletedSparkAgentTrace(trace).valid).toBe(true);
  });

  it("records pre-execution unknown-Tool failures as complete spans", () => {
    expect(
      parseEvent({
        schemaVersion: 1,
        eventId: "event:unknown:start",
        traceId: "invocation:123",
        spanId: "tool:unknown",
        parentSpanId: "run:123",
        occurredAt,
        kind: "tool.call.started",
        toolCallId: "call-unknown",
        toolName: "missing_tool",
        modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
        effect: "unknown",
        executionMode: "unknown",
        approval: "unknown",
        argumentFingerprint,
      }).kind,
    ).toBe("tool.call.started");

    expect(
      parseEvent({
        schemaVersion: 1,
        eventId: "event:unknown:finish",
        traceId: "invocation:123",
        spanId: "tool:unknown",
        parentSpanId: "run:123",
        occurredAt,
        kind: "tool.call.finished",
        toolCallId: "call-unknown",
        toolName: "missing_tool",
        modelOrigin: { roundtrip: 1, spanId: "roundtrip:1" },
        status: "blocked",
        durationMs: 0,
        failureStage: "resolution",
        failureType: "unknown_tool",
        retryable: false,
      }).kind,
    ).toBe("tool.call.finished");
  });

  it.each([
    ["arguments", { path: "/private/secret" }],
    ["prompt", "private prompt"],
    ["body", "private Skill body"],
  ])("rejects raw %s content", (field, value) => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:tool:start",
        traceId: "invocation:123",
        spanId: "tool:call-1",
        parentSpanId: "run:123",
        occurredAt,
        kind: "tool.call.started",
        toolCallId: "call-1",
        toolName: "read_file",
        effect: "read",
        executionMode: "sequential",
        approval: "none",
        [field]: value,
      }),
    ).toThrow();
  });

  it("rejects raw Tool results", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:tool:finish",
        traceId: "invocation:123",
        spanId: "tool:call-1",
        parentSpanId: "run:123",
        occurredAt,
        kind: "tool.call.finished",
        toolCallId: "call-1",
        toolName: "read_file",
        status: "succeeded",
        durationMs: 12,
        result: "secret file contents",
      }),
    ).toThrow();
  });

  it("requires coherent failure classification", () => {
    const base = {
      schemaVersion: 1,
      eventId: "event:tool:finish",
      traceId: "invocation:123",
      spanId: "tool:call-1",
      parentSpanId: "run:123",
      occurredAt,
      kind: "tool.call.finished",
      toolCallId: "call-1",
      toolName: "read_file",
      durationMs: 12,
    };
    expect(() => sparkAgentTraceEventSchema.parse({ ...base, status: "failed" })).toThrow();
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        ...base,
        status: "timed_out",
        failureStage: "execution",
        failureType: "timeout",
      }),
    ).toThrow();
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        ...base,
        status: "succeeded",
        failureStage: "execution",
        failureType: "tool_returned_error",
      }),
    ).toThrow();
  });

  it("requires unique selected Skills and coherent candidate counts", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:skills:selected",
        traceId: "invocation:123",
        spanId: "skills:selection:1",
        parentSpanId: "run:123",
        occurredAt,
        kind: "skill.selection.finished",
        appliesFromRoundtrip: 1,
        mode: "automatic",
        skills: [{ name: "github" }, { name: "github" }],
        candidateCount: 1,
      }),
    ).toThrow();
  });

  it("detects orphan finishes and unclosed spans", () => {
    const trace = completeTrace();
    const orphan = validateCompletedSparkAgentTrace(
      trace.filter((entry) => entry.eventId !== "event:tool:call-1:start"),
    );
    expect(orphan.issues.map((issue) => issue.code)).toContain("orphan_finish");

    const unclosed = validateCompletedSparkAgentTrace(
      trace.filter((entry) => entry.eventId !== "event:roundtrip:2:finish"),
    );
    expect(unclosed.issues.map((issue) => issue.code)).toContain("unclosed_span");
  });

  it("detects invalid parents, duplicate events, and start-finish metadata mismatches", () => {
    const trace = completeTrace();
    const toolStartIndex = trace.findIndex((entry) => entry.kind === "tool.call.started");
    trace[toolStartIndex] = parseEvent({
      ...trace[toolStartIndex]!,
      parentSpanId: "roundtrip:1",
    });

    const toolFinishIndex = trace.findIndex((entry) => entry.kind === "tool.call.finished");
    trace[toolFinishIndex] = parseEvent({
      ...trace[toolFinishIndex]!,
      toolName: "different_tool",
    });
    trace.splice(toolFinishIndex + 1, 0, trace[toolFinishIndex]!);

    const codes = validateCompletedSparkAgentTrace(trace).issues.map((issue) => issue.code);
    expect(codes).toContain("invalid_parent");
    expect(codes).toContain("duplicate_event");
    expect(codes).toContain("duplicate_finish");
    expect(codes).toContain("span_metadata_mismatch");
  });

  it("rejects duplicate, skipped, and overlapping model roundtrips", () => {
    const duplicate = completeTrace();
    const secondStart = duplicate.findIndex(
      (event) => event.kind === "model.roundtrip.started" && event.roundtrip === 2,
    );
    duplicate[secondStart] = roundtripStarted(1, "roundtrip:duplicate");
    expect(validateCompletedSparkAgentTrace(duplicate).issues.map((issue) => issue.code)).toContain(
      "roundtrip_sequence",
    );

    const skipped = completeTrace();
    const skippedStart = skipped.findIndex(
      (event) => event.kind === "model.roundtrip.started" && event.roundtrip === 2,
    );
    const skippedFinish = skipped.findIndex(
      (event) => event.kind === "model.roundtrip.finished" && event.roundtrip === 2,
    );
    skipped[skippedStart] = roundtripStarted(3, "roundtrip:3");
    skipped[skippedFinish] = roundtripFinished(3, "roundtrip:3");
    expect(validateCompletedSparkAgentTrace(skipped).issues.map((issue) => issue.code)).toContain(
      "roundtrip_sequence",
    );

    const overlapping = completeTrace();
    const firstFinish = overlapping.findIndex(
      (event) => event.kind === "model.roundtrip.finished" && event.roundtrip === 1,
    );
    overlapping.splice(firstFinish, 0, roundtripStarted(2));
    expect(
      validateCompletedSparkAgentTrace(overlapping).issues.map((issue) => issue.code),
    ).toContain("roundtrip_overlap");
  });

  it("requires model-origin links to reference a completed matching roundtrip", () => {
    const mismatch = completeTrace();
    const toolStartIndex = mismatch.findIndex((event) => event.kind === "tool.call.started");
    mismatch[toolStartIndex] = parseEvent({
      ...mismatch[toolStartIndex]!,
      modelOrigin: { roundtrip: 2, spanId: "roundtrip:1" },
    });
    expect(validateCompletedSparkAgentTrace(mismatch).issues.map((issue) => issue.code)).toContain(
      "invalid_model_origin",
    );

    const openOrigin = completeTrace();
    const firstFinish = openOrigin.findIndex(
      (event) => event.kind === "model.roundtrip.finished" && event.roundtrip === 1,
    );
    const [finish] = openOrigin.splice(firstFinish, 1);
    const toolFinishIndex = openOrigin.findIndex((event) => event.kind === "tool.call.finished");
    openOrigin.splice(toolFinishIndex + 1, 0, finish!);
    expect(
      validateCompletedSparkAgentTrace(openOrigin).issues.map((issue) => issue.code),
    ).toContain("model_origin_open");
  });
});
