import type { AssistantMessage, ProviderRegistrationAPI } from "@zendev-lab/spark-llm-providers";

export const CAPACITY_PROVIDER_ID = "capacity-fake";
export const CAPACITY_MODEL_ID = "capacity-model";
export const CAPACITY_MODEL_REF = `${CAPACITY_PROVIDER_ID}/${CAPACITY_MODEL_ID}`;
const CAPACITY_REQUEST_PREFIX = "capacity-request:";
export const CAPACITY_STREAM_CHUNK_COUNT = 50;
export const CAPACITY_STREAM_TICK_MS = 12;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

interface TickBarrier {
  arrivals: Set<string>;
  gate: Deferred<void>;
  timer?: ReturnType<typeof setTimeout>;
}

interface CapacityProviderSnapshot {
  expectedRequests: number;
  calls: number;
  entered: number;
  active: number;
  maxInFlight: number;
  completed: number;
  uniqueRequestIds: string[];
  chunkCount: number;
  tickMs: number;
  emittedTextDeltas: number;
  firstStreamAtMs?: number;
  lastCompletedAtMs?: number;
  streamWindowMs: number;
}

/**
 * Process-local control for the real provider plugin loaded by every headless
 * host. The child imports this exact module URL, so all 50 registries share one
 * deterministic admission and per-chunk barrier without replacing AgentLoop.
 */
class CapacityProviderController {
  #expectedRequests = 0;
  #calls = 0;
  #entered = new Set<string>();
  #registered = new Set<string>();
  #active = new Set<string>();
  #maxInFlight = 0;
  #completed = 0;
  #emittedTextDeltas = 0;
  #firstStreamAtMs: number | undefined;
  #lastCompletedAtMs: number | undefined;
  #entryGate = deferred<void>();
  #releaseGate = deferred<void>();
  #ticks = new Map<number, TickBarrier>();
  #cancelled: unknown;

  configure(expectedRequests: number): void {
    if (!Number.isSafeInteger(expectedRequests) || expectedRequests < 1) {
      throw new RangeError("capacity provider expectedRequests must be a positive safe integer");
    }
    this.cancel(new Error("capacity provider reconfigured"));
    this.#expectedRequests = expectedRequests;
    this.#calls = 0;
    this.#entered = new Set();
    this.#registered = new Set();
    this.#active = new Set();
    this.#maxInFlight = 0;
    this.#completed = 0;
    this.#emittedTextDeltas = 0;
    this.#firstStreamAtMs = undefined;
    this.#lastCompletedAtMs = undefined;
    this.#entryGate = deferred<void>();
    this.#releaseGate = deferred<void>();
    this.#ticks = new Map();
    this.#cancelled = undefined;
  }

  register(requestId: string): void {
    this.#throwIfUnavailable();
    this.#calls += 1;
    if (this.#registered.has(requestId)) {
      throw new Error(`capacity provider received duplicate request id: ${requestId}`);
    }
    this.#registered.add(requestId);
    if (this.#registered.size > this.#expectedRequests) {
      throw new Error(
        `capacity provider received more than ${this.#expectedRequests} configured requests`,
      );
    }
  }

  async enter(requestId: string, signal: AbortSignal | undefined): Promise<void> {
    this.#throwIfUnavailable();
    if (!this.#registered.has(requestId)) {
      throw new Error(`capacity provider request was not registered: ${requestId}`);
    }
    this.#entered.add(requestId);
    this.#active.add(requestId);
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#active.size);
    if (this.#entered.size === this.#expectedRequests) this.#entryGate.resolve();
    await abortable(this.#entryGate.promise, signal);
    await abortable(this.#releaseGate.promise, signal);
    this.#firstStreamAtMs ??= performance.now();
  }

  async tick(requestId: string, index: number, signal: AbortSignal | undefined): Promise<void> {
    this.#throwIfUnavailable();
    let tick = this.#ticks.get(index);
    if (!tick) {
      tick = { arrivals: new Set(), gate: deferred<void>() };
      this.#ticks.set(index, tick);
    }
    tick.arrivals.add(requestId);
    if (tick.arrivals.size === this.#expectedRequests && !tick.timer) {
      tick.timer = setTimeout(() => tick!.gate.resolve(), CAPACITY_STREAM_TICK_MS);
    }
    await abortable(tick.gate.promise, signal);
    this.#emittedTextDeltas += 1;
  }

  complete(requestId: string): void {
    this.#completed += 1;
    this.#active.delete(requestId);
    this.#lastCompletedAtMs = performance.now();
  }

  fail(requestId: string, error: unknown): void {
    this.#active.delete(requestId);
    this.cancel(error);
  }

  async waitForEntered(signal?: AbortSignal): Promise<void> {
    await abortable(this.#entryGate.promise, signal);
  }

  release(): void {
    if (this.#entered.size !== this.#expectedRequests) {
      throw new Error(
        `capacity provider cannot release ${this.#entered.size}/${this.#expectedRequests} requests`,
      );
    }
    this.#releaseGate.resolve();
  }

  snapshot(): CapacityProviderSnapshot {
    const first = this.#firstStreamAtMs;
    const last = this.#lastCompletedAtMs;
    return {
      expectedRequests: this.#expectedRequests,
      calls: this.#calls,
      entered: this.#entered.size,
      active: this.#active.size,
      maxInFlight: this.#maxInFlight,
      completed: this.#completed,
      uniqueRequestIds: [...this.#entered].sort(),
      chunkCount: CAPACITY_STREAM_CHUNK_COUNT,
      tickMs: CAPACITY_STREAM_TICK_MS,
      emittedTextDeltas: this.#emittedTextDeltas,
      ...(first !== undefined ? { firstStreamAtMs: first } : {}),
      ...(last !== undefined ? { lastCompletedAtMs: last } : {}),
      streamWindowMs: first !== undefined && last !== undefined ? Math.max(0, last - first) : 0,
    };
  }

  cancel(reason: unknown): void {
    this.#cancelled = reason;
    this.#entryGate.reject(reason);
    this.#releaseGate.reject(reason);
    for (const tick of this.#ticks.values()) {
      if (tick.timer) clearTimeout(tick.timer);
      tick.gate.reject(reason);
    }
  }

  #throwIfUnavailable(): void {
    if (this.#cancelled) throw this.#cancelled;
    if (this.#expectedRequests < 1) {
      throw new Error("capacity provider controller was not configured");
    }
  }
}

export const capacityProviderController = new CapacityProviderController();

export function capacityRequestId(index: number): string {
  return `${CAPACITY_REQUEST_PREFIX}${String(index).padStart(2, "0")}`;
}

export function expectedCapacityAnswer(requestId: string): string {
  return Array.from(
    { length: CAPACITY_STREAM_CHUNK_COUNT },
    (_, index) => `[${requestId}:${String(index).padStart(2, "0")}]`,
  ).join("");
}

export default function registerCapacityProvider(api: ProviderRegistrationAPI): void {
  api.registerProvider(CAPACITY_PROVIDER_ID, {
    name: "Capacity Fake Provider",
    baseUrl: "https://capacity.invalid",
    api: "openai-completions",
    streamSimple: (_model, context, options) => {
      const requestId = extractRequestId(context.messages);
      capacityProviderController.register(requestId);
      const result = deferred<AssistantMessage>();
      return {
        async *[Symbol.asyncIterator]() {
          let completed = false;
          try {
            await capacityProviderController.enter(requestId, options?.signal);
            let text = "";
            yield { type: "start", partial: assistant(text) };
            for (let index = 0; index < CAPACITY_STREAM_CHUNK_COUNT; index += 1) {
              await capacityProviderController.tick(requestId, index, options?.signal);
              const delta = `[${requestId}:${String(index).padStart(2, "0")}]`;
              text += delta;
              yield {
                type: "text_delta",
                contentIndex: 0,
                delta,
                partial: assistant(text),
              };
            }
            const message = assistant(text);
            completed = true;
            capacityProviderController.complete(requestId);
            result.resolve(message);
            // Provider runners are allowed to stop consuming after the
            // terminal event, so commit fixture state before yielding it.
            yield { type: "done", reason: "stop", message };
          } catch (error) {
            capacityProviderController.fail(requestId, error);
            result.reject(error);
            throw error;
          } finally {
            if (!completed) {
              // A failed/aborted stream is intentionally visible as incomplete
              // in the final metrics; daemon shutdown supplies the abort path.
            }
          }
        },
        result: async () => await result.promise,
      };
    },
    models: [
      {
        id: CAPACITY_MODEL_ID,
        name: "Capacity Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 4_096,
      },
    ],
  });
}

function extractRequestId(messages: unknown): string {
  const match = JSON.stringify(messages).match(/capacity-request:\d{2}/u);
  if (!match) throw new Error("capacity provider request marker is missing");
  return match[0];
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: CAPACITY_PROVIDER_ID,
    model: CAPACITY_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1_700_000_000_000,
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason ?? new Error("capacity provider aborted");
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      cleanup();
      rejectPromise(signal.reason ?? new Error("capacity provider aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error: unknown) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Reconfiguration may reject a gate before a stream observes it.
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
