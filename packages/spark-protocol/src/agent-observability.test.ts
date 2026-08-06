import { describe, expect, it } from "vitest";
import {
  sparkAgentEvaluationSchema,
  sparkAgentFeedbackSchema,
  sparkAgentTraceEventSchema,
} from "./index.ts";

const occurredAt = "2026-08-06T10:00:00.000Z";
const fingerprint = "a".repeat(16);
const hash = "b".repeat(64);

describe("agent observability protocol", () => {
  it("parses a privacy-safe tool lifecycle", () => {
    const started = sparkAgentTraceEventSchema.parse({
      schemaVersion: 1,
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
      argumentFingerprint: fingerprint,
      argumentBytes: 48,
    });
    const finished = sparkAgentTraceEventSchema.parse({
      schemaVersion: 1,
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
    });

    expect(started.kind).toBe("tool.call.started");
    expect(finished.kind).toBe("tool.call.finished");
    expect(finished.evidenceRefs).toEqual(["evidence:tool-output-1"]);
  });

  it("rejects raw arguments and results from trace envelopes", () => {
    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        traceId: "invocation:123",
        spanId: "tool:call-1",
        occurredAt,
        kind: "tool.call.started",
        roundtrip: 1,
        toolCallId: "call-1",
        toolName: "read_file",
        effect: "read",
        executionMode: "sequential",
        approval: "none",
        arguments: { path: "/private/secret" },
      }),
    ).toThrow();

    expect(() =>
      sparkAgentTraceEventSchema.parse({
        schemaVersion: 1,
        traceId: "invocation:123",
        spanId: "tool:call-1",
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
  });

  it("records skill selection without retaining skill bodies", () => {
    const event = sparkAgentTraceEventSchema.parse({
      schemaVersion: 1,
      traceId: "invocation:123",
      spanId: "skills:1",
      parentSpanId: "roundtrip:1",
      occurredAt,
      kind: "skill.selection.finished",
      roundtrip: 1,
      selectedSkills: ["github", "gh-fix-ci"],
      selectorVersion: "skill-router-v2",
      selectionFingerprint: fingerprint,
    });

    expect(event.kind).toBe("skill.selection.finished");
    if (event.kind === "skill.selection.finished") {
      expect(event.selectedSkills).toEqual(["github", "gh-fix-ci"]);
    }
  });

  it("requires a concrete feedback signal", () => {
    expect(() =>
      sparkAgentFeedbackSchema.parse({
        schemaVersion: 1,
        feedbackId: "feedback:1",
        target: { kind: "trace", traceId: "invocation:123" },
        source: "user",
        createdAt: occurredAt,
      }),
    ).toThrow();

    const feedback = sparkAgentFeedbackSchema.parse({
      schemaVersion: 1,
      feedbackId: "feedback:1",
      target: {
        kind: "span",
        traceId: "invocation:123",
        spanId: "tool:call-1",
      },
      source: "reviewer",
      sentiment: "negative",
      label: "wrong_tool",
      commentRef: "evidence:feedback-1",
      createdAt: occurredAt,
    });

    expect(feedback.target.kind).toBe("span");
  });

  it("parses deterministic evaluation records with numeric metrics", () => {
    const evaluation = sparkAgentEvaluationSchema.parse({
      schemaVersion: 1,
      evaluationId: "evaluation:1",
      traceId: "invocation:123",
      evaluator: {
        kind: "deterministic",
        name: "tool-selection",
        version: "v1",
      },
      verdict: "fail",
      metrics: {
        toolErrors: 1,
        repeatedCalls: 2,
      },
      evidenceRefs: ["evidence:evaluation-1"],
      createdAt: occurredAt,
    });

    expect(evaluation.metrics).toEqual({ toolErrors: 1, repeatedCalls: 2 });
  });

  it("parses model roundtrip fingerprints without prompt content", () => {
    const event = sparkAgentTraceEventSchema.parse({
      schemaVersion: 1,
      traceId: "invocation:123",
      spanId: "roundtrip:1",
      parentSpanId: "run:1",
      occurredAt,
      kind: "model.roundtrip.started",
      roundtrip: 1,
      model: { provider: "openai", id: "gpt-5.6" },
      promptVersion: "spark-prompt-v2",
      stablePromptHash: hash,
      dynamicPromptHash: hash,
      toolProfileFingerprint: fingerprint,
    });

    expect(event.kind).toBe("model.roundtrip.started");
  });
});
