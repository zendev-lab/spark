import {
  assertRuntimeProtocolMessage,
  parseRuntimeProtocolJson,
  serverErrorEnvelopeSchema,
} from "@zendev-lab/spark-protocol/runtime";

const hubToRuntimeBoundary = {
  direction: "server-to-runtime" as const,
  boundary: "spark-daemon Hub WebSocket",
};

export class SparkHubRuntimeError extends Error {
  readonly code: string;
  readonly action: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(input: {
    code: string;
    message: string;
    action?: string;
    details?: Record<string, unknown>;
  }) {
    const action =
      input.action && !input.message.includes("Action:") ? ` Action: ${input.action}` : "";
    super(`Spark Hub runtime error [${input.code}]: ${input.message}${action}`);
    this.name = "SparkHubRuntimeError";
    this.code = input.code;
    this.action = input.action;
    this.details = input.details;
  }
}

export function parseHubRuntimeMessage(raw: string): unknown {
  const value = parseRuntimeProtocolJson(raw, hubToRuntimeBoundary);
  assertRuntimeProtocolMessage(value, hubToRuntimeBoundary);

  const serverError = serverErrorEnvelopeSchema.safeParse(value);
  if (serverError.success) {
    throw new SparkHubRuntimeError(serverError.data.payload);
  }
  return value;
}
