import type { SparkJsonValue } from "@zendev-lab/spark-protocol";
import { setTimeout as delay } from "node:timers/promises";
import {
  EXECUTION_ATTEMPT_PROTOCOL_VERSION,
  ExecutionAttemptProtocolError,
  ExecutionAttemptProtocolFence,
  parseExecutionAttemptEnvelope,
  type ExecutionAttemptEnvelope,
  type ExecutionAttemptIdentity,
} from "./contract.ts";
import type {
  ExecutionCapabilityRegistry,
  ExecutionParentCapability,
} from "./capability-registry.ts";
import {
  ExecutionAttemptStateError,
  type ExecutionAttemptRecord,
  type ExecutionAttemptStore,
} from "./state.ts";

export interface ExecutionAttemptRequest extends ExecutionAttemptIdentity {
  version: typeof EXECUTION_ATTEMPT_PROTOCOL_VERSION;
  correlationId: string;
  task: SparkJsonValue;
}

/** Parent-only callbacks. A process backend must never serialize this object. */
export interface ExecutionAttemptParent {
  signal: AbortSignal;
  accepted(): void;
  running(): void;
  recordEvent(event: unknown): void;
  recordUsage(usage: unknown): void;
  dispatchCapability(operation: string, request: unknown): Promise<unknown>;
  executeInProcess(): Promise<unknown>;
}

/**
 * Parent-side backend seam. Only `request` is worker-facing and bounded JSON.
 * `parent` remains in the daemon and owns cancellation plus in-process fallback.
 */
export interface ExecutionAttemptAdapter {
  readonly kind: "in_process" | "process";
  execute(request: ExecutionAttemptRequest, parent: ExecutionAttemptParent): Promise<unknown>;
}

export class InProcessExecutionAttemptAdapter implements ExecutionAttemptAdapter {
  readonly kind = "in_process" as const;

  execute(_request: ExecutionAttemptRequest, parent: ExecutionAttemptParent): Promise<unknown> {
    parent.accepted();
    parent.running();
    return parent.executeInProcess();
  }
}

export class ExecutionAttemptCrashedError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message = errorCode) {
    super(message);
    this.name = "ExecutionAttemptCrashedError";
    this.errorCode = errorCode;
  }
}

export class ExecutionAttemptRetryExhaustedError extends Error {
  readonly code = "execution_attempt_retry_exhausted";

  constructor() {
    super("execution attempt accepted-crash retry budget is exhausted");
    this.name = "ExecutionAttemptRetryExhaustedError";
  }
}

export interface ExecutionAttemptSessionOptions {
  store: ExecutionAttemptStore;
  registry: ExecutionCapabilityRegistry;
  adapter: ExecutionAttemptAdapter;
  invocationId: string;
  daemonGeneration: number;
  task: unknown;
  signal: AbortSignal;
  executeInProcess(): Promise<unknown>;
  persistEvent(event: unknown): void;
  persistUsage(usage: unknown): void;
  now?: () => string;
  wait?: (delayMs: number) => Promise<void>;
}

/** One daemon-owned invocation execution, across one or more replacement epochs. */
export class ExecutionAttemptSession {
  readonly #options: ExecutionAttemptSessionOptions;
  #current: ExecutionAttemptRecord;
  #host: ExecutionAttemptHost;

  constructor(options: ExecutionAttemptSessionOptions) {
    this.#options = options;
    const now = options.now?.() ?? new Date().toISOString();
    this.#current = options.store.begin(
      options.invocationId,
      options.daemonGeneration,
      correlationId(options.invocationId, options.daemonGeneration),
      now,
    );
    this.#host = this.#createHost(this.#current);
  }

  current(): ExecutionAttemptRecord {
    return this.#options.store.current(this.#current.invocationId) ?? this.#current;
  }

  execute(): Promise<unknown> {
    const wait = this.#waitUntilReady();
    if (wait) return wait.then(() => this.#executeCurrent());
    return this.#executeCurrent();
  }

  #executeCurrent(): Promise<unknown> {
    let execution: Promise<unknown>;
    try {
      execution = this.#options.adapter.execute(
        this.#host.request(this.#options.adapter.kind === "process"),
        this.#parent(this.#host),
      );
    } catch (error) {
      return this.#handleExecutionError(error);
    }
    if (this.#options.adapter.kind === "in_process") return execution;
    return execution.catch((error: unknown) => this.#handleExecutionError(error));
  }

  #handleExecutionError(error: unknown): Promise<unknown> {
    if (!(error instanceof ExecutionAttemptCrashedError)) return Promise.reject(error);
    const crashed = this.#options.store.crash(
      this.#current,
      error.errorCode,
      this.#now(),
      this.#options.daemonGeneration,
    );
    if (crashed.terminalFailed || !crashed.replacement) {
      return Promise.reject(new ExecutionAttemptRetryExhaustedError());
    }
    this.#current = crashed.replacement;
    this.#host = this.#createHost(this.#current);
    return this.execute();
  }

  recordEvent(event: unknown): void {
    this.#host.recordEvent(event);
  }

  recordUsage(usage: unknown): void {
    this.#host.recordUsage(usage);
  }

  dispatchCapability(operation: string, request: unknown): Promise<unknown> {
    return this.#host.dispatchCapability(operation, request);
  }

  terminal(status: "succeeded" | "failed" | "cancelled", result?: unknown): void {
    const current = this.#options.store.current(this.#current.invocationId);
    if (current && ["succeeded", "failed", "cancelled"].includes(current.status)) {
      if (current.status === status) return;
      throw new ExecutionAttemptStateError(
        "execution_attempt_transition_invalid",
        `execution attempt already finished as ${current.status}`,
      );
    }
    this.#host.terminal(status, result);
  }

  #parent(host: ExecutionAttemptHost): ExecutionAttemptParent {
    return {
      signal: this.#options.signal,
      accepted: () => host.accept(),
      running: () => host.running(),
      recordEvent: (event) => host.recordEvent(event),
      recordUsage: (usage) => host.recordUsage(usage),
      dispatchCapability: async (operation, request) =>
        await host.dispatchCapability(operation, request),
      executeInProcess: () => this.#options.executeInProcess(),
    };
  }

  #createHost(attempt: ExecutionAttemptRecord): ExecutionAttemptHost {
    return new ExecutionAttemptHost({
      attempt,
      store: this.#options.store,
      registry: this.#options.registry,
      signal: this.#options.signal,
      task: this.#options.task,
      persistEvent: (event) => this.#options.persistEvent(event),
      persistUsage: (usage) => this.#options.persistUsage(usage),
      now: () => this.#now(),
    });
  }

  #waitUntilReady(): Promise<void> | undefined {
    if (!this.#current.nextAttemptAt) return undefined;
    const delayMs = Math.max(0, Date.parse(this.#current.nextAttemptAt) - Date.parse(this.#now()));
    if (delayMs === 0) return undefined;
    return (this.#options.wait ?? delay)(delayMs);
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString();
  }
}

interface ExecutionAttemptHostOptions {
  attempt: ExecutionAttemptRecord;
  store: ExecutionAttemptStore;
  registry: ExecutionCapabilityRegistry;
  signal: AbortSignal;
  task: unknown;
  persistEvent(event: unknown): void;
  persistUsage(usage: unknown): void;
  now(): string;
}

class ExecutionAttemptHost {
  readonly #options: ExecutionAttemptHostOptions;
  readonly #fence: ExecutionAttemptProtocolFence;
  #messageSequence = 1;
  #eventSequence = 0;
  #usageSequence = 0;

  constructor(options: ExecutionAttemptHostOptions) {
    this.#options = options;
    this.#fence = new ExecutionAttemptProtocolFence(options.attempt, options.attempt.correlationId);
  }

  request(includeTask: boolean): ExecutionAttemptRequest {
    const task = includeTask
      ? cloneExecutionRequest(this.#options.task)
      : executionTaskDescriptor(this.#options.task);
    const envelope = parseExecutionAttemptEnvelope({
      version: EXECUTION_ATTEMPT_PROTOCOL_VERSION,
      type: "capability_request",
      invocationId: this.#options.attempt.invocationId,
      attemptEpoch: this.#options.attempt.attemptEpoch,
      daemonGeneration: this.#options.attempt.daemonGeneration,
      sequence: 1,
      correlationId: this.#options.attempt.correlationId,
      operation: "execution.run",
      request: task,
    });
    if (envelope.type !== "capability_request") {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_invalid_payload",
        "execution attempt request did not parse as a capability request",
      );
    }
    return {
      version: EXECUTION_ATTEMPT_PROTOCOL_VERSION,
      invocationId: envelope.invocationId,
      attemptEpoch: envelope.attemptEpoch,
      daemonGeneration: envelope.daemonGeneration,
      correlationId: envelope.correlationId,
      task: envelope.request,
    };
  }

  accept(): void {
    this.#assertCurrent();
    this.#fence.process(this.#envelope("accepted", { acceptedAt: this.#options.now() }));
    this.#options.store.accept(this.#options.attempt, this.#options.now());
  }

  running(): void {
    this.#assertCurrent();
    this.#fence.process(this.#envelope("running", { startedAt: this.#options.now() }));
    this.#options.store.start(this.#options.attempt, this.#options.now());
  }

  recordEvent(event: unknown): void {
    this.#assertCurrent();
    const serialized = cloneExecutionRequest(event) as SparkJsonValue;
    this.#eventSequence += 1;
    this.#fence.process(
      this.#envelope("event", {
        eventSequence: this.#eventSequence,
        event: serialized,
      }),
    );
    this.#options.store.recordOutput(
      this.#options.attempt,
      "event",
      this.#eventSequence,
      serialized,
      this.#options.now(),
    );
    this.#options.persistEvent(serialized);
    this.#fence.acknowledgeEvent(this.#eventSequence);
  }

  recordUsage(usage: unknown): void {
    this.#assertCurrent();
    const serialized = cloneExecutionRequest(usage) as SparkJsonValue;
    this.#usageSequence += 1;
    this.#fence.process(
      this.#envelope("usage", {
        usageSequence: this.#usageSequence,
        usage: serialized,
      }),
    );
    this.#options.store.recordOutput(
      this.#options.attempt,
      "usage",
      this.#usageSequence,
      serialized,
      this.#options.now(),
    );
    this.#options.persistUsage(serialized);
    this.#fence.acknowledgeUsage(this.#usageSequence);
  }

  async dispatchCapability(operation: string, request: unknown): Promise<unknown> {
    this.#assertCurrent();
    const serialized = cloneExecutionRequest(request) as SparkJsonValue;
    const envelope = parseExecutionAttemptEnvelope(
      this.#envelope("capability_request", {
        operation,
        request: serialized,
      }),
    );
    this.#fence.process(envelope);
    if (envelope.type !== "capability_request") {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_invalid_payload",
        "execution attempt capability did not parse as a capability request",
      );
    }
    return await this.#options.registry.dispatch(
      {
        identity: this.#options.attempt,
        correlationId: envelope.correlationId,
        operation: envelope.operation,
        request: envelope.request,
      },
      { signal: this.#options.signal },
    );
  }

  terminal(status: "succeeded" | "failed" | "cancelled", result?: unknown): void {
    this.#assertCurrent();
    const serializedResult =
      result === undefined ? undefined : (cloneExecutionRequest(result) as SparkJsonValue);
    const outcome = this.#fence.process(
      this.#envelope("terminal", {
        status,
        eventHighWaterMark: this.#eventSequence,
        usageHighWaterMark: this.#usageSequence,
        ...(serializedResult === undefined ? {} : { result: serializedResult }),
      }),
    );
    if (outcome.status !== "terminal_committed") {
      throw new ExecutionAttemptProtocolError(
        "execution_attempt_high_water_invalid",
        "execution attempt terminal commit is waiting for durable event or usage acknowledgement",
      );
    }
    this.#options.store.complete(
      this.#options.attempt,
      status,
      { event: this.#eventSequence, usage: this.#usageSequence },
      this.#options.now(),
    );
  }

  #assertCurrent(): void {
    const current = this.#options.store.current(this.#options.attempt.invocationId);
    if (
      !current ||
      current.attemptEpoch !== this.#options.attempt.attemptEpoch ||
      current.daemonGeneration !== this.#options.attempt.daemonGeneration
    ) {
      throw new ExecutionAttemptStateError(
        "execution_attempt_stale",
        "execution attempt is no longer current",
      );
    }
  }

  #envelope<T extends ExecutionAttemptEnvelope["type"]>(
    type: T,
    fields: Omit<
      Extract<ExecutionAttemptEnvelope, { type: T }>,
      | "version"
      | "type"
      | "invocationId"
      | "attemptEpoch"
      | "daemonGeneration"
      | "sequence"
      | "correlationId"
    >,
  ): Extract<ExecutionAttemptEnvelope, { type: T }> {
    const envelope = {
      version: EXECUTION_ATTEMPT_PROTOCOL_VERSION,
      type,
      invocationId: this.#options.attempt.invocationId,
      attemptEpoch: this.#options.attempt.attemptEpoch,
      daemonGeneration: this.#options.attempt.daemonGeneration,
      sequence: this.#messageSequence,
      correlationId: this.#options.attempt.correlationId,
      ...fields,
    } as Extract<ExecutionAttemptEnvelope, { type: T }>;
    this.#messageSequence += 1;
    return envelope;
  }
}

function executionTaskDescriptor(value: unknown): SparkJsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_invalid_payload",
      "execution attempt task must be an object",
    );
  }
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== "string" || type.length === 0) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_invalid_payload",
      "execution attempt task type is missing",
    );
  }
  return { type };
}

function cloneExecutionRequest(value: unknown): SparkJsonValue {
  assertExecutionRequestValue(value, "task");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_invalid_payload",
      "execution attempt request is not JSON serializable",
    );
  }
  return JSON.parse(encoded) as SparkJsonValue;
}

function assertExecutionRequestValue(value: unknown, path: string): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (entry === undefined) {
        throw new ExecutionAttemptProtocolError(
          "execution_attempt_invalid_payload",
          `${path}[${index}] cannot be undefined`,
        );
      }
      assertExecutionRequestValue(entry, `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ExecutionAttemptProtocolError(
      "execution_attempt_invalid_payload",
      `${path} is not JSON serializable`,
    );
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertExecutionRequestValue(entry, `${path}.${key}`);
  }
}

function correlationId(invocationId: string, daemonGeneration: number): string {
  const boundedInvocationId = invocationId.slice(0, 180);
  return `attempt:${boundedInvocationId}:${daemonGeneration}`;
}

export function executionCapabilityOperation(value: string): ExecutionParentCapability | undefined {
  return ["task.claim", "human.interaction", "loop.schedule", "loop.stop"].includes(value)
    ? (value as ExecutionParentCapability)
    : undefined;
}
