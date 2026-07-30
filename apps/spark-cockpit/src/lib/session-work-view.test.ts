import { describe, expect, it } from "vitest";
import { parseSparkSessionView } from "@zendev-lab/spark-protocol";

import {
  defaultSessionPrimaryView,
  primarySessionDriver,
  requestedSessionPrimaryView,
  sessionWorkStatus,
} from "./session-work-view";

describe("session work view selection", () => {
  it("defaults work-backed and driver-backed sessions to Work", () => {
    expect(
      defaultSessionPrimaryView(
        parseSparkSessionView({
          sessionId: "goal",
          work: {
            goal: {
              goalId: "goal-1",
              objective: "Ship the slice",
              status: "active",
              updatedAt: "2026-07-28T00:00:00.000Z",
            },
          },
          status: "idle",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          evidence: [],
        }),
      ),
    ).toBe("work");
    expect(
      defaultSessionPrimaryView(
        parseSparkSessionView({
          sessionId: "driver",
          drivers: [
            {
              driverId: "driver-1",
              kind: "goal",
              ownerSessionId: "driver",
              status: "dormant",
              continuity: "session",
              attempt: 0,
            },
          ],
          status: "idle",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          evidence: [],
        }),
      ),
    ).toBe("work");
  });

  it("defaults ordinary conversations to Transcript and accepts only stable deep links", () => {
    expect(defaultSessionPrimaryView(undefined)).toBe("transcript");
    expect(
      defaultSessionPrimaryView(
        parseSparkSessionView({
          sessionId: "empty-work",
          work: {},
          status: "idle",
          messages: [],
          tools: [],
          runs: [],
          tasks: [],
          artifacts: [],
          evidence: [],
        }),
      ),
    ).toBe("transcript");
    expect(requestedSessionPrimaryView(new URL("https://spark.test/session?view=work"))).toBe(
      "work",
    );
    expect(requestedSessionPrimaryView(new URL("https://spark.test/session?view=transcript"))).toBe(
      "transcript",
    );
    expect(requestedSessionPrimaryView(new URL("https://spark.test/session?view=logs"))).toBe(
      undefined,
    );
  });

  it("joins primary work identity back to authoritative driver state", () => {
    const session = parseSparkSessionView({
      sessionId: "driver",
      work: { primary: { kind: "repro" as const, driverId: "driver-1" } },
      drivers: [
        {
          driverId: "driver-1",
          kind: "repro" as const,
          ownerSessionId: "driver",
          status: "retry_wait" as const,
          continuity: "session" as const,
          attempt: 2,
        },
      ],
      status: "idle" as const,
      messages: [],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
    });
    expect(primarySessionDriver(session)?.driverId).toBe("driver-1");
    expect(sessionWorkStatus(session)).toBe("retry_wait");
  });
});
