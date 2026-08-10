import type {
  ExtensionAskFlowInteractionRequest,
  ExtensionAskFlowInteractionResponse,
  ExtensionInteractionCapabilities,
  ExtensionInteractionResponse,
  SparkHostContext,
} from "@zendev-lab/spark-core";
import {
  parseSparkAskAcknowledgement,
  parseSparkInteractionCapabilities,
  type SparkAskAcknowledgement,
} from "@zendev-lab/spark-protocol";

export type { SparkAskAcknowledgement } from "@zendev-lab/spark-protocol";

export type SparkAskTransportErrorCode =
  | "ASK_TRANSPORT_UNAVAILABLE"
  | "ASK_TRANSPORT_CAPABILITY_MISMATCH"
  | "ASK_TRANSPORT_REJECTED"
  | "ASK_TRANSPORT_PROTOCOL_ERROR"
  | "ASK_TRANSPORT_FAILED";

export class SparkAskTransportError extends Error {
  readonly code: SparkAskTransportErrorCode;

  constructor(code: SparkAskTransportErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "SparkAskTransportError";
    this.code = code;
  }
}

export type SparkCanonicalAskTransport = "protocol" | "legacy";

export function requireCanonicalAskTransport(
  ctx: SparkHostContext,
  input: { delivery: "blocking" | "async"; autoAnswer: boolean },
): SparkCanonicalAskTransport {
  const ui = ctx.ui;
  const interaction = ui?.interaction;
  if (typeof interaction !== "function") {
    if (input.delivery === "blocking" && !input.autoAnswer && hasLegacyInteraction(ctx)) {
      return "legacy";
    }
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_UNAVAILABLE",
      input.autoAnswer
        ? "reviewer takeover requires a timeout-capable human interaction transport"
        : `${input.delivery} Ask requires a host interaction transport`,
    );
  }

  const declared = ui?.interactionCapabilities;
  if (declared === undefined) {
    // Compatibility for older blocking-only hosts. Async acceptance and reviewer
    // takeover need an explicit declaration because they depend on ACK/timeout.
    if (input.delivery === "blocking" && !input.autoAnswer) return "protocol";
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      "host did not declare askFlow interaction capabilities",
    );
  }
  const capabilities = parseCapabilities(declared);
  const askFlow = capabilities.askFlow;
  if (!askFlow || !askFlow.deliveries.includes(input.delivery)) {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      `host does not support askFlow delivery=${input.delivery}`,
    );
  }
  if (askFlow.responseCorrelation !== "request_id") {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      "host does not guarantee request_id response correlation",
    );
  }
  if (input.delivery === "blocking" && !askFlow.timeout) {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      "blocking Ask requires a host-owned timeout capability",
    );
  }
  if (
    input.delivery === "async" &&
    askFlow.asyncAcknowledgement !== "pending_with_human_request_id"
  ) {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      "async Ask requires pending_with_human_request_id acknowledgement",
    );
  }
  return "protocol";
}

export async function dispatchAskFlowInteraction(
  interaction:
    | ((request: ExtensionAskFlowInteractionRequest) => Promise<ExtensionInteractionResponse>)
    | undefined,
  request: ExtensionAskFlowInteractionRequest,
): Promise<ExtensionAskFlowInteractionResponse | undefined> {
  if (!interaction) return undefined;
  let response: ExtensionInteractionResponse;
  try {
    response = await interaction(request);
  } catch (error) {
    if (error instanceof SparkAskTransportError) throw error;
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_FAILED",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (response.kind !== "askFlow") {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_PROTOCOL_ERROR",
      `expected askFlow response, received ${response.kind}`,
    );
  }
  if (response.requestId !== request.requestId) {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_PROTOCOL_ERROR",
      `response requestId=${response.requestId} does not match requestId=${request.requestId}`,
    );
  }
  if (response.status === "blocked" || response.status === "error") {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_REJECTED",
      response.message?.trim() || `host returned status=${response.status}`,
    );
  }
  const delivery = request.delivery ?? "blocking";
  if (delivery === "async") {
    if (response.status !== "pending" || !nonEmptyString(response.humanRequestId)) {
      throw new SparkAskTransportError(
        "ASK_TRANSPORT_PROTOCOL_ERROR",
        "async Ask must return status=pending with a durable humanRequestId acknowledgement",
      );
    }
  } else if (response.status === "pending") {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_PROTOCOL_ERROR",
      "blocking Ask cannot return a pending acknowledgement",
    );
  }
  return response;
}

export function askAcknowledgement(
  request: ExtensionAskFlowInteractionRequest,
  response: ExtensionAskFlowInteractionResponse,
): SparkAskAcknowledgement | undefined {
  if (response.status !== "pending" || !nonEmptyString(response.humanRequestId)) return undefined;
  return parseSparkAskAcknowledgement({
    schema: "spark.ask-ack/v1",
    interactionRequestId: request.requestId,
    humanRequestId: response.humanRequestId.trim(),
  });
}

function parseCapabilities(value: unknown): ExtensionInteractionCapabilities {
  try {
    return parseSparkInteractionCapabilities(value);
  } catch (error) {
    throw new SparkAskTransportError(
      "ASK_TRANSPORT_CAPABILITY_MISMATCH",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function hasLegacyInteraction(ctx: SparkHostContext): boolean {
  const ui = ctx.ui;
  return Boolean(
    ui &&
    (typeof ui.select === "function" ||
      typeof ui.selectWithCustom === "function" ||
      typeof ui.input === "function" ||
      typeof ui.custom === "function"),
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
