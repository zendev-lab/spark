import type { SparkJsonValue } from "@zendev-lab/spark-protocol";
import type { ExecutionAttemptEventIngress } from "../execution/adapter.ts";

export const DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS = 100;

interface PendingSnapshot {
  event: SparkJsonValue;
  order: number;
  persist: (event: SparkJsonValue) => void;
}

interface StreamingSnapshotState {
  invocationId: string;
  lastPersistedAt: number;
  pending?: PendingSnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DaemonEventIngressOptions {
  now?: () => number;
  intervalMs?: number;
}

/**
 * Daemon-owner ingress policy for durable executor events.
 *
 * Streaming assistant message events are complete replacement snapshots, so
 * persisting every provider token only amplifies synchronous SQLite work. Keep
 * the leading snapshot and the latest trailing snapshot for each message while
 * preserving every event that carries a state transition or side effect.
 */
export class DaemonEventIngress implements ExecutionAttemptEventIngress {
  readonly #now: () => number;
  readonly #intervalMs: number;
  readonly #streams = new Map<string, StreamingSnapshotState>();
  readonly #keysByInvocation = new Map<string, Set<string>>();
  readonly #failures = new Map<string, unknown>();
  #nextOrder = 0;

  constructor(options: DaemonEventIngressOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#intervalMs = positiveInterval(options.intervalMs);
  }

  record(
    invocationId: string,
    event: SparkJsonValue,
    persist: (event: SparkJsonValue) => void,
  ): void {
    this.#throwFailure(invocationId);
    const key = streamingAssistantMessageKey(invocationId, event);
    if (!key) {
      this.flush(invocationId);
      persist(event);
      return;
    }

    this.#flushOtherPending(invocationId, key);
    const now = this.#now();
    const current = this.#streams.get(key);
    if (!current) {
      persist(event);
      this.#streams.set(key, { invocationId, lastPersistedAt: now });
      let keys = this.#keysByInvocation.get(invocationId);
      if (!keys) {
        keys = new Set();
        this.#keysByInvocation.set(invocationId, keys);
      }
      keys.add(key);
      return;
    }

    if (!current.pending && now - current.lastPersistedAt >= this.#intervalMs) {
      persist(event);
      current.lastPersistedAt = now;
      return;
    }

    current.pending = { event, order: (this.#nextOrder += 1), persist };
    if (current.timer) return;
    const remaining = Math.max(0, this.#intervalMs - (now - current.lastPersistedAt));
    current.timer = setTimeout(() => this.#flushTimer(key), remaining);
    current.timer.unref?.();
  }

  flush(invocationId: string): void {
    this.#throwFailure(invocationId);
    const keys = this.#keysByInvocation.get(invocationId);
    if (!keys) return;

    const pending: PendingSnapshot[] = [];
    for (const key of keys) {
      const stream = this.#streams.get(key);
      if (!stream) continue;
      if (stream.timer) clearTimeout(stream.timer);
      if (stream.pending) pending.push(stream.pending);
      this.#streams.delete(key);
    }
    this.#keysByInvocation.delete(invocationId);

    pending.sort((left, right) => left.order - right.order);
    for (const snapshot of pending) {
      try {
        snapshot.persist(snapshot.event);
      } catch (error) {
        this.#failures.set(invocationId, error);
        throw error;
      }
    }
  }

  release(invocationId: string): void {
    const keys = this.#keysByInvocation.get(invocationId);
    if (keys) {
      for (const key of keys) {
        const stream = this.#streams.get(key);
        if (stream?.timer) clearTimeout(stream.timer);
        this.#streams.delete(key);
      }
      this.#keysByInvocation.delete(invocationId);
    }
    this.#failures.delete(invocationId);
  }

  #flushTimer(key: string): void {
    const stream = this.#streams.get(key);
    if (!stream) return;
    stream.timer = undefined;
    const pending = stream.pending;
    stream.pending = undefined;
    if (!pending) return;
    try {
      pending.persist(pending.event);
      stream.lastPersistedAt = this.#now();
    } catch (error) {
      this.#failures.set(stream.invocationId, error);
      this.#releaseStreams(stream.invocationId);
    }
  }

  #flushOtherPending(invocationId: string, currentKey: string): void {
    const keys = this.#keysByInvocation.get(invocationId);
    if (!keys) return;
    const pending: Array<{ snapshot: PendingSnapshot; stream: StreamingSnapshotState }> = [];
    for (const key of keys) {
      if (key === currentKey) continue;
      const stream = this.#streams.get(key);
      if (!stream?.pending) continue;
      if (stream.timer) clearTimeout(stream.timer);
      stream.timer = undefined;
      pending.push({ snapshot: stream.pending, stream });
      stream.pending = undefined;
    }
    pending.sort((left, right) => left.snapshot.order - right.snapshot.order);
    for (const { snapshot, stream } of pending) {
      try {
        snapshot.persist(snapshot.event);
        stream.lastPersistedAt = this.#now();
      } catch (error) {
        this.#failures.set(invocationId, error);
        this.#releaseStreams(invocationId);
        throw error;
      }
    }
  }

  #releaseStreams(invocationId: string): void {
    const hadFailure = this.#failures.has(invocationId);
    const failure = this.#failures.get(invocationId);
    this.release(invocationId);
    if (hadFailure) this.#failures.set(invocationId, failure);
  }

  #throwFailure(invocationId: string): void {
    if (this.#failures.has(invocationId)) throw this.#failures.get(invocationId);
  }
}

function streamingAssistantMessageKey(
  invocationId: string,
  event: SparkJsonValue,
): string | undefined {
  if (!isRecord(event) || event.type !== "daemon.view_event") return undefined;
  const view = event.view;
  if (!isRecord(view) || view.type !== "session.message") return undefined;
  const message = view.message;
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.status !== "streaming" ||
    typeof view.sessionId !== "string" ||
    view.sessionId.length === 0 ||
    typeof message.id !== "string" ||
    message.id.length === 0
  ) {
    return undefined;
  }
  return JSON.stringify([invocationId, view.sessionId, message.id]);
}

function isRecord(value: SparkJsonValue): value is Record<string, SparkJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInterval(value: number | undefined): number {
  if (value === undefined) return DAEMON_STREAMING_SNAPSHOT_INTERVAL_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("daemon streaming snapshot interval must be positive");
  }
  return Math.floor(value);
}
