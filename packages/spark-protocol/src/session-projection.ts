/**
 * Zero-dependency read-model rules shared by spark-web and spark-hub.
 *
 * These rules copy the dsh-session-projection contract without importing DSH:
 * state events carry complete post-change values, consumers last-wins, asOfSeq
 * is a consistent cut, and stateVersion is the projection cache invalidation
 * anchor. Cordis session projection services stay out of Hub and browser
 * read paths.
 */

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
