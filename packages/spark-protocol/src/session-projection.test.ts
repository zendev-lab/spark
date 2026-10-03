import { describe, expect, it } from "vitest";

import {
  adoptWholeValueProjection,
  isProjectionCacheCurrent,
  projectionCacheKey,
  sliceAsOfSeq,
  type SparkProjectedStateEvent,
} from "./session-projection.ts";

describe("session projection contract", () => {
  it("adopts complete post-change state with last-wins by asOfSeq", () => {
    const first: SparkProjectedStateEvent<{ status: string }> = {
      asOfSeq: 2,
      stateVersion: "v2",
      state: { status: "running" },
    };
    const cached = adoptWholeValueProjection(null, first);
    expect(cached.state).toEqual({ status: "running" });

    const stale: SparkProjectedStateEvent<{ status: string }> = {
      asOfSeq: 1,
      stateVersion: "v1",
      state: { status: "queued" },
    };
    expect(adoptWholeValueProjection(cached, stale)).toBe(cached);

    const next: SparkProjectedStateEvent<{ status: string }> = {
      asOfSeq: 3,
      stateVersion: "v3",
      state: { status: "idle" },
    };
    expect(adoptWholeValueProjection(cached, next)).toEqual({
      asOfSeq: 3,
      stateVersion: "v3",
      state: { status: "idle" },
    });
  });

  it("uses stateVersion as the cache invalidation anchor", () => {
    const cached = { asOfSeq: 4, stateVersion: "rev-4", state: { ok: true } };
    expect(isProjectionCacheCurrent(cached, "rev-4")).toBe(true);
    expect(isProjectionCacheCurrent(cached, "rev-5")).toBe(false);
    expect(isProjectionCacheCurrent(null, "rev-4")).toBe(false);
    expect(projectionCacheKey("rev-4")).toBe("spark:projection:rev-4");
  });

  it("cuts records at asOfSeq inclusive", () => {
    const records = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];
    expect(sliceAsOfSeq(records, 3)).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    expect(sliceAsOfSeq(records, 0)).toEqual([]);
  });
});
