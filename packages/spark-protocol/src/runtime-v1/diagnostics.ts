import { z } from "zod";
import { prefixedIdSchema } from "../refs.ts";
import { describeSparkProtocolValue, sparkProtocolVersionMismatch } from "../version.ts";
import { runtimeEnvelopeFor, runtimeProtocolVersion } from "./envelope.ts";
import {
  runtimeEphemeralSecretResultEnvelopeSchema,
  serverEphemeralSecretRequestEnvelopeSchema,
} from "./ephemeral-secret.ts";
import {
  artifactProjectionEnvelopeSchema,
  daemonEventEnvelopeSchema,
  humanRequestCreatedEnvelopeSchema,
  humanResponseAckEnvelopeSchema,
  humanResponseDeliverEnvelopeSchema,
  humanResponseRecordedEnvelopeSchema,
  invocationLogChunkEnvelopeSchema,
  invocationUpdateEnvelopeSchema,
  runtimeCommandAckEnvelopeSchema,
  runtimeCommandRejectEnvelopeSchema,
  runtimeCommandResultEnvelopeSchema,
  runtimeHeartbeatEnvelopeSchema,
  runtimeHelloEnvelopeSchema,
  runtimeReconcileReportEnvelopeSchema,
  runtimeReconcileRequestEnvelopeSchema,
  serverCommandEnvelopeSchema,
  serverHeartbeatAckEnvelopeSchema,
  serverHelloAckEnvelopeSchema,
  taskGraphSnapshotEnvelopeSchema,
  workspaceSnapshotEnvelopeSchema,
} from "./messages.ts";

export const runtimeProtocolDirectionOptions = ["runtime-to-server", "server-to-runtime"] as const;
export type RuntimeProtocolDirection = (typeof runtimeProtocolDirectionOptions)[number];

export const runtimeToServerMessageTypeOptions = [
  "runtime.hello",
  "runtime.heartbeat",
  "runtime.reconcile.report",
  "workspace.snapshot",
  "runtime.command.ack",
  "runtime.command.reject",
  "runtime.command.result",
  "runtime.ephemeral_secret.result",
  "human.request.created",
  "human.response.recorded",
  "human.response.ack",
  "task_graph.snapshot",
  "invocation.updated",
  "invocation.log_chunk",
  "daemon.event",
  "artifact.projected",
] as const;

export const serverToRuntimeMessageTypeOptions = [
  "server.hello_ack",
  "server.heartbeat_ack",
  "server.ingest_ack",
  "server.ephemeral_secret.request",
  "server.command",
  "human.response.deliver",
  "runtime.reconcile.request",
  "server.error",
] as const;

export type RuntimeToServerMessageType = (typeof runtimeToServerMessageTypeOptions)[number];
export type ServerToRuntimeMessageType = (typeof serverToRuntimeMessageTypeOptions)[number];

export const serverIngestAckEnvelopeSchema = runtimeEnvelopeFor(
  z.object({
    accepted: z.literal(true),
    receivedType: z.string().min(1),
  }),
).extend({
  type: z.literal("server.ingest_ack"),
  ackOf: prefixedIdSchema("msg"),
});

export const serverErrorEnvelopeSchema = runtimeEnvelopeFor(
  z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    action: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
).extend({
  type: z.literal("server.error"),
});

interface RuntimeSchemaIssue {
  path?: readonly PropertyKey[];
  message: string;
}

interface RuntimeMessageSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly RuntimeSchemaIssue[] } };
}

const runtimeToServerMessageSchemas: Record<RuntimeToServerMessageType, RuntimeMessageSchema> = {
  "runtime.hello": runtimeHelloEnvelopeSchema,
  "runtime.heartbeat": runtimeHeartbeatEnvelopeSchema,
  "runtime.reconcile.report": runtimeReconcileReportEnvelopeSchema,
  "workspace.snapshot": workspaceSnapshotEnvelopeSchema,
  "runtime.command.ack": runtimeCommandAckEnvelopeSchema,
  "runtime.command.reject": runtimeCommandRejectEnvelopeSchema,
  "runtime.command.result": runtimeCommandResultEnvelopeSchema,
  "runtime.ephemeral_secret.result": runtimeEphemeralSecretResultEnvelopeSchema,
  "human.request.created": humanRequestCreatedEnvelopeSchema,
  "human.response.recorded": humanResponseRecordedEnvelopeSchema,
  "human.response.ack": humanResponseAckEnvelopeSchema,
  "task_graph.snapshot": taskGraphSnapshotEnvelopeSchema,
  "invocation.updated": invocationUpdateEnvelopeSchema,
  "invocation.log_chunk": invocationLogChunkEnvelopeSchema,
  "daemon.event": daemonEventEnvelopeSchema,
  "artifact.projected": artifactProjectionEnvelopeSchema,
};

const serverToRuntimeMessageSchemas: Record<ServerToRuntimeMessageType, RuntimeMessageSchema> = {
  "server.hello_ack": serverHelloAckEnvelopeSchema,
  "server.heartbeat_ack": serverHeartbeatAckEnvelopeSchema,
  "server.ingest_ack": serverIngestAckEnvelopeSchema,
  "server.ephemeral_secret.request": serverEphemeralSecretRequestEnvelopeSchema,
  "server.command": serverCommandEnvelopeSchema,
  "human.response.deliver": humanResponseDeliverEnvelopeSchema,
  "runtime.reconcile.request": runtimeReconcileRequestEnvelopeSchema,
  "server.error": serverErrorEnvelopeSchema,
};

export const runtimeProtocolDiagnosticCodeOptions = [
  "invalid_json",
  "invalid_envelope",
  "missing_protocol_version",
  "protocol_version_mismatch",
  "missing_message_type",
  "message_direction_mismatch",
  "unsupported_message_type",
  "invalid_message_schema",
] as const;
export type RuntimeProtocolDiagnosticCode = (typeof runtimeProtocolDiagnosticCodeOptions)[number];

export interface RuntimeProtocolDiagnosticIssue {
  path: string;
  message: string;
}

export interface RuntimeProtocolDiagnostic {
  code: RuntimeProtocolDiagnosticCode;
  boundary: string;
  direction: RuntimeProtocolDirection;
  message: string;
  action: string;
  expectedProtocolVersion: string;
  receivedProtocolVersion?: string;
  messageType?: string;
  issues?: RuntimeProtocolDiagnosticIssue[];
}

export interface RuntimeProtocolDiagnosticOptions {
  direction: RuntimeProtocolDirection;
  /** Concrete transport/parser location, for example `Hub runtime WebSocket`. */
  boundary: string;
  /** Override only when the caller has a more precise recovery command. */
  action?: string;
}

export class SparkRuntimeProtocolDiagnosticError extends Error {
  readonly code: RuntimeProtocolDiagnosticCode;
  readonly diagnostic: RuntimeProtocolDiagnostic;

  constructor(diagnostic: RuntimeProtocolDiagnostic) {
    super(formatRuntimeProtocolDiagnostic(diagnostic));
    this.name = "SparkRuntimeProtocolDiagnosticError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

export function parseRuntimeProtocolJson(
  raw: string,
  options: RuntimeProtocolDiagnosticOptions,
): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SparkRuntimeProtocolDiagnosticError(
      invalidRuntimeProtocolJsonDiagnostic(error, options),
    );
  }
}

export function invalidRuntimeProtocolJsonDiagnostic(
  error: unknown,
  options: RuntimeProtocolDiagnosticOptions,
): RuntimeProtocolDiagnostic {
  const detail = conciseErrorMessage(error);
  return {
    code: "invalid_json",
    boundary: options.boundary,
    direction: options.direction,
    message: `Invalid Spark runtime protocol JSON at ${options.boundary} (${directionLabel(options.direction)}): ${detail}.`,
    action:
      options.action ??
      "Inspect the sender log for the original frame, fix JSON serialization, and retry without editing the frame by hand.",
    expectedProtocolVersion: runtimeProtocolVersion,
  };
}

export function diagnoseRuntimeProtocolMessage(
  value: unknown,
  options: RuntimeProtocolDiagnosticOptions,
): RuntimeProtocolDiagnostic | null {
  const action = options.action ?? defaultCompatibilityAction();
  if (!isRecord(value)) {
    return {
      code: "invalid_envelope",
      boundary: options.boundary,
      direction: options.direction,
      message: `Invalid Spark runtime protocol envelope at ${options.boundary} (${directionLabel(options.direction)}): expected a JSON object, received ${jsonKind(value)}.`,
      action: "Fix the sender to emit one JSON object per WebSocket message, then retry.",
      expectedProtocolVersion: runtimeProtocolVersion,
    };
  }

  const rawMessageType = typeof value.type === "string" ? value.type : undefined;
  const messageType = rawMessageType ? truncateDiagnosticText(rawMessageType) : undefined;
  if (!("protocolVersion" in value)) {
    return {
      code: "missing_protocol_version",
      boundary: options.boundary,
      direction: options.direction,
      message: `Spark runtime protocol envelope at ${options.boundary} (${directionLabel(options.direction)}) is missing protocolVersion${messageType ? ` for ${JSON.stringify(messageType)}` : ""}; this build accepts ${JSON.stringify(runtimeProtocolVersion)}.`,
      action,
      expectedProtocolVersion: runtimeProtocolVersion,
      ...(messageType ? { messageType } : {}),
    };
  }

  if (value.protocolVersion !== runtimeProtocolVersion) {
    const mismatch = sparkProtocolVersionMismatch("runtime", value.protocolVersion, {
      label: `${options.boundary} (${directionLabel(options.direction)})`,
      action,
    });
    return {
      code: "protocol_version_mismatch",
      boundary: options.boundary,
      direction: options.direction,
      message: `Spark runtime protocol mismatch at ${options.boundary} (${directionLabel(options.direction)})${messageType ? ` for ${JSON.stringify(messageType)}` : ""}: received ${mismatch.received}; this build accepts only ${mismatch.expected}.`,
      action: mismatch.action,
      expectedProtocolVersion: runtimeProtocolVersion,
      receivedProtocolVersion: mismatch.received,
      ...(messageType ? { messageType } : {}),
    };
  }

  if (!rawMessageType) {
    return {
      code: "missing_message_type",
      boundary: options.boundary,
      direction: options.direction,
      message: `Spark runtime protocol envelope at ${options.boundary} (${directionLabel(options.direction)}) has no non-empty string type.`,
      action: "Set the canonical message type for this protocol version and retry.",
      expectedProtocolVersion: runtimeProtocolVersion,
      receivedProtocolVersion: describeSparkProtocolValue(value.protocolVersion),
    };
  }
  const reportedMessageType = truncateDiagnosticText(rawMessageType);

  const expectedSchemas = schemasForDirection(options.direction);
  const oppositeSchemas = schemasForDirection(oppositeDirection(options.direction));
  if (Object.hasOwn(oppositeSchemas, rawMessageType)) {
    return {
      code: "message_direction_mismatch",
      boundary: options.boundary,
      direction: options.direction,
      message: `Spark runtime message direction mismatch at ${options.boundary}: received ${JSON.stringify(reportedMessageType)} on the ${directionLabel(options.direction)} path, but that type belongs to ${directionLabel(oppositeDirection(options.direction))}.`,
      action:
        "Check the WebSocket endpoint and sender dispatch table; do not route this message through the opposite direction.",
      expectedProtocolVersion: runtimeProtocolVersion,
      receivedProtocolVersion: describeSparkProtocolValue(value.protocolVersion),
      messageType: reportedMessageType,
    };
  }

  const schema = expectedSchemas[rawMessageType];
  if (!schema) {
    return {
      code: "unsupported_message_type",
      boundary: options.boundary,
      direction: options.direction,
      message: `Unsupported Spark runtime message type ${JSON.stringify(reportedMessageType)} at ${options.boundary} for protocol ${JSON.stringify(runtimeProtocolVersion)} on the ${directionLabel(options.direction)} path.`,
      action: `${action} If the builds already match, update the sender dispatch table to a supported type: ${messageTypesForDirection(options.direction).join(", ")}.`,
      expectedProtocolVersion: runtimeProtocolVersion,
      receivedProtocolVersion: describeSparkProtocolValue(value.protocolVersion),
      messageType: reportedMessageType,
    };
  }

  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues.slice(0, 5).map(runtimeDiagnosticIssue);
  const omitted = Math.max(parsed.error.issues.length - issues.length, 0);
  const issueSummary = issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
  return {
    code: "invalid_message_schema",
    boundary: options.boundary,
    direction: options.direction,
    message: `Invalid ${JSON.stringify(reportedMessageType)} Spark runtime message at ${options.boundary} for protocol ${JSON.stringify(runtimeProtocolVersion)}: ${issueSummary}${omitted > 0 ? `; ${omitted} additional issue(s) omitted` : ""}.`,
    action: `Fix the sender fields at the listed paths. ${action}`,
    expectedProtocolVersion: runtimeProtocolVersion,
    receivedProtocolVersion: describeSparkProtocolValue(value.protocolVersion),
    messageType: reportedMessageType,
    issues,
  };
}

export function assertRuntimeProtocolMessage(
  value: unknown,
  options: RuntimeProtocolDiagnosticOptions,
): void {
  const diagnostic = diagnoseRuntimeProtocolMessage(value, options);
  if (diagnostic) throw new SparkRuntimeProtocolDiagnosticError(diagnostic);
}

export function formatRuntimeProtocolDiagnostic(diagnostic: RuntimeProtocolDiagnostic): string {
  return `${diagnostic.message} Action: ${diagnostic.action}`;
}

export function runtimeProtocolDiagnosticDetails(
  diagnostic: RuntimeProtocolDiagnostic,
): Record<string, unknown> {
  return {
    boundary: diagnostic.boundary,
    direction: diagnostic.direction,
    expectedProtocolVersion: diagnostic.expectedProtocolVersion,
    ...(diagnostic.receivedProtocolVersion
      ? { receivedProtocolVersion: diagnostic.receivedProtocolVersion }
      : {}),
    ...(diagnostic.messageType ? { messageType: diagnostic.messageType } : {}),
    ...(diagnostic.issues ? { issues: diagnostic.issues } : {}),
  };
}

export function messageTypesForDirection(direction: RuntimeProtocolDirection): readonly string[] {
  return direction === "runtime-to-server"
    ? runtimeToServerMessageTypeOptions
    : serverToRuntimeMessageTypeOptions;
}

function schemasForDirection(
  direction: RuntimeProtocolDirection,
): Readonly<Record<string, RuntimeMessageSchema>> {
  return direction === "runtime-to-server"
    ? runtimeToServerMessageSchemas
    : serverToRuntimeMessageSchemas;
}

function oppositeDirection(direction: RuntimeProtocolDirection): RuntimeProtocolDirection {
  return direction === "runtime-to-server" ? "server-to-runtime" : "runtime-to-server";
}

function directionLabel(direction: RuntimeProtocolDirection): string {
  return direction === "runtime-to-server" ? "runtime → Hub" : "Hub → runtime";
}

function runtimeDiagnosticIssue(issue: RuntimeSchemaIssue): RuntimeProtocolDiagnosticIssue {
  return {
    path: formatIssuePath(issue.path ?? []),
    message: issue.message,
  };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "$";
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${segment}]`;
    const key = String(segment);
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
      ? `${formatted}.${key}`
      : `${formatted}[${JSON.stringify(key)}]`;
  }, "$");
}

function conciseErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]?.trim() || "unknown JSON parse failure";
  return firstLine.length <= 240 ? firstLine : `${firstLine.slice(0, 237)}...`;
}

function truncateDiagnosticText(value: string, limit = 160): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function defaultCompatibilityAction(): string {
  return "Upgrade and restart Spark Hub and spark-daemon from the same Spark release, then retry.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
