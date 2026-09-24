import { describe, expect, it } from "vitest";
import {
  sidebarChannels,
  sidebarBotProfile,
  sidebarGroups,
  visibleSidebarSessions,
  type SidebarSession,
} from "./sidebar";

function sidebarSession(
  sessionId: string,
  overrides: Partial<SidebarSession> = {},
): SidebarSession {
  return {
    sessionId,
    name: sessionId,
    scope: { kind: "workspace", workspaceId: "spark" },
    lineage: { kind: "child", parentSessionId: "administrator", origin: { kind: "session" } },
    bindings: [],
    roleBinding: { kind: "none" },
    placement: "active",
    activity: "idle",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("conversation sidebar grouping", () => {
  it("groups recent conversations by owner, excludes administrators and archives, and preserves the selected archive", () => {
    const data = {
      unavailable: false,
      workspaces: [],
      sessions: [
        sidebarSession("old"),
        sidebarSession("recent", { updatedAt: "2026-09-06T01:00:00.000Z" }),
        sidebarSession("admin", {
          lineage: { kind: "root" },
          roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
        }),
        sidebarSession("archived", { placement: "archived" }),
        sidebarSession("general", { scope: { kind: "daemon", daemonId: "daemon" } }),
      ],
    };
    const groups = sidebarGroups(data, undefined);
    expect(
      groups.map((group) => [group.id, group.sessions.map((session) => session.sessionId)]),
    ).toEqual([
      ["spark", ["recent", "old"]],
      [null, ["general"]],
    ]);
    expect(
      sidebarGroups(data, "archived")
        .flatMap((group) => group.sessions)
        .map((session) => session.sessionId),
    ).toContain("archived");
  });
  it("keeps a selected older conversation visible beside the five recent ones", () => {
    const sessions = Array.from({ length: 12 }, (_, index) => sidebarSession(`session-${index}`));
    expect(
      visibleSidebarSessions(sessions, false, "session-9").map((session) => session.sessionId),
    ).toEqual(["session-0", "session-1", "session-2", "session-3", "session-4", "session-9"]);
    expect(visibleSidebarSessions(sessions, true)).toEqual(sessions);
  });
});

it("pins bound channel conversations ahead of workspace groups without leaking them into General", () => {
  const channel = sidebarSession("qq", {
    name: "Custom chat",
    scope: { kind: "daemon", daemonId: "daemon" },
    bindings: [
      {
        kind: "channel",
        adapter: "qqbot",
        externalKey: "qqbot:c2c:7B0470990647FE7AC9ECF1821A7FA349",
      },
    ],
  });
  const data = {
    unavailable: false,
    workspaces: [],
    sessions: [sidebarSession("recent"), channel],
  };
  expect(sidebarChannels(data).map((session) => session.sessionId)).toEqual(["qq"]);
  expect(
    sidebarGroups(data, undefined)
      .flatMap((group) => group.sessions)
      .map((session) => session.sessionId),
  ).toEqual(["recent"]);
});

it("resolves bot identity by stable account without falling through to a different account", () => {
  const session = sidebarSession("qq", {
    name: "channel qqbot:c2c:openid",
    bindings: [
      {
        kind: "channel",
        adapter: "qqbot",
        adapterId: "old-name",
        adapterAccountIdentity: "account-a",
        externalKey: "qqbot:c2c:openid",
      },
    ],
  });
  const a = {
    id: "new-name",
    type: "qqbot",
    adapterAccountIdentity: "account-a",
    running: true,
    state: "connected" as const,
    botProfile: { displayName: "A" },
  };
  const b = {
    ...a,
    id: "old-name",
    adapterAccountIdentity: "account-b",
    botProfile: { displayName: "B" },
  };
  const data = { unavailable: false, workspaces: [], sessions: [], channelAdapters: [a, b] };
  expect(sidebarBotProfile(session, data)?.displayName).toBe("A");
  expect(sidebarBotProfile(session, { ...data, channelAdapters: [b] })).toBeUndefined();
  const legacy = { ...session, bindings: [] };
  expect(sidebarBotProfile(legacy, data)).toBeUndefined();
  expect(sidebarBotProfile(legacy, { ...data, channelAdapters: [a] })?.displayName).toBe("A");
});
