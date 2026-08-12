import { Buffer } from "node:buffer";
import type { SparkInvocationEvent } from "../store/invocations.ts";

export const INVOCATION_DELIVERY_PAGE_SIZE = 64;
export const INVOCATION_DELIVERY_LIVE_BUFFER_LIMIT = 64;
export const INVOCATION_DELIVERY_LIVE_BUFFER_BYTES = 4 * 1024 * 1024;
export const INVOCATION_DELIVERY_PROJECTION_SKIP_BUDGET = 32;
export const INVOCATION_DELIVERY_ACK_TIMEOUT_MS = 30_000;

export interface InvocationDeliveryPageItem {
  event: SparkInvocationEvent;
  workspaceBindingId?: string;
}

export interface InvocationDeliveryPage {
  deliveries: InvocationDeliveryPageItem[];
  hasMore: boolean;
}

export interface InvocationDeliveryEnvelope {
  messageId: string;
}

export interface InvocationDeliveryPumpOptions<Envelope extends InvocationDeliveryEnvelope> {
  workspaceBindingIds: readonly string[];
  loadPage(workspaceBindingIds: readonly string[], limit: number): InvocationDeliveryPage;
  acknowledge(event: SparkInvocationEvent): void;
  project(delivery: InvocationDeliveryPageItem): Envelope | null;
  send(envelope: Envelope): void;
  bindingForInvocation(invocationId: string): string | null | undefined;
  onFatal(error: unknown): void;
  onProjectionDropped?(delivery: InvocationDeliveryPageItem): void;
  pageSize?: number;
  liveBufferLimit?: number;
  liveBufferBytes?: number;
  projectionSkipBudget?: number;
  ackTimeoutMs?: number;
  scheduleMacrotask?(callback: () => void): unknown;
  cancelMacrotask?(handle: unknown): void;
  scheduleAckDeadline?(callback: () => void, timeoutMs: number): unknown;
  cancelAckDeadline?(handle: unknown): void;
}

export interface InvocationDeliveryPumpSnapshot {
  ready: boolean;
  closed: boolean;
  needsCatchup: boolean;
  catchupBuffered: number;
  liveBuffered: number;
  inFlightMessageId?: string;
}

interface QueuedDelivery extends InvocationDeliveryPageItem {
  key: string;
  bytes: number;
}

interface InFlightDelivery<Envelope extends InvocationDeliveryEnvelope> {
  delivery: QueuedDelivery;
  envelope: Envelope;
}

interface AckDeadline<Envelope extends InvocationDeliveryEnvelope> {
  inFlight: InFlightDelivery<Envelope>;
  handle?: unknown;
}

/**
 * Connection-local accelerator for the durable invocation event outbox.
 *
 * SQLite remains authoritative. Live events only avoid a catch-up read while
 * one Hub connection is healthy; overflow, gaps, scope refresh, and reconnect
 * all fall back to the persisted delivery cursor.
 */
export class InvocationDeliveryPump<Envelope extends InvocationDeliveryEnvelope> {
  readonly #options: InvocationDeliveryPumpOptions<Envelope>;
  readonly #pageSize: number;
  readonly #liveBufferLimit: number;
  readonly #liveBufferBytesLimit: number;
  readonly #projectionSkipBudget: number;
  readonly #ackTimeoutMs: number;
  readonly #scheduleMacrotask: (callback: () => void) => unknown;
  readonly #cancelMacrotask: (handle: unknown) => void;
  readonly #scheduleAckDeadline: (callback: () => void, timeoutMs: number) => unknown;
  readonly #cancelAckDeadline: (handle: unknown) => void;
  #workspaceBindingIds: string[];
  #workspaceBindingIdSet: Set<string>;
  #liveBuffer = new Map<string, QueuedDelivery>();
  #liveBufferBytes = 0;
  #catchupQueue: QueuedDelivery[] = [];
  #knownKeys = new Set<string>();
  #ackedThrough = new Map<string, number>();
  #highestKnown = new Map<string, number>();
  #bindingByInvocation = new Map<string, string | null | undefined>();
  #inFlight: InFlightDelivery<Envelope> | undefined;
  #catchupActive = false;
  #catchupHasMore = false;
  #needsCatchup = true;
  #ready = false;
  #closed = false;
  #scheduled: unknown;
  #ackDeadline: AckDeadline<Envelope> | undefined;

  constructor(options: InvocationDeliveryPumpOptions<Envelope>) {
    this.#options = options;
    this.#pageSize = positiveInteger(options.pageSize, INVOCATION_DELIVERY_PAGE_SIZE);
    this.#liveBufferLimit = positiveInteger(
      options.liveBufferLimit,
      INVOCATION_DELIVERY_LIVE_BUFFER_LIMIT,
    );
    this.#liveBufferBytesLimit = positiveInteger(
      options.liveBufferBytes,
      INVOCATION_DELIVERY_LIVE_BUFFER_BYTES,
    );
    this.#projectionSkipBudget = positiveInteger(
      options.projectionSkipBudget,
      INVOCATION_DELIVERY_PROJECTION_SKIP_BUDGET,
    );
    this.#ackTimeoutMs = positiveInteger(options.ackTimeoutMs, INVOCATION_DELIVERY_ACK_TIMEOUT_MS);
    this.#workspaceBindingIds = normalizedBindings(options.workspaceBindingIds);
    this.#workspaceBindingIdSet = new Set(this.#workspaceBindingIds);
    this.#scheduleMacrotask = options.scheduleMacrotask
      ? (callback) => options.scheduleMacrotask!(callback)
      : (callback) => setImmediate(callback);
    this.#cancelMacrotask = options.cancelMacrotask
      ? (handle) => options.cancelMacrotask!(handle)
      : (handle) => {
          clearImmediate(handle as ReturnType<typeof setImmediate>);
        };
    this.#scheduleAckDeadline = options.scheduleAckDeadline
      ? (callback, timeoutMs) => options.scheduleAckDeadline!(callback, timeoutMs)
      : (callback, timeoutMs) => setTimeout(callback, timeoutMs);
    this.#cancelAckDeadline = options.cancelAckDeadline
      ? (handle) => options.cancelAckDeadline!(handle)
      : (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        };
  }

  get snapshot(): InvocationDeliveryPumpSnapshot {
    return {
      ready: this.#ready,
      closed: this.#closed,
      needsCatchup: this.#needsCatchup,
      catchupBuffered: this.#catchupQueue.length,
      liveBuffered: this.#liveBuffer.size,
      ...(this.#inFlight ? { inFlightMessageId: this.#inFlight.envelope.messageId } : {}),
    };
  }

  /** Register the event-hub sink before hello, then call ready after hello_ack. */
  offer(event: SparkInvocationEvent): void {
    if (this.#closed) return;
    let bindingId: string | null | undefined;
    try {
      bindingId = this.#bindingForInvocation(event.invocationId);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (bindingId === null) {
      this.requestCatchup();
      return;
    }
    if (bindingId === undefined) return;
    if (!this.#workspaceBindingIdSet.has(bindingId)) return;

    const key = deliveryKey(event);
    if ((this.#ackedThrough.get(event.invocationId) ?? 0) >= event.sequence) return;
    if (this.#knownKeys.has(key)) return;

    const highestKnown = this.#highestKnown.get(event.invocationId);
    if (highestKnown === undefined ? event.sequence !== 1 : event.sequence !== highestKnown + 1) {
      this.#needsCatchup = true;
    }

    let bytes: number;
    try {
      bytes = eventBytes(event);
    } catch (error) {
      this.#fail(error);
      return;
    }

    if (
      this.#liveBuffer.size >= this.#liveBufferLimit ||
      bytes > this.#liveBufferBytesLimit - this.#liveBufferBytes
    ) {
      this.#discardLiveBuffer();
      this.#needsCatchup = true;
      this.#schedule();
      return;
    }

    const delivery = { event, workspaceBindingId: bindingId, key, bytes };
    this.#liveBuffer.set(key, delivery);
    this.#liveBufferBytes += bytes;
    this.#knownKeys.add(key);
    this.#recordHighest(event);
    this.#schedule();
  }

  ready(): void {
    if (this.#closed || this.#ready) return;
    this.#ready = true;
    this.#needsCatchup = true;
    this.#schedule();
  }

  requestCatchup(): void {
    if (this.#closed) return;
    this.#needsCatchup = true;
    this.#schedule();
  }

  /**
   * Refresh the connection's Hub scope. Pre-ready changes close the hello race;
   * post-ready changes discard only memory and rescan durable truth.
   */
  refreshWorkspaceBindingIds(workspaceBindingIds: readonly string[]): boolean {
    if (this.#closed) return false;
    const normalized = normalizedBindings(workspaceBindingIds);
    if (sameStrings(this.#workspaceBindingIds, normalized)) return false;
    this.#workspaceBindingIds = normalized;
    this.#workspaceBindingIdSet = new Set(normalized);
    this.#discardLiveBuffer();
    this.#discardCatchupQueue();
    this.#catchupActive = false;
    this.#catchupHasMore = false;
    this.#needsCatchup = true;
    this.#bindingByInvocation.clear();
    this.#rebuildHighestKnown();
    this.#schedule();
    return true;
  }

  acknowledge(messageId: string): boolean {
    if (this.#closed || this.#inFlight?.envelope.messageId !== messageId) return false;
    const inFlight = this.#inFlight;
    this.#clearAckDeadline();
    try {
      this.#options.acknowledge(inFlight.delivery.event);
    } catch (error) {
      this.#fail(error);
      return false;
    }
    this.#inFlight = undefined;
    this.#markAcknowledged(inFlight.delivery);
    this.#schedule();
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#scheduled !== undefined) {
      this.#cancelMacrotask(this.#scheduled);
      this.#scheduled = undefined;
    }
    this.#clearAckDeadline();
    this.#liveBuffer.clear();
    this.#liveBufferBytes = 0;
    this.#catchupQueue = [];
    this.#knownKeys.clear();
    this.#inFlight = undefined;
  }

  #schedule(): void {
    if (this.#closed || !this.#ready || this.#inFlight || this.#scheduled !== undefined) return;
    this.#scheduled = this.#scheduleMacrotask(() => {
      this.#scheduled = undefined;
      this.#run();
    });
  }

  #run(): void {
    if (this.#closed || !this.#ready || this.#inFlight) return;
    let skipped = 0;
    while (!this.#closed && !this.#inFlight) {
      if (this.#catchupQueue.length === 0) {
        if (this.#catchupActive) {
          if (this.#catchupHasMore || this.#needsCatchup) {
            if (!this.#loadCatchupPage()) return;
          } else {
            this.#catchupActive = false;
          }
        } else if (this.#needsCatchup) {
          if (!this.#loadCatchupPage()) return;
        }
      }

      const delivery = this.#nextDelivery();
      if (!delivery) return;

      let envelope: Envelope | null;
      try {
        envelope = this.#options.project(delivery);
      } catch (error) {
        this.#fail(error);
        return;
      }
      if (!envelope) {
        try {
          this.#options.acknowledge(delivery.event);
          this.#options.onProjectionDropped?.(delivery);
        } catch (error) {
          this.#fail(error);
          return;
        }
        this.#markAcknowledged(delivery);
        skipped += 1;
        if (skipped >= this.#projectionSkipBudget) {
          this.#schedule();
          return;
        }
        continue;
      }

      const inFlight = { delivery, envelope };
      this.#inFlight = inFlight;
      try {
        this.#options.send(envelope);
        if (!this.#closed && this.#inFlight === inFlight) this.#armAckDeadline(inFlight);
      } catch (error) {
        this.#fail(error);
      }
      return;
    }
  }

  #loadCatchupPage(): boolean {
    this.#needsCatchup = false;
    let page: InvocationDeliveryPage;
    try {
      page = this.#options.loadPage(this.#workspaceBindingIds, this.#pageSize);
    } catch (error) {
      this.#fail(error);
      return false;
    }

    this.#catchupHasMore = page.hasMore;
    for (const item of page.deliveries) {
      const event = item.event;
      if (item.workspaceBindingId && !this.#workspaceBindingIdSet.has(item.workspaceBindingId)) {
        this.#fail(
          new Error(
            `invocation delivery page escaped the current Hub binding scope: ${item.workspaceBindingId}`,
          ),
        );
        return false;
      }
      this.#bindingByInvocation.set(event.invocationId, item.workspaceBindingId ?? null);
      if ((this.#ackedThrough.get(event.invocationId) ?? 0) >= event.sequence) continue;
      const key = deliveryKey(event);
      this.#removeLiveDelivery(key);
      if (this.#catchupQueue.some((delivery) => delivery.key === key)) continue;
      this.#catchupQueue.push({ ...item, key, bytes: eventBytes(event) });
      this.#knownKeys.add(key);
      this.#recordHighest(event);
    }
    this.#catchupActive = this.#catchupQueue.length > 0 || page.hasMore;
    if (page.hasMore && this.#catchupQueue.length === 0) {
      this.#fail(
        new Error("invocation delivery catch-up page reported more entries without progress"),
      );
      return false;
    }
    if (!this.#catchupActive && this.#needsCatchup) {
      this.#schedule();
      return false;
    }
    return true;
  }

  #nextDelivery(): QueuedDelivery | undefined {
    if (this.#catchupQueue.length > 0) return this.#catchupQueue.shift();
    if (this.#catchupActive) return undefined;
    const next = this.#liveBuffer.entries().next();
    if (next.done) return undefined;
    const [key, delivery] = next.value;
    this.#liveBuffer.delete(key);
    this.#liveBufferBytes -= delivery.bytes;
    return delivery;
  }

  #markAcknowledged(delivery: QueuedDelivery): void {
    const { event, key } = delivery;
    this.#knownKeys.delete(key);
    this.#ackedThrough.set(
      event.invocationId,
      Math.max(this.#ackedThrough.get(event.invocationId) ?? 0, event.sequence),
    );
    this.#recordHighest(event);
  }

  #recordHighest(event: SparkInvocationEvent): void {
    this.#highestKnown.set(
      event.invocationId,
      Math.max(this.#highestKnown.get(event.invocationId) ?? 0, event.sequence),
    );
  }

  #discardLiveBuffer(): void {
    for (const key of this.#liveBuffer.keys()) this.#knownKeys.delete(key);
    this.#liveBuffer.clear();
    this.#liveBufferBytes = 0;
  }

  #removeLiveDelivery(key: string): QueuedDelivery | undefined {
    const delivery = this.#liveBuffer.get(key);
    if (!delivery) return undefined;
    this.#liveBuffer.delete(key);
    this.#liveBufferBytes -= delivery.bytes;
    return delivery;
  }

  #discardCatchupQueue(): void {
    for (const delivery of this.#catchupQueue) this.#knownKeys.delete(delivery.key);
    this.#catchupQueue = [];
  }

  #rebuildHighestKnown(): void {
    this.#highestKnown = new Map(this.#ackedThrough);
    if (this.#inFlight) this.#recordHighest(this.#inFlight.delivery.event);
    for (const delivery of this.#catchupQueue) this.#recordHighest(delivery.event);
    for (const delivery of this.#liveBuffer.values()) this.#recordHighest(delivery.event);
  }

  #bindingForInvocation(invocationId: string): string | null | undefined {
    if (this.#bindingByInvocation.has(invocationId)) {
      return this.#bindingByInvocation.get(invocationId);
    }
    const bindingId = this.#options.bindingForInvocation(invocationId);
    this.#bindingByInvocation.set(invocationId, bindingId);
    return bindingId;
  }

  #armAckDeadline(inFlight: InFlightDelivery<Envelope>): void {
    const deadline: AckDeadline<Envelope> = { inFlight };
    this.#ackDeadline = deadline;
    const handle = this.#scheduleAckDeadline(() => {
      if (this.#ackDeadline !== deadline || this.#inFlight !== deadline.inFlight) return;
      this.#ackDeadline = undefined;
      this.#fail(
        new Error(
          `invocation delivery acknowledgement timed out after ${this.#ackTimeoutMs} ms: ${inFlight.envelope.messageId}`,
        ),
      );
    }, this.#ackTimeoutMs);
    deadline.handle = handle;

    // A deterministic scheduler may fire inline. Do not leave its returned
    // handle armed after that callback already failed or advanced the pump.
    if (this.#ackDeadline !== deadline) this.#cancelAckDeadline(handle);
  }

  #clearAckDeadline(): void {
    const deadline = this.#ackDeadline;
    if (!deadline) return;
    this.#ackDeadline = undefined;
    if (deadline.handle !== undefined) this.#cancelAckDeadline(deadline.handle);
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.close();
    this.#options.onFatal(error);
  }
}

function deliveryKey(event: SparkInvocationEvent): string {
  return `${event.invocationId}\u0000${event.sequence}`;
}

function normalizedBindings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function eventBytes(event: SparkInvocationEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
