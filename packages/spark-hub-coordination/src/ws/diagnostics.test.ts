import { describe, expect, it } from "vitest";
import { createId } from "@zendev-lab/spark-protocol/domain";
import {
  runtimeProtocolVersion,
  serverErrorEnvelopeSchema,
} from "@zendev-lab/spark-protocol/runtime";
import type { RawData } from "ws";

import {
  parseRuntimeWebSocketMessage,
  sendRuntimeProtocolDiagnostic,
  shouldCloseForRuntimeProtocolDiagnostic,
} from "./diagnostics.ts";

class CapturingSocket {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }
}

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

function parse(value: unknown) {
  return parseRuntimeWebSocketMessage(
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) as RawData,
  );
}

describe("Hub runtime WebSocket diagnostics", () => {
  it("accepts a valid runtime-to-Hub message", () => {
    const hello = runtimeHello();
    expect(parse(hello)).toEqual({ ok: true, value: hello });
  });

  it("returns exact versions, message type, and operator action", () => {
    const parsed = parse({ ...runtimeHello(), protocolVersion: "spark.runtime.v0" });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic).toMatchObject({
      code: "protocol_version_mismatch",
      boundary: "Hub runtime WebSocket",
      direction: "runtime-to-server",
      expectedProtocolVersion: runtimeProtocolVersion,
      receivedProtocolVersion: '"spark.runtime.v0"',
      messageType: "runtime.hello",
    });
    expect(parsed.diagnostic.action).toContain(
      "Upgrade and restart Spark Hub and spark-daemon from the same Spark release",
    );
    expect(shouldCloseForRuntimeProtocolDiagnostic(parsed.diagnostic)).toBe(true);
  });

  it("reports malformed JSON without exposing an unstructured SyntaxError", () => {
    const parsed = parse('{"type":');

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic).toMatchObject({
      code: "invalid_json",
      boundary: "Hub runtime WebSocket",
      direction: "runtime-to-server",
    });
    expect(parsed.diagnostic.message).toContain("Invalid Spark runtime protocol JSON");
    expect(parsed.diagnostic.action).toContain("fix JSON serialization");
    expect(shouldCloseForRuntimeProtocolDiagnostic(parsed.diagnostic)).toBe(true);
  });

  it("distinguishes the wrong direction from an unknown type", () => {
    const parsed = parse({
      protocolVersion: runtimeProtocolVersion,
      messageId: createId("msg"),
      type: "server.command",
      sentAt: "2026-08-04T00:00:00.000Z",
      payload: {},
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic).toMatchObject({
      code: "message_direction_mismatch",
      messageType: "server.command",
    });
    expect(parsed.diagnostic.message).toContain("Hub → runtime");
  });

  it("surfaces invalid known-message fields as JSON paths", () => {
    const parsed = parse({
      ...runtimeHello(),
      payload: {
        runtimeId: "wrong-prefix",
        runtimeVersion: "",
        supportedFeatures: [],
        workspaceBindings: [],
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostic).toMatchObject({
      code: "invalid_message_schema",
      messageType: "runtime.hello",
    });
    expect(parsed.diagnostic.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.payload.runtimeId" }),
        expect.objectContaining({ path: "$.payload.runtimeVersion" }),
      ]),
    );
    expect(shouldCloseForRuntimeProtocolDiagnostic(parsed.diagnostic)).toBe(false);
  });

  it("serializes diagnostics through the formal server.error envelope", () => {
    const parsed = parse({ ...runtimeHello(), protocolVersion: "spark.runtime.v0" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const socket = new CapturingSocket();

    sendRuntimeProtocolDiagnostic(socket, parsed.diagnostic);

    const error = serverErrorEnvelopeSchema.parse(JSON.parse(socket.sent[0] ?? "{}"));
    expect(error.payload).toMatchObject({
      code: "protocol_version_mismatch",
      action: parsed.diagnostic.action,
      details: {
        boundary: "Hub runtime WebSocket",
        direction: "runtime-to-server",
        expectedProtocolVersion: runtimeProtocolVersion,
        receivedProtocolVersion: '"spark.runtime.v0"',
        messageType: "runtime.hello",
      },
    });
    expect(error.payload.message).toContain("Action:");
  });
});
