import { describe, expect, it } from "vitest";
import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import {
  groupWorkbenchSessionsByType,
  workbenchSessionType,
  type WorkbenchSessionGroupLike,
} from "./workbench-session-groups";

const sessionsMessages = getHubDictionary("en").sessions;
const options = {
  channelLabels: sessionsMessages.channelLabels,
  fallback: sessionsMessages.untitledConversation,
  labels: sessionsMessages.sessionTypes,
};

describe("workbench session type groups", () => {
  it.each([
    [session("administrator", { lineage: { kind: "root" } }), "administrator"],
    [session("workspace"), "workspace"],
    [channelSession("infoflow:user:alice"), "private"],
    [channelSession("qqbot:c2c:alice"), "private"],
    [channelSession("infoflow:group:ops"), "group"],
    [channelSession("qqbot:group:ops"), "group"],
    [channelSession("qqbot:channel:dev"), "channel"],
    [channelSession("feishu:chat:oc_ops"), "conversation"],
  ] as const)("classifies %s as %s", (value, expected) => {
    expect(workbenchSessionType(value, options)).toBe(expected);
  });

  it("does not create a group for daemon-global sessions", () => {
    const daemon = session("daemon", { scope: { kind: "daemon", daemonId: "local" } });

    expect(workbenchSessionType(daemon, options)).toBeNull();
    expect(groupWorkbenchSessionsByType([session("workspace"), daemon], options)).toEqual([
      expect.objectContaining({ key: "workspace" }),
    ]);
  });

  it("uses binding identity with a custom title and legacy title-only identity", () => {
    expect(
      workbenchSessionType(channelSession("infoflow:group:ops", { name: "Operations" }), options),
    ).toBe("group");
    expect(
      workbenchSessionType(session("legacy", { name: "channel qqbot:c2c:398418FB" }), options),
    ).toBe("private");
  });

  it("keeps an unparsable channel binding in the messaging fallback group", () => {
    expect(
      workbenchSessionType(
        session("unknown-channel", {
          bindings: [{ kind: "channel", adapter: "custom", externalKey: "custom:room:ops" }],
        }),
        options,
      ),
    ).toBe("conversation");
  });

  it("keeps a stable type order and attention order without mutating input", () => {
    const input = [
      session("administrator", { lineage: { kind: "root" } }),
      channelSession("infoflow:group:old", { updatedAt: "2026-07-14T08:00:00Z" }),
      session("workspace"),
      channelSession("infoflow:group:running", {
        activity: "running",
        updatedAt: "2026-07-14T07:00:00Z",
      }),
      channelSession("qqbot:c2c:alice"),
    ];

    const groups = groupWorkbenchSessionsByType(input, options);

    expect(groups.map((group) => group.key)).toEqual([
      "administrator",
      "workspace",
      "private",
      "group",
    ]);
    expect(groups.at(-1)?.sessions.map((value) => value.sessionId)).toEqual([
      "infoflow:group:running",
      "infoflow:group:old",
    ]);
    expect(input.map((value) => value.sessionId)).toEqual([
      "administrator",
      "infoflow:group:old",
      "workspace",
      "infoflow:group:running",
      "qqbot:c2c:alice",
    ]);
  });
});

function session(
  sessionId: string,
  overrides: Partial<WorkbenchSessionGroupLike> = {},
): WorkbenchSessionGroupLike {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "ws_spore" },
    activity: "idle",
    name: sessionId,
    updatedAt: "2026-07-14T09:00:00Z",
    ...overrides,
  };
}

function channelSession(
  externalKey: string,
  overrides: Partial<WorkbenchSessionGroupLike> = {},
): WorkbenchSessionGroupLike {
  return session(externalKey, {
    name: `channel ${externalKey}`,
    bindings: [
      {
        kind: "channel",
        adapter: externalKey.split(":", 1)[0],
        externalKey,
      },
    ],
    ...overrides,
  });
}
