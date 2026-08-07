import { describe, expect, it } from "vitest";

import {
  EXECUTION_ATTEMPT_PROTOCOL_VERSION,
  ExecutionAttemptProtocolError,
  ExecutionAttemptProtocolFence,
  MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES,
  parseExecutionAttemptEnvelope,
  type ExecutionAttemptEnvelope,
} from "./contract.ts";

const identity = {
  invocationId: "inv_contract",
  attemptEpoch: 2,
  daemonGeneration: 7,
};
const correlationId = "corr_contract";

describe("execution attempt envelope", () => {
  it("parses versioned JSON-safe messages without a worker heartbeat type", () => {
    const accepted = envelope("accepted", 1, { acceptedAt: "2026-08-07T00:00:00.000Z" });
    expect(parseExecutionAttemptEnvelope(JSON.stringify(accepted))).toEqual(accepted);
    expect(() =>
      parseExecutionAttemptEnvelope({ ...accepted, type: "task_claim_heartbeat" }),
    ).toThrowError(expect.objectContaining({ code: "execution_attempt_unknown_type" }));
  });

  it.each([
    [
      "unsupported version",
      { ...envelope("accepted", 1, { acceptedAt: now }), version: 2 },
      "execution_attempt_unsupported_version",
    ],
    [
      "unknown type",
      { ...envelope("accepted", 1, { acceptedAt: now }), type: "unknown" },
      "execution_attempt_unknown_type",
    ],
    [
      "invalid epoch",
      { ...envelope("accepted", 1, { acceptedAt: now }), attemptEpoch: 0 },
      "execution_attempt_identity_invalid",
    ],
    [
      "forbidden env",
      { ...envelope("event", 1, { eventSequence: 1, event: { env: { TOKEN: "x" } } }) },
      "execution_attempt_invalid_payload",
    ],
    [
      "AbortSignal",
      {
        ...envelope("event", 1, {
          eventSequence: 1,
          event: new AbortController().signal as never,
        }),
      },
      "execution_attempt_invalid_payload",
    ],
  ])("rejects %s with a stable code", (_label, value, code) => {
    expect(() => parseExecutionAttemptEnvelope(value)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it.each([
    "processEnv",
    "process_env",
    "environmentVariables",
    "environmentvariables",
    "ENVIRONMENTVARIABLES",
    "envVars",
    "accessToken",
    "githubToken",
    "githubtoken",
    "GITHUBTOKEN",
    "registration_token",
    "registrationtoken",
    "REGISTRATIONTOKEN",
    "access-token",
    "authToken",
    "clientauth",
    "CLIENTAUTH",
    "authHeader",
    "clientSecret",
    "authorizationHeader",
    "apiKey",
    "private_key",
    "sshKey",
    "githubPat",
    "jwt",
    "sessionCookie",
  ])("rejects nested secret/environment key bypass %s", (key) => {
    expect(() =>
      parseExecutionAttemptEnvelope(
        envelope("event", 1, {
          eventSequence: 1,
          event: { nested: [{ safe: true }, { deeper: { [key]: "must-not-cross" } }] },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "execution_attempt_invalid_payload" }));
  });

  it("allows non-secret token accounting counters", () => {
    const usage = envelope("usage", 1, {
      usageSequence: 1,
      usage: {
        inputTokens: 3,
        OUTPUTTOKENS: 2,
        total_tokens: 5,
        cacheReadTokens: 1,
        cachewritetokens: 1,
        providerTotalTokens: 5,
        reasoning_tokens: 0,
        authority: "runtime_control",
      },
    });
    expect(parseExecutionAttemptEnvelope(usage)).toEqual(usage);
  });

  it("rejects malformed JSON and missing required fields with stable codes", () => {
    expect(() => parseExecutionAttemptEnvelope("{")).toThrowError(
      expect.objectContaining({ code: "execution_attempt_invalid_json" }),
    );
    expect(() =>
      parseExecutionAttemptEnvelope({
        version: 1,
        type: "accepted",
        ...identity,
        sequence: 1,
        correlationId,
      }),
    ).toThrowError(expect.objectContaining({ code: "execution_attempt_invalid_payload" }));
  });

  it("rejects oversized payloads before parsing", () => {
    const payload = "x".repeat(MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES + 1);
    expect(() => parseExecutionAttemptEnvelope(payload)).toThrowError(
      expect.objectContaining({ code: "execution_attempt_payload_too_large" }),
    );
  });
});

describe("execution attempt protocol fence", () => {
  it("accepts queued -> accepted -> running -> terminal only after event and usage acks", () => {
    const fence = new ExecutionAttemptProtocolFence(identity, correlationId);
    expect(fence.process(envelope("accepted", 1, { acceptedAt: now }))).toEqual({
      status: "accepted",
    });
    expect(fence.process(envelope("running", 2, { startedAt: now }))).toEqual({
      status: "running",
    });
    for (let eventSequence = 1; eventSequence <= 3; eventSequence += 1) {
      expect(
        fence.process(
          envelope("event", eventSequence + 2, {
            eventSequence,
            event: { type: "delta", eventSequence },
          }),
        ),
      ).toEqual({ status: "recorded" });
    }
    expect(fence.process(envelope("usage", 6, { usageSequence: 1, usage: { input: 12 } }))).toEqual(
      { status: "recorded" },
    );
    expect(
      fence.process(
        envelope("terminal", 7, {
          status: "succeeded",
          eventHighWaterMark: 3,
          usageHighWaterMark: 1,
          result: { ok: true },
        }),
      ),
    ).toEqual({ status: "terminal_pending", eventHighWaterMark: 3, usageHighWaterMark: 1 });
    expect(fence.terminal()).toBeUndefined();
    expect(fence.acknowledgeUsage(1)).toEqual({
      status: "terminal_pending",
      eventHighWaterMark: 3,
      usageHighWaterMark: 1,
    });
    expect(fence.acknowledgeEvent(2)).toEqual({
      status: "terminal_pending",
      eventHighWaterMark: 3,
      usageHighWaterMark: 1,
    });
    expect(fence.terminal()).toBeUndefined();
    const committed = fence.acknowledgeEvent(3);
    expect(committed?.status).toBe("terminal_committed");
    expect(fence.terminal()?.status).toBe("succeeded");
    expect(() =>
      fence.process(envelope("event", 8, { eventSequence: 4, event: { late: true } })),
    ).toThrowError(expect.objectContaining({ code: "execution_attempt_terminal_committed" }));
  });

  it("closes worker input after a pending terminal while durable acks commit only the first terminal", () => {
    const fence = new ExecutionAttemptProtocolFence(identity, correlationId);
    fence.process(envelope("accepted", 1, { acceptedAt: now }));
    fence.process(envelope("running", 2, { startedAt: now }));
    fence.process(envelope("event", 3, { eventSequence: 1, event: { type: "delta" } }));
    fence.process(envelope("usage", 4, { usageSequence: 1, usage: { inputTokens: 3 } }));
    expect(
      fence.process(
        envelope("terminal", 5, {
          status: "succeeded",
          eventHighWaterMark: 1,
          usageHighWaterMark: 1,
          result: { first: true },
        }),
      ),
    ).toEqual({ status: "terminal_pending", eventHighWaterMark: 1, usageHighWaterMark: 1 });
    expect(fence.phase()).toBe("terminal");

    for (const late of [
      envelope("event", 6, { eventSequence: 2, event: { type: "late" } }),
      envelope("usage", 6, { usageSequence: 2, usage: { inputTokens: 99 } }),
      envelope("capability_request", 6, {
        operation: "loop.stop",
        request: { loopId: "loop-late" },
      }),
      envelope("terminal", 6, {
        status: "failed",
        eventHighWaterMark: 1,
        usageHighWaterMark: 1,
        result: { replaced: true },
      }),
    ]) {
      expect(() => fence.process(late)).toThrowError(
        expect.objectContaining({ code: "execution_attempt_terminal_committed" }),
      );
    }

    expect(fence.acknowledgeEvent(1)).toEqual({
      status: "terminal_pending",
      eventHighWaterMark: 1,
      usageHighWaterMark: 1,
    });
    expect(fence.acknowledgeUsage(1)).toEqual(
      expect.objectContaining({
        status: "terminal_committed",
        terminal: expect.objectContaining({ status: "succeeded", result: { first: true } }),
      }),
    );
    expect(fence.terminal()).toEqual(
      expect.objectContaining({ status: "succeeded", result: { first: true } }),
    );
  });

  it("keeps Ask on the same active attempt and slot without a suspend transition", () => {
    const fence = new ExecutionAttemptProtocolFence(identity, correlationId);
    fence.process(envelope("accepted", 1, { acceptedAt: now }));
    fence.process(envelope("running", 2, { startedAt: now }));
    expect(
      fence.process(
        envelope("capability_request", 3, {
          operation: "human.interaction",
          request: { prompt: "approve?" },
        }),
      ),
    ).toEqual({ status: "capability_requested" });
    expect(fence.phase()).toBe("running");
    expect(
      fence.process(
        envelope("terminal", 4, {
          status: "succeeded",
          eventHighWaterMark: 0,
          usageHighWaterMark: 0,
        }),
      ),
    ).toEqual(expect.objectContaining({ status: "terminal_committed" }));
  });

  it.each([
    [
      "different invocation",
      { ...envelope("accepted", 1, { acceptedAt: now }), invocationId: "inv_other" },
      "execution_attempt_correlation_mismatch",
    ],
    [
      "different attempt",
      { ...envelope("accepted", 1, { acceptedAt: now }), attemptEpoch: 1 },
      "execution_attempt_stale",
    ],
    [
      "different generation",
      { ...envelope("accepted", 1, { acceptedAt: now }), daemonGeneration: 6 },
      "execution_attempt_stale",
    ],
    [
      "different correlation",
      { ...envelope("accepted", 1, { acceptedAt: now }), correlationId: "corr_other" },
      "execution_attempt_correlation_mismatch",
    ],
  ])("rejects %s", (_label, value, code) => {
    const fence = new ExecutionAttemptProtocolFence(identity, correlationId);
    expect(() => fence.process(value)).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects duplicate, skipped, out-of-order, and false high-water sequences", () => {
    const replay = new ExecutionAttemptProtocolFence(identity, correlationId);
    const accepted = envelope("accepted", 1, { acceptedAt: now });
    replay.process(accepted);
    expect(() => replay.process(accepted)).toThrowError(
      expect.objectContaining({ code: "execution_attempt_sequence_replayed" }),
    );

    const skipped = new ExecutionAttemptProtocolFence(identity, correlationId);
    expect(() => skipped.process(envelope("accepted", 2, { acceptedAt: now }))).toThrowError(
      expect.objectContaining({ code: "execution_attempt_sequence_invalid" }),
    );

    const highWater = new ExecutionAttemptProtocolFence(identity, correlationId);
    highWater.process(envelope("accepted", 1, { acceptedAt: now }));
    highWater.process(envelope("running", 2, { startedAt: now }));
    highWater.process(envelope("event", 3, { eventSequence: 1, event: {} }));
    expect(() =>
      highWater.process(
        envelope("terminal", 4, {
          status: "succeeded",
          eventHighWaterMark: 2,
          usageHighWaterMark: 0,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "execution_attempt_high_water_invalid" }));
    expect(
      highWater.process(
        envelope("terminal", 4, {
          status: "succeeded",
          eventHighWaterMark: 1,
          usageHighWaterMark: 0,
        }),
      ),
    ).toEqual({ status: "terminal_pending", eventHighWaterMark: 1, usageHighWaterMark: 0 });
  });
});

const now = "2026-08-07T00:00:00.000Z";

function envelope<T extends ExecutionAttemptEnvelope["type"]>(
  type: T,
  sequence: number,
  fields: Omit<Extract<ExecutionAttemptEnvelope, { type: T }>, keyof ExecutionAttemptEnvelopeBase>,
): Extract<ExecutionAttemptEnvelope, { type: T }> {
  return {
    version: EXECUTION_ATTEMPT_PROTOCOL_VERSION,
    type,
    ...identity,
    sequence,
    correlationId,
    ...fields,
  } as Extract<ExecutionAttemptEnvelope, { type: T }>;
}

type ExecutionAttemptEnvelopeBase = {
  version: number;
  type: string;
  invocationId: string;
  attemptEpoch: number;
  daemonGeneration: number;
  sequence: number;
  correlationId: string;
};

expect(ExecutionAttemptProtocolError).toBeDefined();
