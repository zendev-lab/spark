import { describe, expect, it } from "vitest";

import { buildSessionTreeRows } from "./session-tree.ts";

describe("session tree rows", () => {
  it("flattens lineage and keeps every missing parent explicit", () => {
    const rows = buildSessionTreeRows([
      { sessionId: "parent", lineage: { kind: "root" as const } },
      {
        sessionId: "child",
        lineage: { kind: "child" as const, parentSessionId: "parent" },
      },
      {
        sessionId: "job-admin-helper",
        lineage: { kind: "child" as const, parentSessionId: "missing" },
      },
    ]);

    expect(
      rows.map(({ session, ariaLevel, diagnostic }) => [session.sessionId, ariaLevel, diagnostic]),
    ).toEqual([
      ["parent", 1, undefined],
      ["child", 2, undefined],
      ["job-admin-helper", 1, "orphan"],
    ]);
  });
});
