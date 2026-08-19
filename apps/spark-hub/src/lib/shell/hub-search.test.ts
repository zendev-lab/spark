import { describe, expect, it } from "vitest";
import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { parseSparkSessionProjection } from "@zendev-lab/spark-protocol";
import { buildHubSearchResults } from "./hub-search";
import { workspaceSessionRecord } from "../../../../../test/support/session-fixtures.ts";

const baseInput = {
  sessions: [
    {
      ...workspaceSessionRecord({
        sessionId: "sess_workspace",
        workspaceId: "ws_spore",
        name: "Effect handlers",
      }),
      activityStatus: "running",
    },
    parseSparkSessionProjection({
      sessionId: "sess_daemon",
      scope: { kind: "daemon", daemonId: "local" },
      name: "Global chat",
      lifecycle: "closed",
      placement: "archived",
      activity: "idle",
      lifetime: "ephemeral",
      roleBinding: { kind: "none" },
      lineage: {
        kind: "child",
        parentSessionId: "sess_legacy_daemon_audit",
        origin: {
          kind: "invocation",
          invocationId: "inv_legacy_daemon_audit",
        },
      },
      incarnation: 1,
      visibility: "internal",
      retention: "audit",
      purpose: "migration_closed_daemon_audit",
      bindings: [],
      tags: ["legacy-daemon-audit"],
      archiveHistory: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }),
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
