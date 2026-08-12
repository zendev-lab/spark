import type { SparkJsonValue } from "@zendev-lab/spark-protocol/presentation";

export const EXECUTION_ATTEMPT_PROTOCOL_VERSION = 1 as const;
export const MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES = 64 * 1024;
export const MAX_EXECUTION_ATTEMPT_JSON_DEPTH = 64;
export const MAX_EXECUTION_ATTEMPT_JSON_NODES = 4_096;

export type ExecutionAttemptMessageType =
  | "accepted"
  | "running"
  | "event"
  | "usage"
  | "capability_request"
  | "terminal";

export interface ExecutionAttemptIdentity {
  invocationId: string;
  attemptEpoch: number;
  daemonGeneration: number;
}

interface ExecutionAttemptEnvelopeBase extends ExecutionAttemptIdentity {
  version: typeof EXECUTION_ATTEMPT_PROTOCOL_VERSION;
  type: ExecutionAttemptMessageType;
  sequence: number;
  correlationId: string;
}

export type ExecutionAttemptEnvelope =
  | (ExecutionAttemptEnvelopeBase & { type: "accepted"; acceptedAt: string })
  | (ExecutionAttemptEnvelopeBase & { type: "running"; startedAt: string })
  | (ExecutionAttemptEnvelopeBase & {
      type: "event";
      eventSequence: number;
      event: SparkJsonValue;
    })
  | (ExecutionAttemptEnvelopeBase & {
      type: "usage";
      usageSequence: number;
      usage: SparkJsonValue;
    })
  | (ExecutionAttemptEnvelopeBase & {
      type: "capability_request";
      operation: string;
      request: SparkJsonValue;
    })
  | (ExecutionAttemptEnvelopeBase & {
      type: "terminal";
      status: "succeeded" | "failed" | "cancelled";
      eventHighWaterMark: number;
      usageHighWaterMark: number;
      result?: SparkJsonValue;
    });

export type ExecutionAttemptProtocolErrorCode =
  | "execution_attempt_payload_too_large"
  | "execution_attempt_invalid_json"
  | "execution_attempt_invalid_payload"
  | "execution_attempt_unsupported_version"
  | "execution_attempt_unknown_type"
  | "execution_attempt_identity_invalid"
  | "execution_attempt_correlation_mismatch"
  | "execution_attempt_stale"
  | "execution_attempt_sequence_replayed"
  | "execution_attempt_sequence_invalid"
  | "execution_attempt_transition_invalid"
  | "execution_attempt_high_water_invalid"
  | "execution_attempt_terminal_committed";

export class ExecutionAttemptProtocolError extends Error {
  readonly code: ExecutionAttemptProtocolErrorCode;

  constructor(code: ExecutionAttemptProtocolErrorCode, message: string) {
    super(message);
    this.name = "ExecutionAttemptProtocolError";
    this.code = code;
  }
}

export type ExecutionAttemptProtocolResult =
  | { status: "accepted" | "running" | "recorded" | "capability_requested" }
  | { status: "terminal_pending"; eventHighWaterMark: number; usageHighWaterMark: number }
  | {
      status: "terminal_committed";
      terminal: Extract<ExecutionAttemptEnvelope, { type: "terminal" }>;
    };

export function parseExecutionAttemptEnvelope(value: unknown): ExecutionAttemptEnvelope {
  let parsed: unknown;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_payload_too_large",
        "execution attempt envelope exceeds the maximum payload size",
      );
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_invalid_json",
        "execution attempt envelope is not valid JSON",
      );
    }
  } else {
    assertJsonValue(value);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_payload_too_large",
        "execution attempt envelope exceeds the maximum payload size",
      );
    }
    parsed = value;
  }

  const envelope = recordValue(parsed);
  if (envelope.version !== EXECUTION_ATTEMPT_PROTOCOL_VERSION) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_unsupported_version",
      `execution_attempt_unsupported_version received ${String(envelope.version)} at the daemon execution-attempt boundary; supported version is ${EXECUTION_ATTEMPT_PROTOCOL_VERSION}; update the worker and daemon to matching builds before retrying`,
    );
  }
  const type = stringValue(envelope.type, "type");
  if (!isExecutionAttemptMessageType(type)) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_unknown_type",
      `unknown execution attempt message type: ${type}`,
    );
  }
  const identity = {
    invocationId: identifierValue(envelope.invocationId, "invocationId"),
    attemptEpoch: positiveInteger(envelope.attemptEpoch, "attemptEpoch"),
    daemonGeneration: positiveInteger(envelope.daemonGeneration, "daemonGeneration"),
  };
  const base = {
    version: EXECUTION_ATTEMPT_PROTOCOL_VERSION,
    type,
    ...identity,
    sequence: positiveInteger(envelope.sequence, "sequence"),
    correlationId: identifierValue(envelope.correlationId, "correlationId"),
  };
  switch (type) {
    case "accepted":
      return { ...base, type, acceptedAt: timestampValue(envelope.acceptedAt, "acceptedAt") };
    case "running":
      return { ...base, type, startedAt: timestampValue(envelope.startedAt, "startedAt") };
    case "event":
      return {
        ...base,
        type,
        eventSequence: positiveInteger(envelope.eventSequence, "eventSequence"),
        event: jsonValue(envelope.event, "event"),
      };
    case "usage":
      return {
        ...base,
        type,
        usageSequence: positiveInteger(envelope.usageSequence, "usageSequence"),
        usage: jsonValue(envelope.usage, "usage"),
      };
    case "capability_request":
      return {
        ...base,
        type,
        operation: identifierValue(envelope.operation, "operation"),
        request: jsonValue(envelope.request, "request"),
      };
    case "terminal": {
      const status = stringValue(envelope.status, "status");
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
        invalidPayload(`invalid terminal status: ${status}`);
      }
      return {
        ...base,
        type,
        status,
        eventHighWaterMark: nonNegativeInteger(envelope.eventHighWaterMark, "eventHighWaterMark"),
        usageHighWaterMark: nonNegativeInteger(envelope.usageHighWaterMark, "usageHighWaterMark"),
        ...(envelope.result === undefined ? {} : { result: jsonValue(envelope.result, "result") }),
      };
    }
    default:
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_unknown_type",
        "execution attempt message type is not handled",
      );
  }
}

/** Validate and detach one worker-facing JSON value with the envelope limits. */
export function cloneExecutionAttemptPayload(value: unknown, path = "payload"): SparkJsonValue {
  assertJsonValue(value, path);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_EXECUTION_ATTEMPT_ENVELOPE_BYTES) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_payload_too_large",
      "execution attempt payload exceeds the maximum envelope size",
    );
  }
  return JSON.parse(encoded) as SparkJsonValue;
}

export class ExecutionAttemptProtocolFence {
  readonly identity: ExecutionAttemptIdentity;
  readonly correlationId: string;
  #phase: "queued" | "accepted" | "running" | "terminal" = "queued";
  #nextSequence = 1;
  #eventHighWaterMark = 0;
  #usageHighWaterMark = 0;
  #ackedEventHighWaterMark = 0;
  #ackedUsageHighWaterMark = 0;
  #pendingTerminal: Extract<ExecutionAttemptEnvelope, { type: "terminal" }> | undefined;
  #committedTerminal: Extract<ExecutionAttemptEnvelope, { type: "terminal" }> | undefined;

  constructor(identity: ExecutionAttemptIdentity, correlationId: string) {
    assertIdentity(identity);
    this.identity = { ...identity };
    this.correlationId = identifierValue(correlationId, "correlationId");
  }

  phase(): "queued" | "accepted" | "running" | "terminal" {
    return this.#phase;
  }

  process(value: unknown): ExecutionAttemptProtocolResult {
    if (this.#pendingTerminal || this.#committedTerminal) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_terminal_committed",
        "execution attempt already received a terminal message",
      );
    }
    const envelope = parseExecutionAttemptEnvelope(value);
    this.#assertCorrelation(envelope);
    this.#assertSequence(envelope.sequence);
    switch (envelope.type) {
      case "accepted":
        this.#requirePhase("queued", envelope.type);
        this.#phase = "accepted";
        return this.#acceptSequence({ status: "accepted" });
      case "running":
        this.#requirePhase("accepted", envelope.type);
        this.#phase = "running";
        return this.#acceptSequence({ status: "running" });
      case "event":
        this.#requireActive(envelope.type);
        if (envelope.eventSequence !== this.#eventHighWaterMark + 1) {
          throw new ExecutionAttemptProtocolError(
            "execution_attempt_sequence_invalid",
            "event sequence must increase by exactly one",
          );
        }
        this.#eventHighWaterMark = envelope.eventSequence;
        return this.#acceptSequence({ status: "recorded" });
      case "usage":
        this.#requireActive(envelope.type);
        if (envelope.usageSequence !== this.#usageHighWaterMark + 1) {
          throw new ExecutionAttemptProtocolError(
            "execution_attempt_sequence_invalid",
            "usage sequence must increase by exactly one",
          );
        }
        this.#usageHighWaterMark = envelope.usageSequence;
        return this.#acceptSequence({ status: "recorded" });
      case "capability_request":
        this.#requireActive(envelope.type);
        return this.#acceptSequence({ status: "capability_requested" });
      case "terminal":
        this.#requireActive(envelope.type);
        if (
          envelope.eventHighWaterMark !== this.#eventHighWaterMark ||
          envelope.usageHighWaterMark !== this.#usageHighWaterMark
        ) {
          throw new ExecutionAttemptProtocolError(
            "execution_attempt_high_water_invalid",
            "terminal high-water marks must match the observed event and usage sequences",
          );
        }
        this.#pendingTerminal = envelope;
        this.#phase = "terminal";
        return this.#acceptSequence(this.#tryCommitTerminal());
      default:
        throw new ExecutionAttemptProtocolError(
          "execution_attempt_unknown_type",
          "execution attempt message type is not handled",
        );
    }
  }

  acknowledgeEvent(sequence: number): ExecutionAttemptProtocolResult | undefined {
    this.#ackedEventHighWaterMark = this.#acknowledge(
      sequence,
      this.#eventHighWaterMark,
      this.#ackedEventHighWaterMark,
      "event",
    );
    return this.#pendingTerminal ? this.#tryCommitTerminal() : undefined;
  }

  acknowledgeUsage(sequence: number): ExecutionAttemptProtocolResult | undefined {
    this.#ackedUsageHighWaterMark = this.#acknowledge(
      sequence,
      this.#usageHighWaterMark,
      this.#ackedUsageHighWaterMark,
      "usage",
    );
    return this.#pendingTerminal ? this.#tryCommitTerminal() : undefined;
  }

  terminal(): Extract<ExecutionAttemptEnvelope, { type: "terminal" }> | undefined {
    return this.#committedTerminal;
  }

  #assertCorrelation(envelope: ExecutionAttemptEnvelope): void {
    if (envelope.invocationId !== this.identity.invocationId) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_correlation_mismatch",
        "execution attempt invocation correlation does not match",
      );
    }
    if (
      envelope.attemptEpoch !== this.identity.attemptEpoch ||
      envelope.daemonGeneration !== this.identity.daemonGeneration
    ) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_stale",
        "execution attempt epoch or daemon generation is stale",
      );
    }
    if (envelope.correlationId !== this.correlationId) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_correlation_mismatch",
        "execution attempt correlationId does not match",
      );
    }
  }

  #assertSequence(sequence: number): void {
    if (sequence < this.#nextSequence) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_sequence_replayed",
        "execution attempt message sequence was replayed",
      );
    }
    if (sequence > this.#nextSequence) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_sequence_invalid",
        "execution attempt message sequence skipped a value",
      );
    }
  }

  #acceptSequence<T extends ExecutionAttemptProtocolResult>(result: T): T {
    this.#nextSequence += 1;
    return result;
  }

  #requirePhase(
    expected: "queued" | "accepted" | "running" | "terminal",
    messageType: string,
  ): void {
    if (this.#phase !== expected) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_transition_invalid",
        `${messageType} is invalid while the attempt is ${this.#phase}`,
      );
    }
  }

  #requireActive(messageType: string): void {
    if (this.#phase !== "accepted" && this.#phase !== "running") {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_transition_invalid",
        `${messageType} requires an accepted or running attempt`,
      );
    }
  }

  #acknowledge(sequence: number, observed: number, acknowledged: number, kind: string): number {
    if (!Number.isSafeInteger(sequence) || sequence < acknowledged || sequence > observed) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_high_water_invalid",
        `${kind} acknowledgement is outside the observed high-water range`,
      );
    }
    return sequence;
  }

  #tryCommitTerminal(): ExecutionAttemptProtocolResult {
    const terminal = this.#pendingTerminal;
    if (!terminal) {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_transition_invalid",
        "no terminal message is pending",
      );
    }
    if (
      this.#ackedEventHighWaterMark < terminal.eventHighWaterMark ||
      this.#ackedUsageHighWaterMark < terminal.usageHighWaterMark
    ) {
      return {
        status: "terminal_pending",
        eventHighWaterMark: terminal.eventHighWaterMark,
        usageHighWaterMark: terminal.usageHighWaterMark,
      };
    }
    this.#pendingTerminal = undefined;
    this.#committedTerminal = terminal;
    return { status: "terminal_committed", terminal };
  }
}

function assertIdentity(identity: ExecutionAttemptIdentity): void {
  identifierValue(identity.invocationId, "invocationId");
  positiveInteger(identity.attemptEpoch, "attemptEpoch");
  positiveInteger(identity.daemonGeneration, "daemonGeneration");
}

function assertJsonValue(value: unknown, path = "envelope"): asserts value is SparkJsonValue {
  type PendingEntry =
    | { kind: "visit"; value: unknown; path: string; depth: number }
    | { kind: "leave"; value: object };
  const pending: PendingEntry[] = [{ kind: "visit", value, path, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === "leave") {
      ancestors.delete(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_EXECUTION_ATTEMPT_JSON_NODES) {
      invalidPayload(`${path} exceeds the execution attempt JSON node limit`);
    }
    if (current.depth > MAX_EXECUTION_ATTEMPT_JSON_DEPTH) {
      invalidPayload(`${current.path} exceeds the execution attempt JSON depth limit`);
    }
    const entry = current.value;
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue;
    }
    if (!entry || typeof entry !== "object") {
      invalidPayload(`${current.path} is not JSON/structured-clone safe`);
    }
    if (ancestors.has(entry)) invalidPayload(`${current.path} contains a cyclic object reference`);
    ancestors.add(entry);
    pending.push({ kind: "leave", value: entry });
    if (Array.isArray(entry)) {
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        if (entry[index] === undefined) {
          invalidPayload(`${current.path}[${index}] cannot be undefined`);
        }
        pending.push({
          kind: "visit",
          value: entry[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype) {
      invalidPayload(`${current.path} is not JSON/structured-clone safe`);
    }
    for (const [key, child] of Object.entries(entry as Record<string, unknown>).toReversed()) {
      // JSON.stringify omits undefined object fields. Keep that established task
      // compatibility while rejecting undefined array entries, which serialize
      // as a semantically different null value.
      if (child === undefined) continue;
      if (isForbiddenExecutionPayloadKey(key)) {
        invalidPayload(`${current.path}.${key} is forbidden in execution attempt messages`);
      }
      pending.push({
        kind: "visit",
        value: child,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
}

const FORBIDDEN_EXECUTION_PAYLOAD_KEY_SEGMENTS = new Set([
  "auth",
  "authentication",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "databasesync",
  "env",
  "environment",
  "jwt",
  "password",
  "passphrase",
  "pat",
  "secret",
  "signal",
  "token",
  "tokens",
]);

const ALLOWED_EXECUTION_TOKEN_ACCOUNTING_KEYS = new Set([
  "cachereadtokens",
  "cachewritetokens",
  "inputtokens",
  "outputtokens",
  "providertotaltokens",
  "reasoningtokens",
  "totaltokens",
  "contexttokens",
  "contexttokensource",
  "latestcontexttokens",
  "latestcontexttokensource",
  "latestreportedcontexttokens",
  "tokenbreakdown",
  "tokenbudget",
  "tokenusage",
  "tokenusagebypersistence",
]);

const FORBIDDEN_EXECUTION_PAYLOAD_KEYS = new Set([
  "accesskey",
  "apikey",
  "authheader",
  "authorization",
  "authorizationheader",
  "bearer",
  "clientauth",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "databasesync",
  "devicecode",
  "encryptionkey",
  "environment",
  "environmentvariables",
  "envvars",
  "githubpat",
  "jwt",
  "oauthcode",
  "oauthresponse",
  "passphrase",
  "password",
  "privatekey",
  "processenv",
  "refreshtoken",
  "secret",
  "sessioncookie",
  "signingkey",
  "sshkey",
  "token",
]);

function isForbiddenExecutionPayloadKey(key: string): boolean {
  const segments =
    key
      .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
      .match(/[A-Za-z0-9]+/gu)
      ?.map((segment) => segment.toLowerCase()) ?? [];
  const normalized = segments.join("");
  if (normalized === "authority" || normalized === "authorities") return false;
  if (ALLOWED_EXECUTION_TOKEN_ACCOUNTING_KEYS.has(normalized)) return false;
  if (FORBIDDEN_EXECUTION_PAYLOAD_KEYS.has(normalized)) return true;
  if (segments.some((segment) => FORBIDDEN_EXECUTION_PAYLOAD_KEY_SEGMENTS.has(segment))) {
    return true;
  }
  if (
    segments.includes("key") &&
    segments.some((segment) =>
      ["api", "auth", "encryption", "private", "secret", "signing", "ssh"].includes(segment),
    )
  ) {
    return true;
  }
  return normalized.endsWith("token") || normalized.endsWith("tokens");
}

function recordValue(value: unknown): Record<string, unknown> {
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidPayload("execution attempt envelope must be an object");
  }
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown, field: string): SparkJsonValue {
  if (value === undefined) invalidPayload(`${field} is required`);
  assertJsonValue(value, field);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalidPayload(`${field} is invalid`);
  return value;
}

function identifierValue(value: unknown, field: string): string {
  const identifier = stringValue(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(identifier)) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_identity_invalid",
      `${field} is not a bounded identifier`,
    );
  }
  return identifier;
}

function timestampValue(value: unknown, field: string): string {
  const timestamp = stringValue(value, field);
  if (Number.isNaN(Date.parse(timestamp))) invalidPayload(`${field} is not an ISO timestamp`);
  return timestamp;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_identity_invalid",
      `${field} must be a positive integer`,
    );
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidPayload(`${field} is invalid`);
  return value as number;
}

function invalidPayload(message: string): never {
  throw new ExecutionAttemptProtocolError("execution_attempt_invalid_payload", message);
}

function isExecutionAttemptMessageType(value: string): value is ExecutionAttemptMessageType {
  return ["accepted", "running", "event", "usage", "capability_request", "terminal"].includes(
    value,
  );
}
