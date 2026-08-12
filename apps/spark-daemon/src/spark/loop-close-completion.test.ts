import { describe, expect, it } from "vitest";
import type { SparkLoopRecord } from "../store/loops.ts";
import { loopDriverCloseCandidate, loopTickCloseCandidate } from "./loop-close-completion.ts";

describe("Loop Session close completion", () => {
  it("uses the driver_tick final assistant result", () => {
    expect(
      loopTickCloseCandidate("inv-tick", {
        status: "succeeded",
        result: { assistantText: "Tick advanced the bounded stage." },
      }),
    ).toEqual({
      source: "terminal_result",
      status: "completed",
      code: "loop_tick_completed",
      summary: "Tick advanced the bounded stage.",
      evidenceRefs: [],
      artifactRefs: [],
      sourceInvocationIds: ["inv-tick"],
    });
  });

  it("uses the final evaluation while sourcing the driver Session tick", () => {
    const candidate = loopDriverCloseCandidate({
      loopId: "loop-final",
      ownerSessionId: "session-owner",
      driverSessionId: "session-driver",
      status: "completed",
      sessionLifetime: "driver",
      continuity: "session",
      generation: 2,
      binding: {},
      policy: {
        cadenceMs: 30_000,
        retry: { maxAttempts: 3, delaysMs: [30_000] },
        beforeTick: [],
        afterTick: [],
      },
      checkpoint: {
        cycleId: "cycle-final",
        generation: 1,
        step: "settle",
        startedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:02.000Z",
        tick: {
          invocationId: "inv-driver-tick",
          status: "succeeded",
          completedAt: "2026-08-10T00:00:01.000Z",
        },
        receipts: [
          {
            receiptId: "receipt-final",
            checkpoint: "after_tick",
            selector: "builtin:completion",
            inputSummary: {},
            definitionDigest: "digest-final",
            verdict: "achieved",
            reason: "The Loop objective is verified.",
            evidenceRefs: ["evidence:loop-proof"],
            blockers: [],
            evaluatedAt: "2026-08-10T00:00:02.000Z",
          },
        ],
        beforeAttempt: 0,
        afterAttempt: 0,
      },
      counters: {
        tickCount: 1,
        skippedCount: 0,
        llmRequestsAvoided: 0,
        conditionRetryCount: 0,
      },
      attempt: 0,
      lastInvocationId: "inv-owner-evaluation",
      reason: "completed",
      prompt: "advance",
      route: { cwd: "/workspace" },
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
    } satisfies SparkLoopRecord);

    expect(candidate).toMatchObject({
      source: "domain_completion",
      status: "completed",
      code: "loop_completed",
      summary: "The Loop objective is verified.",
      evidenceRefs: ["evidence:loop-proof"],
      sourceInvocationIds: ["inv-driver-tick"],
    });
  });
});
