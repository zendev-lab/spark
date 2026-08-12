import type { SparkJsonValue } from "@zendev-lab/spark-protocol";
import { setImmediate as scheduleImmediate } from "node:timers";
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
  ready?: PendingSnapshot;
  pending?: PendingSnapshot;
  timer?: ReturnType<typeof setTimeout>;
}

interface ReadySnapshot {
  key: string;
  snapshot: PendingSnapshot;
}

export interface DaemonEventIngressOptions {
  now?: () => number;
  intervalMs?: number;
  /** Test seam for the cooperative daemon-wide ready-snapshot pump. */
  scheduleMacrotask?: (callback: () => void) => void;
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
  readonly #scheduleMacrotask: (callback: () => void) => void;
  readonly #streams = new Map<string, StreamingSnapshotState>();
  readonly #keysByInvocation = new Map<string, Set<string>>();
  readonly #failures = new Map<string, unknown>();
  readonly #readyQueue: ReadySnapshot[] = [];
  #nextOrder = 0;
  #pumpScheduled = false;

  constructor(options: DaemonEventIngressOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#intervalMs = positiveInterval(options.intervalMs);
    this.#scheduleMacrotask = options.scheduleMacrotask ?? scheduleMacrotask;
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

    const snapshot = { event, order: (this.#nextOrder += 1), persist };
    if (!current.ready && now - current.lastPersistedAt >= this.#intervalMs) {
      if (current.timer) clearTimeout(current.timer);
      current.timer = undefined;
      current.pending = undefined;
      this.#markReady(key, current, snapshot);
      return;
    }

    current.pending = snapshot;
    if (!current.ready) this.#scheduleStreamTimer(key, current, now);
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
      if (stream.ready) pending.push(stream.ready);
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
    this.#markReady(key, stream, pending);
  }

  #markReady(key: string, stream: StreamingSnapshotState, snapshot: PendingSnapshot): void {
    stream.ready = snapshot;
    this.#readyQueue.push({ key, snapshot });
    this.#schedulePump();
  }

  #flushOtherPending(invocationId: string, currentKey: string): void {
    const keys = this.#keysByInvocation.get(invocationId);
    if (!keys) return;
    const pending: Array<{ snapshot: PendingSnapshot; stream: StreamingSnapshotState }> = [];
    for (const key of keys) {
      if (key === currentKey) continue;
      const stream = this.#streams.get(key);
      if (!stream) continue;
      if (stream.timer) clearTimeout(stream.timer);
      stream.timer = undefined;
      if (stream.ready) pending.push({ snapshot: stream.ready, stream });
      if (stream.pending) pending.push({ snapshot: stream.pending, stream });
      stream.ready = undefined;
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

  #scheduleStreamTimer(key: string, stream: StreamingSnapshotState, now = this.#now()): void {
    if (stream.timer || stream.ready || !stream.pending) return;
    const remaining = Math.max(0, this.#intervalMs - (now - stream.lastPersistedAt));
    stream.timer = setTimeout(() => this.#flushTimer(key), remaining);
    stream.timer.unref?.();
  }

  #schedulePump(): void {
    if (this.#pumpScheduled || this.#readyQueue.length === 0) return;
    this.#pumpScheduled = true;
    this.#scheduleMacrotask(() => this.#pumpOne());
  }

  #pumpOne(): void {
    this.#pumpScheduled = false;
    while (this.#readyQueue.length > 0) {
      const queued = this.#readyQueue.shift()!;
      const stream = this.#streams.get(queued.key);
      if (!stream || stream.ready !== queued.snapshot) continue;
      stream.ready = undefined;
      try {
        queued.snapshot.persist(queued.snapshot.event);
        stream.lastPersistedAt = this.#now();
        this.#scheduleStreamTimer(queued.key, stream);
      } catch (error) {
        this.#failures.set(stream.invocationId, error);
        this.#releaseStreams(stream.invocationId);
      }
      // Whether persistence succeeds or fails, one cooperative macrotask owns
      // at most one real write attempt. Stale queue entries are free to skip.
      this.#schedulePump();
      return;
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

function scheduleMacrotask(callback: () => void): void {
  const immediate = scheduleImmediate(callback);
  immediate.unref?.();
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
