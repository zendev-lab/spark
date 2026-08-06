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

function event<T extends SparkAgentTraceEvent>(value: T): T {
  return sparkAgentTraceEventSchema.parse(value) as T;
}

function completeTrace(): SparkAgentTraceEvent[] {
  return [
    event({
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
    event({
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
    event({
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
    event({
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
    event({
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
    event({
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
    event({
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
    event({
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
    event({
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

describe("agent trace protocol", () => {
  it("accepts a complete run, skill, model, and tool trace", () => {
    expect(validateCompletedSparkAgentTrace(completeTrace())).toEqual({
      valid: true,
      issues: [],
    });
  });

  it("records pre-execution unknown-tool failures", () => {
    const started = event({
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
    });
    const finished = event({
      schemaVersion: 1,
      eventId: "event:unknown:finish",
      traceId: "invocation:123",
      spanId: "tool:unknown",
      parentSpanId: "roundtrip:1",
      occurredAt,
      kind: "tool.call.finished",
      roundtrip: 1,
      toolCallId: "call-unknown",
      toolName: "missing_tool",
      status: "blocked",
      durationMs: 0,
      failureStage: "resolution",
      failureType: "unknown_tool",
      retryable: false,
    });

    expect(started.kind).toBe("tool.call.started");
    expect(finished.kind).toBe("tool.call.finished");
  });

  it("rejects raw arguments, results, prompts, and skill bodies", () => {
    const baseToolStart = {
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
    };
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        ...baseToolStart,
        arguments: { path: "/private/secret" },
      }),
    ).toThrow();

    expect(() =>
      sparkAgentTraceEventSchema.parse({
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
        result: "secret file contents",
      }),
    ).toThrow();

    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:roundtrip:start",
        traceId: "invocation:123",
        spanId: "roundtrip:1",
        parentSpanId: "run:123",
        occurredAt,
        kind: "model.roundtrip.started",
        roundtrip: 1,
        model: { provider: "openai", id: "gpt-5.6" },
        promptVersion: "v1",
        stablePromptHash: hash,
        dynamicPromptHash: hash,
        toolProfileFingerprint: fingerprint,
        prompt: "private prompt",
      }),
    ).toThrow();

    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:skill-load:start",
        traceId: "invocation:123",
        spanId: "skill-load:github",
        parentSpanId: "run:123",
        occurredAt,
        kind: "skill.load.started",
        appliesFromRoundtrip: 1,
        skill: { name: "github" },
        body: "private skill body",
      }),
    ).toThrow();
  });

  it("requires failure classification on every non-success terminal event", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
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
      }),
    ).toThrow();

    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        eventId: "event:tool:timeout",
        traceId: "invocation:123",
        spanId: "tool:call-1",
        parentSpanId: "roundtrip:1",
        occurredAt,
        kind: "tool.call.finished",
        roundtrip: 1,
        toolCallId: "call-1",
        toolName: "read_file",
        status: "timed_out",
        durationMs: 12,
        failureStage: "execution",
        failureType: "timeout",
      }),
    ).toThrow();
  });

  it("rejects contradictory success records", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
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
        failureStage: "execution",
        failureType: "tool_returned_error",
      }),
    ).toThrow();
  });

  it("requires unique selected skills and coherent candidate counts", () => {
    const selection = {
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
    };
    expect(() => sparkAgentTraceEventSchema.parse(selection)).toThrow();
  });

  it("detects missing parents, unmatched finishes, and unclosed spans", () => {
    const trace = completeTrace();
    const withoutToolStart = trace.filter((entry) => entry.eventId !== "event:tool:start");
    const result = validateCompletedSparkAgentTrace(withoutToolStart);

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("orphan_finish");

    const withoutRoundtripFinish = trace.filter(
      (entry) => entry.eventId !== "event:roundtrip:finish",
    );
    const unclosed = validateCompletedSparkAgentTrace(withoutRoundtripFinish);
    expect(unclosed.issues.map((issue) => issue.code)).toContain("unclosed_span");

    const missingParent = trace.map((entry) =>
      entry.eventId === "event:tool:start"
        ? ({ ...entry, parentSpanId: "roundtrip:missing" } as SparkAgentTraceEvent)
        : entry,
    );
    expect(validateCompletedSparkAgentTrace(missingParent).issues.map((issue) => issue.code)).toContain(
      "missing_parent",
    );
  });

  it("detects duplicate events and mismatched terminal metadata", () => {
    const trace = completeTrace();
    const toolFinishIndex = trace.findIndex((entry) => entry.eventId === "event:tool:finish");
    trace[toolFinishIndex] = {
      ...trace[toolFinishIndex]!,
      toolName: "different_tool",
    } as SparkAgentTraceEvent;
    trace.splice(toolFinishIndex + 1, 0, trace[toolFinishIndex]!);

    const result = validateCompletedSparkAgentTrace(trace);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_event");
    expect(result.issues.map((issue) => issue.code)).toContain("duplicate_finish");
    expect(result.issues.map((issue) => issue.code)).toContain("span_metadata_mismatch");
  });
});
