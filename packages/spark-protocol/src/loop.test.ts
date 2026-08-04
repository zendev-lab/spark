import { describe, expect, it } from "vitest";
import {
  sparkLoopPolicySchema,
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
        policy: sparkLoopPolicySchema.parse({}),
        counters: {},
        dueAt: "2026-07-23T00:00:00.000Z",
        attempt: 0,
      }),
    ).toMatchObject({ generation: 3, binding: {} });
  });

  it("accepts typed conditions and only trusted evaluator selectors", () => {
    expect(
      sparkLoopPolicySchema.parse({
        beforeTick: [
          {
            id: "skip-completed",
            when: {
              kind: "expression",
              expression: { op: "eq", path: "loop.status", value: "completed" },
            },
            then: { action: "skip", delayMs: 1_000 },
          },
        ],
        completion: { selector: "extension:workspace-review", input: { strict: true } },
      }),
    ).toMatchObject({
      beforeTick: [{ id: "skip-completed" }],
      completion: { selector: "extension:workspace-review" },
    });
    expect(() =>
      sparkLoopPolicySchema.parse({
        completion: { selector: "shell:test -f ready", input: {} },
      }),
    ).toThrow();
    expect(() =>
      sparkLoopPolicySchema.parse({
        beforeTick: [
          {
            id: "arbitrary-js",
            when: { kind: "javascript", source: "return true" },
            then: { action: "proceed" },
          },
        ],
      }),
    ).toThrow();
  });
});
