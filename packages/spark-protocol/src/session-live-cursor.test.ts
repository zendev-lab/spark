import { describe, expect, it } from "vitest";

import { sessionEventCursor, sessionEventCursorStorageKey } from "./session-live-cursor.ts";

describe("session event cursor helpers", () => {
  it("scopes storage keys by surface and session", () => {
    expect(sessionEventCursorStorageKey("hub", " sess_a ")).toBe(
      "spark:hub:session:sess_a:events-cursor",
    );
    expect(sessionEventCursorStorageKey("web", "sess_b")).toBe(
      "spark:web:session:sess_b:events-cursor",
    );
    expect(sessionEventCursorStorageKey("web", "   ")).toBeNull();
  });

  it("encodes sequence-aware cursors", () => {
    expect(
      sessionEventCursor({ createdAt: "2026-08-19T00:00:00.000Z", id: "evt_1", sequence: 3 }),
    ).toBe(
      "2026-08-19T00:00:00.000Z|evt_1".replace(
        "2026-08-19T00:00:00.000Z|evt_1",
        "3|2026-08-19T00:00:00.000Z|evt_1",
      ),
    );
    expect(
      sessionEventCursor({ createdAt: "2026-08-19T00:00:00.000Z", id: "evt_2", sequence: null }),
    ).toBe("2026-08-19T00:00:00.000Z|evt_2");
  });
});
