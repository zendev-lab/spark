import type { ExecutionAttemptIdentity } from "./contract.ts";
import { ExecutionAttemptProtocolError } from "./contract.ts";

export const EXECUTION_PARENT_CAPABILITIES = [
  "task.claim",
  "human.interaction",
  "loop.schedule",
  "loop.stop",
] as const;

export type ExecutionParentCapability = (typeof EXECUTION_PARENT_CAPABILITIES)[number];

export type ExecutionParentCapabilityErrorCode =
  | "execution_capability_registration_denied"
  | "execution_capability_denied"
  | "execution_capability_stale_attempt"
  | "execution_capability_correlation_mismatch"
  | "execution_capability_invalid_request";

export class ExecutionParentCapabilityError extends Error {
  readonly code: ExecutionParentCapabilityErrorCode;

  constructor(code: ExecutionParentCapabilityErrorCode, message: string) {
    super(message);
    this.name = "ExecutionParentCapabilityError";
    this.code = code;
  }
}

export interface ExecutionCapabilityRequest<T = unknown> {
  identity: ExecutionAttemptIdentity;
  correlationId: string;
  operation: string;
  request: T;
}

export interface ExecutionCapabilityDefinition<TResult = unknown> {
  operation: ExecutionParentCapability;
  validate(request: unknown): Record<string, unknown>;
  handle(
    request: Record<string, unknown>,
    context: { identity: ExecutionAttemptIdentity; signal?: AbortSignal },
  ): Promise<TResult>;
}

export class ExecutionCapabilityRegistry {
  readonly #definitions = new Map<ExecutionParentCapability, ExecutionCapabilityDefinition>();
  readonly #currentAttempt: (
    invocationId: string,
  ) => (ExecutionAttemptIdentity & { correlationId: string }) | undefined;

  constructor(options: {
    currentAttempt(
      invocationId: string,
    ): (ExecutionAttemptIdentity & { correlationId: string }) | undefined;
  }) {
    this.#currentAttempt = (invocationId) => options.currentAttempt(invocationId);
  }

  register(definition: ExecutionCapabilityDefinition): void {
    if (!isParentCapability(definition.operation)) {
      throw new ExecutionParentCapabilityError(
        "execution_capability_registration_denied",
        `execution parent capability cannot register ${String(definition.operation)}`,
      );
    }
    if (this.#definitions.has(definition.operation)) {
      throw new ExecutionParentCapabilityError(
        "execution_capability_registration_denied",
        `execution parent capability already registered: ${definition.operation}`,
      );
    }
    this.#definitions.set(definition.operation, definition);
  }

  operations(): ExecutionParentCapability[] {
    return [...this.#definitions.keys()].sort((left, right) => left.localeCompare(right));
  }

  async dispatch(
    request: ExecutionCapabilityRequest,
    parent: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const definition = this.#definitions.get(request.operation as ExecutionParentCapability);
    if (!definition) {
      throw new ExecutionParentCapabilityError(
        "execution_capability_denied",
        `execution parent capability is not registered: ${request.operation}`,
      );
    }
    const current = this.#currentAttempt(request.identity.invocationId);
    if (
      !current ||
      current.attemptEpoch !== request.identity.attemptEpoch ||
      current.daemonGeneration !== request.identity.daemonGeneration
    ) {
      throw new ExecutionParentCapabilityError(
        "execution_capability_stale_attempt",
        "stale execution attempt cannot call a parent capability",
      );
    }
    if (current.correlationId !== request.correlationId) {
      throw new ExecutionParentCapabilityError(
        "execution_capability_correlation_mismatch",
        "execution capability correlation does not match the current attempt",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = definition.validate(request.request);
    } catch (error) {
      if (error instanceof ExecutionParentCapabilityError) throw error;
      if (error instanceof ExecutionAttemptProtocolError) {
        throw new ExecutionParentCapabilityError(
          "execution_capability_invalid_request",
          error.message,
        );
      }
      throw new ExecutionParentCapabilityError(
        "execution_capability_invalid_request",
        error instanceof Error ? error.message : String(error),
      );
    }
    return definition.handle(parsed, {
      identity: {
        invocationId: request.identity.invocationId,
        attemptEpoch: request.identity.attemptEpoch,
        daemonGeneration: request.identity.daemonGeneration,
      },
      ...(parent.signal ? { signal: parent.signal } : {}),
    });
  }
}

export function objectRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionParentCapabilityError(
      "execution_capability_invalid_request",
      "execution capability request must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function isParentCapability(value: string): value is ExecutionParentCapability {
  return EXECUTION_PARENT_CAPABILITIES.includes(value as ExecutionParentCapability);
}
