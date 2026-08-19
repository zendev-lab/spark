import { describe, expect, it } from "vitest";

import { parseSparkSessionView } from "./protocol.ts";
import {
  resolveSessionActivityState,
  resolveSessionPendingTurns,
  sessionActivityNeedsStatusProbe,
} from "./session-activity.ts";

describe("session activity contract", () => {
  it("uses daemon pendingTurns as last-wins queue truth", () => {
    const session = parseSparkSessionView({
      sessionId: "sess_1",
      status: "running",
      pendingTurns: [
        {
          invocationId: "inv_run",
          prompt: "hi",
          status: "running",
          createdAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    });
    const projected = [
      {
        commandId: "stale",
        invocationId: "stale",
        prompt: "old",
        status: "queued" as const,
        createdAt: "2026-08-19T00:00:00.000Z",
        startedAt: null,
      },
    ];
    expect(resolveSessionPendingTurns(projected, session)).toEqual([
      {
        commandId: "inv_run",
        invocationId: "inv_run",
        prompt: "hi",
        status: "running",
        createdAt: "2026-08-19T00:00:00.000Z",
        startedAt: null,
      },
    ]);
    const state = resolveSessionActivityState({ session, projectedTurns: projected });
    expect(state.phase).toBe("running");
    expect(state.runningTurnId).toBe("inv_run");
    expect(sessionActivityNeedsStatusProbe(state)).toBe(true);
  });
});
