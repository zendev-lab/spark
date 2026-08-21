import { describe, expect, it } from "vitest";
import { daemonChannelSessionSummaries } from "./daemon-channel-session";

describe("daemonChannelSessionSummaries", () => {
  it("lists daemon Channel roots without exposing cwd, external keys, or account identity", () => {
    const summaries = daemonChannelSessionSummaries([
      {
        sessionId: "session-channel",
        name: "Support chat",
        scope: { kind: "daemon" },
        lineage: { kind: "root" },
        purpose: "channel",
        lifecycle: "open",
        placement: "active",
        activity: "running",
        updatedAt: "2026-08-21T12:00:00.000Z",
        cwd: "/private/daemon/channels/sessions/session-channel/workspace",
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            adapterId: "info-primary",
            adapterAccountIdentity: "channel-account:infoflow:private",
            externalKey: "infoflow:private:user-123",
          },
        ],
      },
      {
        sessionId: "workspace-session",
        scope: { kind: "workspace" },
        lineage: { kind: "root" },
        purpose: "interactive",
        lifecycle: "open",
        placement: "active",
        activity: "idle",
        updatedAt: "2026-08-21T12:00:00.000Z",
        bindings: [],
      },
    ]);

    expect(summaries).toEqual([
      {
        sessionId: "session-channel",
        name: "Support chat",
        lifecycle: "open",
        placement: "active",
        activity: "running",
        updatedAt: "2026-08-21T12:00:00.000Z",
        adapterIds: ["info-primary"],
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("/private/");
    expect(JSON.stringify(summaries)).not.toContain("user-123");
    expect(JSON.stringify(summaries)).not.toContain("channel-account:");
  });
});
