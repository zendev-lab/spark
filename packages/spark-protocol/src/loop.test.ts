import { describe, expect, it } from "vitest";
import {
  sparkLoopScheduleRequestSchema,
  sparkLoopStartRequestSchema,
  sparkLoopViewSchema,
} from "./loop.ts";

describe("Spark loop protocol", () => {
  it("defaults ordinary loops to session continuity and accepts fresh explicitly", () => {
    expect(
      sparkLoopStartRequestSchema.parse({
        ownerSessionId: "owner",
        cwd: "/workspace",
        prompt: "tick",
      }),
    ).toMatchObject({ continuity: "session" });
    expect(
      sparkLoopStartRequestSchema.parse({
        ownerSessionId: "owner",
        continuity: "fresh",
        cwd: "/workspace",
        prompt: "tick",
      }),
    ).toMatchObject({ continuity: "fresh" });
  });

  it("exposes generation as the projection and control compare-and-swap fence", () => {
    expect(
      sparkLoopScheduleRequestSchema.parse({
        loopId: "loop-one",
        generation: 3,
        delayMs: 1_000,
      }),
    ).toEqual({ loopId: "loop-one", generation: 3, delayMs: 1_000 });
    expect(
      sparkLoopViewSchema.parse({
        loopId: "loop-one",
        ownerSessionId: "owner",
        status: "scheduled",
        continuity: "fresh",
        generation: 3,
        binding: {},
        dueAt: "2026-07-23T00:00:00.000Z",
        attempt: 0,
      }),
    ).toMatchObject({ generation: 3, binding: {} });
  });
});
