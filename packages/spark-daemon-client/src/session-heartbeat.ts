import { createSparkDaemonClient, type SparkDaemonClient } from "./daemon-client.ts";
import {
  normalizeSessionAttachInput,
  positiveSessionDelay,
  sessionLeaseFromResult,
  type SparkDaemonSessionAttachInput,
  type SparkDaemonSessionHeartbeatEvent,
  type SparkDaemonSessionHeartbeatHandle,
  type SparkDaemonSessionHeartbeatOptions,
  type SparkDaemonSessionLease,
  type SparkDaemonSessionLeaseResult,
  type SparkDaemonSessionTimerHandle,
} from "./session-heartbeat-contract.ts";

export type {
  SparkDaemonSessionHeartbeatEvent,
  SparkDaemonSessionHeartbeatHandle,
  SparkDaemonSessionHeartbeatOptions,
  SparkDaemonSessionLease,
} from "./session-heartbeat-contract.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;

export async function startSparkDaemonSessionHeartbeat(
  options: SparkDaemonSessionHeartbeatOptions,
): Promise<SparkDaemonSessionHeartbeatHandle> {
  const manager = new SparkDaemonSessionHeartbeatManager(options);
  await manager.start();
  return manager;
}

class SparkDaemonSessionHeartbeatManager implements SparkDaemonSessionHeartbeatHandle {
  readonly #attach: SparkDaemonSessionAttachInput;
  readonly #client: SparkDaemonClient;
  readonly #heartbeatIntervalMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => SparkDaemonSessionTimerHandle;
  readonly #cancelSchedule: (handle: SparkDaemonSessionTimerHandle) => void;
  readonly #onEvent: ((event: SparkDaemonSessionHeartbeatEvent) => void) | undefined;

  #lease: SparkDaemonSessionLease | undefined;
  #timer: SparkDaemonSessionTimerHandle | undefined;
  #inFlight: Promise<void> | undefined;
  #stopPromise: Promise<SparkDaemonSessionLeaseResult | null> | undefined;
  #retryAttempt = 0;
  #reattachRequired = false;
  #stopped = false;

  constructor(options: SparkDaemonSessionHeartbeatOptions) {
    this.#attach = normalizeSessionAttachInput(options.attach);
    this.#client = options.client ?? createSparkDaemonClient(options.clientOptions);
    this.#heartbeatIntervalMs = positiveSessionDelay(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    this.#retryBaseDelayMs = positiveSessionDelay(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.#retryMaxDelayMs = positiveSessionDelay(
      options.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      "retryMaxDelayMs",
    );
    if (this.#retryMaxDelayMs < this.#retryBaseDelayMs) {
      throw new Error("retryMaxDelayMs must be greater than or equal to retryBaseDelayMs");
    }
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancelSchedule =
      options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#onEvent = options.onEvent;
  }

  get lease(): SparkDaemonSessionLease | undefined {
    return this.#lease;
  }

  async start(): Promise<void> {
    const result = await this.#requestAttach();
    this.#lease = sessionLeaseFromResult(result, this.#attach);
    this.#emit({ type: "attached", lease: this.#lease });
    this.#scheduleNext(this.#heartbeatIntervalMs);
  }

  async heartbeat(): Promise<void> {
    if (this.#stopped) return;
    if (!this.#inFlight) {
      this.#inFlight = this.#runCycle().finally(() => {
        this.#inFlight = undefined;
      });
    }
    await this.#inFlight;
  }

  async stop(): Promise<SparkDaemonSessionLeaseResult | null> {
    this.#stopPromise ??= this.#stop();
    return await this.#stopPromise;
  }

  async #runCycle(): Promise<void> {
    if (this.#stopped) return;
    try {
      if (this.#reattachRequired) {
        const result = await this.#requestAttach();
        this.#lease = sessionLeaseFromResult(result, this.#attach);
        if (this.#stopped) return;
        this.#reattachRequired = false;
        this.#retryAttempt = 0;
        this.#emit({ type: "reattached", lease: this.#lease });
      } else {
        const lease = this.#requiredLease();
        const result = await this.#client.request("workspace.client.heartbeat", {
          clientId: lease.clientId,
          leaseFence: lease.leaseFence,
          ...(this.#attach.leaseTtlMs === undefined ? {} : { leaseTtlMs: this.#attach.leaseTtlMs }),
        });
        this.#lease = sessionLeaseFromResult(result, this.#attach, lease.clientId);
        if (this.#stopped) return;
        this.#retryAttempt = 0;
        this.#emit({ type: "heartbeat", lease: this.#lease });
      }
      this.#scheduleNext(this.#heartbeatIntervalMs);
    } catch (error) {
      if (this.#stopped) return;
      this.#reattachRequired = true;
      this.#retryAttempt += 1;
      const delayMs = Math.min(
        this.#retryMaxDelayMs,
        this.#retryBaseDelayMs * 2 ** Math.min(this.#retryAttempt - 1, 30),
      );
      this.#emit({ type: "retry", attempt: this.#retryAttempt, delayMs, error });
      this.#scheduleNext(delayMs);
    }
  }

  async #requestAttach(): Promise<SparkDaemonSessionLeaseResult> {
    return await this.#client.request("workspace.client.attach", {
      ...this.#attach,
      ...(this.#lease ? { clientId: this.#lease.clientId } : {}),
    });
  }

  async #stop(): Promise<SparkDaemonSessionLeaseResult | null> {
    this.#stopped = true;
    this.#clearTimer();
    await this.#inFlight?.catch(() => undefined);
    const lease = this.#lease;
    this.#lease = undefined;
    if (!lease) return null;
    try {
      const result = await this.#client.request("workspace.client.release", {
        clientId: lease.clientId,
        leaseFence: lease.leaseFence,
      });
      this.#emit({ type: "released", lease });
      return result;
    } catch (error) {
      this.#emit({ type: "release_failed", lease, error });
      throw error;
    }
  }

  #scheduleNext(delayMs: number): void {
    if (this.#stopped) return;
    this.#clearTimer();
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      void this.heartbeat();
    }, delayMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#cancelSchedule(this.#timer);
    this.#timer = undefined;
  }

  #requiredLease(): SparkDaemonSessionLease {
    if (!this.#lease) throw new Error("Spark daemon session lease is not attached");
    return this.#lease;
  }

  #emit(event: SparkDaemonSessionHeartbeatEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Observability hooks cannot own the lease lifecycle.
    }
  }
}
