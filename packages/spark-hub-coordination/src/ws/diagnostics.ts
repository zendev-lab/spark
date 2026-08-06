import {
  createId,
  diagnoseRuntimeProtocolMessage,
  formatRuntimeProtocolDiagnostic,
  invalidRuntimeProtocolJsonDiagnostic,
  runtimeProtocolDiagnosticDetails,
  runtimeProtocolVersion,
  serverErrorEnvelopeSchema,
  type RuntimeProtocolDiagnostic,
} from "@zendev-lab/spark-protocol";
import type { RawData } from "ws";

const runtimeToHubBoundary = {
  direction: "runtime-to-server" as const,
  boundary: "Hub runtime WebSocket",
};

const fatalRuntimeProtocolDiagnosticCodes: ReadonlySet<RuntimeProtocolDiagnostic["code"]> = new Set(
  [
    "invalid_json",
    "invalid_envelope",
    "missing_protocol_version",
    "protocol_version_mismatch",
    "missing_message_type",
    "message_direction_mismatch",
  ],
);

interface RuntimeProtocolDiagnosticSender {
  send(data: string): unknown;
}

export type RuntimeWebSocketParseResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostic: RuntimeProtocolDiagnostic };

export function parseRuntimeWebSocketMessage(data: RawData): RuntimeWebSocketParseResult {
  let value: unknown;
  try {
    value = JSON.parse(rawDataToText(data)) as unknown;
  } catch (error) {
    return {
      ok: false,
      diagnostic: invalidRuntimeProtocolJsonDiagnostic(error, runtimeToHubBoundary),
    };
  }

  const diagnostic = diagnoseRuntimeProtocolMessage(value, runtimeToHubBoundary);
  return diagnostic ? { ok: false, diagnostic } : { ok: true, value };
}

export function sendRuntimeProtocolDiagnostic(
  ws: RuntimeProtocolDiagnosticSender,
  diagnostic: RuntimeProtocolDiagnostic,
): void {
  ws.send(
    JSON.stringify(
      serverErrorEnvelopeSchema.parse({
        protocolVersion: runtimeProtocolVersion,
        messageId: createId("msg"),
        type: "server.error",
        sentAt: new Date().toISOString(),
        payload: {
          code: diagnostic.code,
          message: formatRuntimeProtocolDiagnostic(diagnostic),
          action: diagnostic.action,
          details: runtimeProtocolDiagnosticDetails(diagnostic),
        },
      }),
    ),
  );
}

export function shouldCloseForRuntimeProtocolDiagnostic(
  diagnostic: RuntimeProtocolDiagnostic,
): boolean {
  return fatalRuntimeProtocolDiagnosticCodes.has(diagnostic.code);
}

function rawDataToText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
