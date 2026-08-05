import { describe, expect, it } from "vitest";
import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { buildHubSearchResults } from "./hub-search";

const baseInput = {
  sessions: [
    {
      sessionId: "sess_workspace",
      workspaceId: "ws_spore",
      title: "Effect handlers",
      status: "ready",
      activityStatus: "running",
    },
    {
      sessionId: "sess_daemon",
      scope: { kind: "daemon" as const, daemonId: "local", daemonLabel: "Local daemon" },
      title: "Global chat",
      status: "ready",
    },
  ],
  workspaces: [{ id: "ws_spore", slug: "spore", name: "Spore" }],
  untitledConversationLabel: "Untitled",
  channelLabels: getHubDictionary("en").sessions.channelLabels,
  statusLabels: { ready: "Ready", running: "Running" },
};

describe("hub search", () => {
  it("finds workspace conversations and uses their activity status", () => {
    expect(buildHubSearchResults({ ...baseInput, query: "effect" })).toEqual([
      expect.objectContaining({
        id: "sess_workspace",
        description: "Spore",
        status: "running",
        href: "/spore/sessions/sess_workspace",
      }),
    ]);
  });

  it("never surfaces daemon-scoped conversations in the workspace-scoped search", () => {
    expect(buildHubSearchResults({ ...baseInput, query: "global" })).toEqual([]);
    expect(buildHubSearchResults({ ...baseInput, query: "local daemon" })).toEqual([]);
  });

  it("returns workspace links after conversation matches", () => {
    expect(buildHubSearchResults({ ...baseInput, query: "spore" })).toEqual([
      expect.objectContaining({ id: "sess_workspace", type: "session" }),
      expect.objectContaining({ id: "ws_spore", type: "workspace", href: "/spore" }),
    ]);
  });
});
