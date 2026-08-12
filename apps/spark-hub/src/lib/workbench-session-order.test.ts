import { describe, expect, it } from "vitest";
import {
  orderWorkbenchSessionsByAttention,
  workbenchSessionNeedsAttention,
  type WorkbenchSessionOrderLike,
} from "./workbench-session-order";

describe("workbench session attention ordering", () => {
  it("puts every attention state ahead of newer ordinary history", () => {
    const ordered = orderWorkbenchSessionsByAttention([
      session("idle-newest", "idle", "2026-07-13T10:00:00.000Z"),
      session("running", "running", "2026-07-13T06:00:00.000Z"),
      session("idle-older", "idle", "2026-07-13T07:00:00.000Z"),
      session("queued", "queued", "2026-07-13T08:30:00.000Z"),
    ]);

    expect(ordered.map((item) => item.sessionId)).toEqual([
      "queued",
      "running",
      "idle-newest",
      "idle-older",
    ]);
  });

  it("uses only Invocation-derived activity", () => {
    const reusableSession = session("reusable", "idle", "2026-07-13T10:00:00.000Z");
    const queuedSession = session("queued", "queued", "2026-07-13T08:00:00.000Z");

    expect(workbenchSessionNeedsAttention(reusableSession)).toBe(false);
    expect(workbenchSessionNeedsAttention(queuedSession)).toBe(true);
    expect(
      orderWorkbenchSessionsByAttention([reusableSession, queuedSession]).map(
        (item) => item.sessionId,
      ),
    ).toEqual(["queued", "reusable"]);
  });

  it("uses the latest activity timestamp and does not mutate server order", () => {
    const sessions = [
      session("newer-session", "idle", "2026-07-13T09:00:00.000Z"),
      session("older-session-new-activity", "idle", "2026-07-13T07:00:00.000Z", {
        activityUpdatedAt: "2026-07-13T10:00:00.000Z",
      }),
    ];

    const ordered = orderWorkbenchSessionsByAttention(sessions);

    expect(ordered.map((item) => item.sessionId)).toEqual([
      "older-session-new-activity",
      "newer-session",
    ]);
    expect(sessions.map((item) => item.sessionId)).toEqual([
      "newer-session",
      "older-session-new-activity",
    ]);
    expect(ordered).not.toBe(sessions);
  });
});

function session(
  sessionId: string,
  activity: "idle" | "queued" | "running",
  updatedAt: string,
  overrides: Partial<WorkbenchSessionOrderLike> = {},
): WorkbenchSessionOrderLike {
  return {
    sessionId,
    activity,
    updatedAt,
    ...overrides,
  };
}
