/**
 * Zero-dependency read-model rules shared by spark-web and spark-hub.
 *
 * These rules copy the dsh-session-projection contract without importing DSH:
 * state events carry complete post-change values, consumers last-wins, asOfSeq
 * is a consistent cut, and stateVersion is the projection cache invalidation
 * anchor. Cordis session projection services stay out of Hub and browser
 * read paths.
 */

import {
  sparkSessionSnapshotPageSchema,
  type SparkSessionSnapshotHistory,
  type SparkSessionSnapshotPage,
} from "./protocol.ts";

export const SPARK_SESSION_PROJECTION_WHOLE_VALUE = "whole-value" as const;
export const SPARK_SESSION_PROJECTION_AS_OF_SEQ = "as-of-seq" as const;
export const SPARK_SESSION_PROJECTION_STATE_VERSION = "state-version" as const;

export interface SparkProjectedStateEvent<T> {
  /** Monotonic sequence of the consistent cut that produced this value. */
  asOfSeq: number;
  /** Cache invalidation anchor for the projected value. */
  stateVersion: string;
  /** Complete post-change state. Consumers must not patch fields locally. */
  state: T;
}

export interface SparkProjectionCacheEntry<T> {
  asOfSeq: number;
  stateVersion: string;
  state: T;
}

/** Last-wins adoption of a whole-value projected state. */
export function adoptWholeValueProjection<T>(
  previous: SparkProjectionCacheEntry<T> | null,
  next: SparkProjectedStateEvent<T>,
): SparkProjectionCacheEntry<T> {
  if (!previous) {
    return { asOfSeq: next.asOfSeq, stateVersion: next.stateVersion, state: next.state };
  }
  if (next.asOfSeq < previous.asOfSeq) return previous;
  if (next.asOfSeq === previous.asOfSeq && next.stateVersion === previous.stateVersion) {
    return previous;
  }
  return { asOfSeq: next.asOfSeq, stateVersion: next.stateVersion, state: next.state };
}

/** True when a cached projection is still valid for the given stateVersion. */
export function isProjectionCacheCurrent(
  cached: Pick<SparkProjectionCacheEntry<unknown>, "stateVersion"> | null,
  stateVersion: string,
): boolean {
  return cached !== null && cached.stateVersion === stateVersion;
}

/**
 * Inclusive consistent cut: keep records whose sequence is <= asOfSeq.
 * Records above the cut are not visible to the consumer.
 */
export function sliceAsOfSeq<T extends { seq: number }>(
  records: readonly T[],
  asOfSeq: number,
): T[] {
  return records.filter((record) => record.seq <= asOfSeq);
}

export function projectionCacheKey(stateVersion: string): string {
  return `spark:projection:${stateVersion}`;
}

export const SPARK_SESSION_SNAPSHOT_PAGE_SIZE = 32;
export const SPARK_SESSION_SNAPSHOT_MAX_MESSAGES = 10_000;
export const SPARK_SESSION_CONVERSATION_ANCHOR_BATCH = 3;
export const SPARK_SESSION_CONVERSATION_PAGE_BUDGET = 8;

export type SparkSessionSnapshotWindowHistory = SparkSessionSnapshotHistory;
export type SparkSessionSnapshotWindow = SparkSessionSnapshotPage;

export function normalizeSparkSessionSnapshotLimit(value: unknown): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return SPARK_SESSION_SNAPSHOT_PAGE_SIZE;
  }
  return Math.min(
    SPARK_SESSION_SNAPSHOT_MAX_MESSAGES,
    Math.max(SPARK_SESSION_SNAPSHOT_PAGE_SIZE, Math.floor(parsed)),
  );
}

export function parseSparkSessionSnapshotWindow(value: unknown): SparkSessionSnapshotWindow {
  return sparkSessionSnapshotPageSchema.parse(value);
}

/** Expand raw pages until the client has several complete user-anchored turns. */
export async function hydrateSparkSessionConversationWindow(
  initial: SparkSessionSnapshotWindow,
  options: {
    minimumAnchors: number;
    loadEarlier: (beforeMessageId: string) => Promise<SparkSessionSnapshotWindow>;
    pageBudget?: number;
  },
): Promise<SparkSessionSnapshotWindow> {
  let window = initial;
  const minimumAnchors = Math.max(1, Math.floor(options.minimumAnchors));
  const pageBudget = Math.max(
    1,
    Math.floor(options.pageBudget ?? SPARK_SESSION_CONVERSATION_PAGE_BUDGET),
  );

  for (
    let page = 0;
    page < pageBudget &&
    window.history.hasEarlierMessages &&
    sparkSessionConversationAnchorCount(window) < minimumAnchors;
    page += 1
  ) {
    const cursor = window.history.nextBeforeMessageId;
    if (!cursor) break;
    window = mergeEarlierSparkSessionSnapshotWindow(window, await options.loadEarlier(cursor));
  }
  return window;
}

export function sparkSessionConversationAnchorCount(window: SparkSessionSnapshotWindow): number {
  return window.snapshot.messages.filter((message) => message.role === "user").length;
}

/** Merge one exclusive-cursor older page into a cumulative latest browser window. */
export function mergeEarlierSparkSessionSnapshotWindow(
  current: SparkSessionSnapshotWindow,
  earlierPage: SparkSessionSnapshotWindow,
): SparkSessionSnapshotWindow {
  if (current.snapshot.sessionId !== earlierPage.snapshot.sessionId) {
    throw new Error("cannot merge session snapshot pages from different sessions");
  }
  if (current.history.laterMessages !== 0) {
    throw new Error("current session snapshot window is not a cumulative latest window");
  }
  const pageEnd = earlierPage.history.totalMessages - earlierPage.history.laterMessages;
  if (pageEnd !== current.history.earlierMessages) {
    throw new Error("session snapshot pages are not contiguous");
  }
  if (earlierPage.snapshot.messages.length === 0) {
    throw new Error("session snapshot cursor did not advance");
  }
  if (
    earlierPage.history.hasEarlierMessages &&
    earlierPage.history.nextBeforeMessageId === current.history.nextBeforeMessageId
  ) {
    throw new Error("session snapshot continuation cursor did not advance");
  }
  const currentNativeSuffixMessages = earlierPage.history.laterMessages;
  if (current.snapshot.messages.length < currentNativeSuffixMessages) {
    throw new Error("current session snapshot is missing newer transcript messages");
  }
  const overlayMessages = current.snapshot.messages.length - currentNativeSuffixMessages;
  const messages = uniqueProjectionRecords([
    ...earlierPage.snapshot.messages,
    ...current.snapshot.messages,
  ]);
  const expectedLoadedMessages =
    earlierPage.history.loadedMessages + current.snapshot.messages.length;
  if (messages.length !== expectedLoadedMessages) {
    throw new Error("session snapshot pages overlap");
  }
  const tools = uniqueProjectionRecords([...earlierPage.snapshot.tools, ...current.snapshot.tools]);
  const earlierMessages = earlierPage.history.earlierMessages;
  return sparkSessionSnapshotPageSchema.parse({
    snapshot: { ...current.snapshot, messages, tools },
    history: {
      totalMessages: earlierPage.history.totalMessages + overlayMessages,
      loadedMessages: messages.length,
      hiddenMessages: earlierMessages,
      earlierMessages,
      laterMessages: 0,
      hasEarlierMessages: earlierMessages > 0,
      ...(earlierMessages > 0 && earlierPage.history.nextBeforeMessageId
        ? { nextBeforeMessageId: earlierPage.history.nextBeforeMessageId }
        : {}),
    },
  });
}

function uniqueProjectionRecords<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}
