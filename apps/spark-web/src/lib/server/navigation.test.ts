import { describe, expect, it } from "vitest";
import { loadSparkWebNavigation } from "./navigation";
import type { SparkWebDaemonInvoker } from "./rpc";

describe("shell navigation load", () => {
  it("follows the daemon session cursor so older workspaces remain navigable", async () => {
    const cursors: unknown[] = [];
    const invoke = (async (method: string, input: { cursor?: string }) => {
      if (method === "workspace.list")
        return { workspaces: [{ id: "spark", displayName: "Spark" }] };
      if (method === "channel.status") return { adapters: [] };
      cursors.push(input.cursor);
      if (!input.cursor) return [{ sessionId: "recent" }];
      if (input.cursor === "recent") return [{ sessionId: "older" }];
      return [];
    }) as SparkWebDaemonInvoker;
    const data = await loadSparkWebNavigation(invoke);
    expect(cursors).toEqual([undefined, "recent", "older"]);
    expect(data.sessions.map((session) => session.sessionId)).toEqual(["recent", "older"]);
    expect(data.unavailable).toBe(false);
  });
  it("keeps the shell available during daemon disconnection", async () => {
    const invoke = (async () => {
      throw new Error("socket unavailable");
    }) as SparkWebDaemonInvoker;
    expect(await loadSparkWebNavigation(invoke)).toEqual({
      workspaces: [],
      sessions: [],
      unavailable: true,
    });
  });
});

it("keeps conversations available when optional bot metadata cannot be read", async () => {
  const invoke = (async (method: string) => {
    if (method === "workspace.list") return { workspaces: [] };
    if (method === "session.list") return [];
    throw new Error("profile unavailable");
  }) as SparkWebDaemonInvoker;
  expect(await loadSparkWebNavigation(invoke)).toEqual({
    workspaces: [],
    sessions: [],
    unavailable: false,
  });
});
