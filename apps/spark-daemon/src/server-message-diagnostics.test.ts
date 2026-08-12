import { describe, expect, it } from "vitest";
import { createId } from "@zendev-lab/spark-protocol/domain";
import {
  runtimeProtocolVersion,
  SparkRuntimeProtocolDiagnosticError,
} from "@zendev-lab/spark-protocol/runtime";

import { parseHubRuntimeMessage, SparkHubRuntimeError } from "./server-message-diagnostics.ts";

function helloAck() {
  return {
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "server.hello_ack" as const,
    sentAt: "2026-08-04T00:00:00.000Z",
    payload: {
      runtimeSessionId: createId("rtsn"),
      acceptedFeatures: [],
      heartbeatIntervalMs: 15_000 as const,
      serverTime: "2026-08-04T00:00:00.000Z",
      workspaceBindingAssignments: [],
    },
  };
}

describe("spark-daemon Hub WebSocket diagnostics", () => {
  it("accepts a valid Hub-to-runtime message", () => {
    const message = helloAck();
    expect(parseHubRuntimeMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects malformed JSON with the boundary and recovery action", () => {
    expect(() => parseHubRuntimeMessage('{"type":')).toThrowError(
      SparkRuntimeProtocolDiagnosticError,
    );
    try {
      parseHubRuntimeMessage('{"type":');
    } catch (error) {
      expect(error).toBeInstanceOf(SparkRuntimeProtocolDiagnosticError);
      if (!(error instanceof SparkRuntimeProtocolDiagnosticError)) return;
      expect(error.diagnostic).toMatchObject({
        code: "invalid_json",
        boundary: "spark-daemon Hub WebSocket",
        direction: "server-to-runtime",
      });
      expect(error.message).toContain("Action:");
    }
  });

  it("reports exact received and supported protocol versions", () => {
    try {
      parseHubRuntimeMessage(
        JSON.stringify({ ...helloAck(), protocolVersion: "spark.runtime.v0" }),
      );
      throw new Error("expected protocol mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SparkRuntimeProtocolDiagnosticError);
      if (!(error instanceof SparkRuntimeProtocolDiagnosticError)) return;
      expect(error.diagnostic).toMatchObject({
        code: "protocol_version_mismatch",
        messageType: "server.hello_ack",
        receivedProtocolVersion: '"spark.runtime.v0"',
        expectedProtocolVersion: runtimeProtocolVersion,
      });
      expect(error.diagnostic.action).toContain(
        "Upgrade and restart Spark Hub and spark-daemon from the same Spark release",
      );
    }
  });

  it("distinguishes a runtime-originated message sent in the wrong direction", () => {
    try {
      parseHubRuntimeMessage(
        JSON.stringify({
          protocolVersion: runtimeProtocolVersion,
          messageId: createId("msg"),
          type: "runtime.hello",
          sentAt: "2026-08-04T00:00:00.000Z",
          payload: {},
        }),
      );
      throw new Error("expected direction mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(SparkRuntimeProtocolDiagnosticError);
      if (!(error instanceof SparkRuntimeProtocolDiagnosticError)) return;
      expect(error.diagnostic).toMatchObject({
        code: "message_direction_mismatch",
        messageType: "runtime.hello",
      });
      expect(error.message).toContain("runtime → Hub");
    }
  });

  it("surfaces invalid known-message fields as JSON paths", () => {
    try {
      parseHubRuntimeMessage(
        JSON.stringify({
          ...helloAck(),
          payload: {
            ...helloAck().payload,
            runtimeSessionId: "wrong-prefix",
            heartbeatIntervalMs: 5,
          },
        }),
      );
      throw new Error("expected schema failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SparkRuntimeProtocolDiagnosticError);
      if (!(error instanceof SparkRuntimeProtocolDiagnosticError)) return;
      expect(error.diagnostic).toMatchObject({
        code: "invalid_message_schema",
        messageType: "server.hello_ack",
      });
      expect(error.diagnostic.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "$.payload.runtimeSessionId" }),
          expect.objectContaining({ path: "$.payload.heartbeatIntervalMs" }),
        ]),
      );
    }
  });

  it("turns a formal server.error frame into a typed daemon error", () => {
    const frame = {
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "server.error" as const,
      sentAt: "2026-08-04T00:00:00.000Z",
      payload: {
        code: "protocol_version_mismatch",
        message: "Hub rejected the runtime protocol version.",
        action: "Upgrade Hub and daemon together.",
        details: {
          receivedProtocolVersion: '"spark.runtime.v0"',
          expectedProtocolVersion: runtimeProtocolVersion,
        },
      },
    };

    expect(() => parseHubRuntimeMessage(JSON.stringify(frame))).toThrowError(SparkHubRuntimeError);
    try {
      parseHubRuntimeMessage(JSON.stringify(frame));
    } catch (error) {
      expect(error).toBeInstanceOf(SparkHubRuntimeError);
      if (!(error instanceof SparkHubRuntimeError)) return;
      expect(error).toMatchObject({
        code: "protocol_version_mismatch",
        action: "Upgrade Hub and daemon together.",
        details: frame.payload.details,
      });
      expect(error.message).toContain("Spark Hub runtime error [protocol_version_mismatch]");
      expect(error.message).toContain("Action: Upgrade Hub and daemon together.");
    }
  });
});
