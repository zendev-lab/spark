import { describe, expect, it } from "vitest";
import { sparkSessionActivityOptions } from "./session-assignment.ts";
import {
  sparkSessionViewStatusAfterPendingTurns,
  sparkViewModelStatusFromPendingTurns,
  sparkViewModelStatusFromSessionActivity,
} from "./protocol.ts";

describe("session view status projection", () => {
  it.each(sparkSessionActivityOptions)(
    "maps session activity %s onto the same view status",
    (activity) => {
      expect(sparkViewModelStatusFromSessionActivity(activity)).toBe(activity);
    },
  );

  it("derives pending-turn view status from running, queued, and idle sets", () => {
    expect(sparkViewModelStatusFromPendingTurns([{ status: "running" }])).toBe("running");
    expect(
      sparkViewModelStatusFromPendingTurns([{ status: "queued" }, { status: "running" }]),
    ).toBe("running");
    expect(sparkViewModelStatusFromPendingTurns([{ status: "queued" }])).toBe("queued");
    expect(sparkViewModelStatusFromPendingTurns([])).toBe("idle");
  });

  it("demotes stale busy snapshot status after pending turns drain", () => {
    expect(sparkSessionViewStatusAfterPendingTurns([], "running")).toBe("idle");
    expect(sparkSessionViewStatusAfterPendingTurns([], "streaming")).toBe("idle");
    expect(sparkSessionViewStatusAfterPendingTurns([], "queued")).toBe("idle");
    expect(sparkSessionViewStatusAfterPendingTurns([], "waiting")).toBe("waiting");
    expect(sparkSessionViewStatusAfterPendingTurns([{ status: "queued" }], "running")).toBe(
      "queued",
    );
    expect(sparkSessionViewStatusAfterPendingTurns([{ status: "running" }], "idle")).toBe(
      "running",
    );
  });
});
