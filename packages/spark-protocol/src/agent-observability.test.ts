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

function completeTrace(): SparkAgentTraceEvent[] {
  return [
    parseEvent({
      schemaVersion: 1,
      eventId: "event:run:start",
      traceId: "invocation:123",
      spanId: "run:123",
      occurredAt,
      kind: "agent.run.started",
      source: "user_submit",
      sessionFingerprint: fingerprint,
      phase: "implement",
    }),
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
        { name: "github", version: "v1", contentHash: hash },
        { name: "gh-fix-ci", version: "v2", contentHash: "d".repeat(64) },
      ],
      candidateCount: 4,
      selectorVersion: "skill-router-v2",
      selectionFingerprint: fingerprint,
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:skill-load:start",
      traceId: "invocation:123",
      spanId: "skill-load:github",
      parentSpanId: "run:123",
      occurredAt,
      kind: "skill.load.started",
      appliesFromRoundtrip: 1,
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
      appliesFromRoundtrip: 1,
      skill: { name: "github", version: "v1", contentHash: hash },
      status: "succeeded",
      durationMs: 3,
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:roundtrip:start",
      traceId: "invocation:123",
      spanId: "roundtrip:1",
      parentSpanId: "run:123",
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
      eventId: "event:tool:start",
      traceId: "invocation:123",
      spanId: "tool:call-1",
      parentSpanId: "roundtrip:1",
      occurredAt,
      kind: "tool.call.started",
      roundtrip: 1,
      toolCallId: "call-1",
      toolName: "read_file",
      effect: "read",
      executionMode: "parallel",
      approval: "none",
      argumentFingerprint,
      argumentBytes: 48,
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:tool:finish",
      traceId: "invocation:123",
      spanId: "tool:call-1",
      parentSpanId: "roundtrip:1",
      occurredAt,
      kind: "tool.call.finished",
      roundtrip: 1,
      toolCallId: "call-1",
      toolName: "read_file",
      status: "succeeded",
      durationMs: 12,
      resultBytes: 128,
      evidenceRefs: ["evidence:tool-output-1"],
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:roundtrip:finish",
      traceId: "invocation:123",
      spanId: "roundtrip:1",
      parentSpanId: "run:123",
      occurredAt,
      kind: "model.roundtrip.finished",
      roundtrip: 1,
      outcome: "completed",
      stopReason: "stop",
      durationMs: 20,
      inputTokens: 10,
      outputTokens: 5,
    }),
    parseEvent({
      schemaVersion: 1,
      eventId: "event:run:finish",
      traceId: "invocation:123",
      spanId: "run:123",
      occurredAt,
      kind: "agent.run.finished",
      outcome: "completed",
      roundtrips: 1,
      durationMs: 30,
    }),
  ];
}

function toolFinish(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    eventId: "event:tool:finish",
    traceId: "invocation:123",
    spanId: "tool:call-1",
    parentSpanId: "roundtrip:1",
    occurredAt,
    kind: "tool.call.finished",
    roundtrip: 1,
    toolCallId: "call-1",
    toolName: "read_file",
    status: "failed",
    durationMs: 12,
    failureStage: "execution",
    failureType: "tool_returned_error",
    ...overrides,
  };
}

describe("agent trace protocol", () => {
  it("accepts a complete run, Skill, model, and Tool trace", () => {
    expect(validateCompletedSparkAgentTrace(completeTrace())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("records pre-execution unknown-Tool failures as complete spans", () => {
    expect(
      parseEvent({
        schemaVersion: 1,
        eventId: "event:unknown:start",
        traceId: "invocation:123",
        spanId: "tool:unknown",
        parentSpanId: "roundtrip:1",
        occurredAt,
        kind: "tool.call.started",
        roundtrip: 1,
        toolCallId: "call-unknown",
        toolName: "missing_tool",
        effect: "unknown",
        executionMode: "unknown",
        approval: "unknown",
        argumentFingerprint,
      }).kind,
    ).toBe("tool.call.started");

    expect(
      parseEvent({
        ...toolFinish({
          eventId: "event:unknown:finish",
          spanId: "tool:unknown",
          toolCallId: "call-unknown",
          toolName: "missing_tool",
          status: "blocked",
          durationMs: 0,
          failureStage: "resolution",
          failureType: "unknown_tool",
          retryable: false,
        }),
      }).kind,
    ).toBe("tool.call.finished");
  });

  it.each([
    ["arguments", { path: "/private/secret" }],
    ["prompt", "private prompt"],
    ["body", "private Skill body"],
  ])("rejects raw %s content", (field, value) => {
    const base = {
      schemaVersion: 1,
      eventId: "event:tool:start",
      traceId: "invocation:123",
      spanId: "tool:call-1",
      parentSpanId: "roundtrip:1",
      occurredAt,
      kind: "tool.call.started",
      roundtrip: 1,
      toolCallId: "call-1",
      toolName: "read_file",
      effect: "read",
      executionMode: "sequential",
      approval: "none",
      [field]: value,
    };
    expect(() => sparkAgentTraceEventSchema.parse(base)).toThrow();
  });

  it("rejects raw Tool results", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        ...toolFinish({ status: "succeeded", result: "secret file contents" }),
        failureStage: undefined,
        failureType: undefined,
      }),
    ).toThrow();
  });

  it("requires coherent failure classification", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse(
        toolFinish({ failureStage: undefined, failureType: undefined }),
      ),
    ).toThrow();
    expect(() =>
      sparkAgentTraceEventSchema.parse(
        toolFinish({
          status: "timed_out",
          failureStage: "execution",
          failureType: "timeout",
        }),
      ),
    ).toThrow();
    expect(() =>
      sparkAgentTraceEventSchema.parse(
        toolFinish({
          status: "succeeded",
          failureStage: "execution",
          failureType: "tool_returned_error",
        }),
      ),
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
      trace.filter((entry) => entry.eventId !== "event:tool:start"),
    );
    expect(orphan.issues.map((issue) => issue.code)).toContain("orphan_finish");

    const unclosed = validateCompletedSparkAgentTrace(
      trace.filter((entry) => entry.eventId !== "event:roundtrip:finish"),
    );
    expect(unclosed.issues.map((issue) => issue.code)).toContain("unclosed_span");
  });

  it("detects missing parents, duplicate events, and metadata mismatches", () => {
    const trace = completeTrace();
    const startIndex = trace.findIndex((entry) => entry.eventId === "event:tool:start");
    trace[startIndex] = {
      ...trace[startIndex]!,
      parentSpanId: "roundtrip:missing",
    } as SparkAgentTraceEvent;

    const finishIndex = trace.findIndex((entry) => entry.eventId === "event:tool:finish");
    trace[finishIndex] = {
      ...trace[finishIndex]!,
      toolName: "different_tool",
    } as SparkAgentTraceEvent;
    trace.splice(finishIndex + 1, 0, trace[finishIndex]!);

    const codes = validateCompletedSparkAgentTrace(trace).issues.map((issue) => issue.code);
    expect(codes).toContain("missing_parent");
    expect(codes).toContain("duplicate_event");
    expect(codes).toContain("duplicate_finish");
    expect(codes).toContain("span_metadata_mismatch");
  });
});
