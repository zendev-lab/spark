import { describe, expect, it } from "vitest";
import { createId } from "../refs.ts";
import {
  SparkProtocolVersionError,
  assertSparkProtocolVersion,
  assertSparkRuntimeProtocolVersion,
} from "../version.ts";
import {
  SparkRuntimeProtocolDiagnosticError,
  diagnoseRuntimeProtocolMessage,
  formatRuntimeProtocolDiagnostic,
  parseRuntimeProtocolJson,
  serverErrorEnvelopeSchema,
  serverIngestAckEnvelopeSchema,
} from "./diagnostics.ts";
import { runtimeProtocolVersion } from "./envelope.ts";

const runtimeBoundary = {
  direction: "runtime-to-server" as const,
  boundary: "Hub runtime WebSocket",
};

function runtimeHello() {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.hello" as const,
    sentAt: "2026-08-04T00:00:00.000Z",
    payload: {
      runtimeId: createId("rt"),
      runtimeVersion: "0.1.0-test",
      supportedFeatures: [],
      workspaceBindings: [],
    },
  };
}

describe("Spark protocol version diagnostics", () => {
  it("preserves the mismatch as structured, actionable data", () => {
    expect(() => assertSparkProtocolVersion(2, { label: "workspace snapshot" })).toThrowError(
      SparkProtocolVersionError,
    );

    try {
      assertSparkProtocolVersion(2, { label: "workspace snapshot" });
    } catch (error) {
      expect(error).toBeInstanceOf(SparkProtocolVersionError);
      if (!(error instanceof SparkProtocolVersionError)) return;
      expect(error.mismatch).toEqual({
        code: "SPARK_PROTOCOL_VERSION_MISMATCH",
        kind: "view-model",
        field: "version",
        label: "workspace snapshot",
        received: "2",
        expected: "1",
        action:
          "Upgrade Spark or migrate the payload to the supported schema version before retrying.",
      });
      expect(error.message).toContain(
        "unsupported Spark protocol version at workspace snapshot: received 2; expected 1",
      );
      expect(error.message).toContain("Action:");
    }
  });

  it("names the coordinated runtime recovery action", () => {
    expect(() =>
      assertSparkRuntimeProtocolVersion("spark.runtime.v0", {
        label: "daemon uplink",
      }),
    ).toThrow(/Upgrade and restart Spark Hub and spark-daemon from the same Spark release/u);
  });
});

describe("runtime WebSocket diagnostics", () => {
  it("accepts a valid message for the declared direction", () => {
    expect(diagnoseRuntimeProtocolMessage(runtimeHello(), runtimeBoundary)).toBeNull();
  });

  it("reports the exact received and supported protocol versions", () => {
    const diagnostic = diagnoseRuntimeProtocolMessage(
      { ...runtimeHello(), protocolVersion: "spark.runtime.v0" },
      runtimeBoundary,
    );

    expect(diagnostic).toMatchObject({
      code: "protocol_version_mismatch",
      boundary: "Hub runtime WebSocket",
      direction: "runtime-to-server",
      receivedProtocolVersion: '"spark.runtime.v0"',
      expectedProtocolVersion: runtimeProtocolVersion,
      messageType: "runtime.hello",
    });
    expect(formatRuntimeProtocolDiagnostic(diagnostic!)).toContain(
      `this build accepts only ${JSON.stringify(runtimeProtocolVersion)}`,
    );
    expect(formatRuntimeProtocolDiagnostic(diagnostic!)).toContain(
      "Upgrade and restart Spark Hub and spark-daemon from the same Spark release",
    );
  });

  it("distinguishes a missing version from an unknown message", () => {
    const diagnostic = diagnoseRuntimeProtocolMessage(
      { type: "runtime.future", payload: {} },
      runtimeBoundary,
    );

    expect(diagnostic).toMatchObject({
      code: "missing_protocol_version",
      messageType: "runtime.future",
      expectedProtocolVersion: runtimeProtocolVersion,
    });
  });

  it("bounds attacker-controlled version and message type descriptions", () => {
    const oversizedType = `runtime.future.${"x".repeat(10_000)}`;
    const diagnostic = diagnoseRuntimeProtocolMessage(
      { protocolVersion: runtimeProtocolVersion, type: oversizedType },
      runtimeBoundary,
    );
    const invalidVersion = diagnoseRuntimeProtocolMessage(
      { protocolVersion: { secret: "do-not-render" }, type: "runtime.hello" },
      runtimeBoundary,
    );

    expect(diagnostic).toMatchObject({ code: "unsupported_message_type" });
    expect(diagnostic?.messageType?.length).toBeLessThanOrEqual(160);
    expect(diagnostic?.message.length).toBeLessThan(1_000);
    expect(invalidVersion).toMatchObject({
      code: "protocol_version_mismatch",
      receivedProtocolVersion: "<object>",
    });
    expect(invalidVersion?.message).not.toContain("do-not-render");
  });

  it("reports the wrong transport direction before payload validation", () => {
    const diagnostic = diagnoseRuntimeProtocolMessage(
      {
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.command",
        sentAt: "2026-08-04T00:00:00.000Z",
        payload: {},
      },
      runtimeBoundary,
    );

    expect(diagnostic).toMatchObject({
      code: "message_direction_mismatch",
      messageType: "server.command",
    });
    expect(diagnostic?.message).toContain("Hub → runtime");
  });

  it("surfaces bounded schema issues with JSON paths", () => {
    const diagnostic = diagnoseRuntimeProtocolMessage(
      {
        ...runtimeHello(),
        payload: {
          runtimeId: "not-a-runtime-id",
          runtimeVersion: "",
          supportedFeatures: [],
          workspaceBindings: [],
        },
      },
      runtimeBoundary,
    );

    expect(diagnostic).toMatchObject({
      code: "invalid_message_schema",
      messageType: "runtime.hello",
    });
    expect(diagnostic?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.payload.runtimeId" }),
        expect.objectContaining({ path: "$.payload.runtimeVersion" }),
      ]),
    );
    expect(diagnostic?.message).toContain("$.payload.runtimeId");
  });

  it("turns malformed JSON into the same diagnostic error contract", () => {
    expect(() => parseRuntimeProtocolJson('{"type":', runtimeBoundary)).toThrowError(
      SparkRuntimeProtocolDiagnosticError,
    );
    try {
      parseRuntimeProtocolJson('{"type":', runtimeBoundary);
    } catch (error) {
      expect(error).toBeInstanceOf(SparkRuntimeProtocolDiagnosticError);
      if (!(error instanceof SparkRuntimeProtocolDiagnosticError)) return;
      expect(error.code).toBe("invalid_json");
      expect(error.message).toContain("Hub runtime WebSocket");
      expect(error.message).toContain("Action:");
    }
  });

  it("formalizes server acknowledgements and errors used by both endpoints", () => {
    expect(
      serverIngestAckEnvelopeSchema.safeParse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.ingest_ack",
        sentAt: "2026-08-04T00:00:00.000Z",
        ackOf: createId("msg"),
        payload: { accepted: true, receivedType: "daemon.event" },
      }).success,
    ).toBe(true);

    expect(
      serverErrorEnvelopeSchema.safeParse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.error",
        sentAt: "2026-08-04T00:00:00.000Z",
        payload: {
          code: "protocol_version_mismatch",
          message: "runtime and Hub versions differ",
          action: "upgrade both components",
          details: { expectedProtocolVersion: runtimeProtocolVersion },
        },
      }).success,
    ).toBe(true);
  });
});
