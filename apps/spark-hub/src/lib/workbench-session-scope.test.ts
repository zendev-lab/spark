import { describe, expect, it } from "vitest";
import {
  buildSessionRailTree,
  isSessionVisibleInWorkbenchRail,
  workbenchSessionScope,
  workspaceSessionsForWorkbench,
  workspaceIdForWorkbenchSession,
} from "./workbench-session-scope";

describe("workbench session scope", () => {
  it("shows only sessions scoped to the active workspace and hides daemon-scoped ones", () => {
    expect(
      isSessionVisibleInWorkbenchRail(
        { scope: { kind: "workspace", workspaceId: "ws_spore" } },
        "ws_spore",
      ),
    ).toBe(true);
    expect(
      isSessionVisibleInWorkbenchRail(
        { scope: { kind: "workspace", workspaceId: "spark" } },
        "ws_spore",
      ),
    ).toBe(false);
    expect(
      isSessionVisibleInWorkbenchRail(
        { scope: { kind: "daemon", daemonId: "daemon-a" } },
        "ws_spore",
      ),
    ).toBe(false);
  });

  it("uses the canonical workspace scope", () => {
    const session = {
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
    };

    expect(workbenchSessionScope(session)).toEqual({
      kind: "workspace",
      workspaceId: "ws_current",
    });
    expect(workspaceIdForWorkbenchSession(session)).toBe("ws_current");
  });

  it("keeps daemon-scoped sessions out of the workspace-scoped Hub view", () => {
    const session = { scope: { kind: "daemon" as const, daemonId: "daemon-a" } };
    expect(workbenchSessionScope(session)).toEqual({ kind: "daemon", daemonId: "daemon-a" });
    expect(workspaceIdForWorkbenchSession(session)).toBeNull();
  });

  it("projects daemon registry results to the active workspace only", () => {
    const workspaceSession = {
      sessionId: "sess_workspace",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
    };
    const channelSession = {
      sessionId: "sess_channel",
      scope: { kind: "workspace" as const, workspaceId: "ws_current" },
      bindings: [{ kind: "channel", externalKey: "infoflow:user:u1" }],
    };
    const daemonSession = {
      sessionId: "sess_daemon",
      scope: { kind: "daemon" as const, daemonId: "daemon-a" },
    };

    expect(
      workspaceSessionsForWorkbench(
        [
          workspaceSession,
          channelSession,
          daemonSession,
          {
            sessionId: "sess_other_workspace",
            scope: { kind: "workspace" as const, workspaceId: "ws_other" },
          },
        ],
        "ws_current",
      ),
    ).toEqual([workspaceSession, channelSession]);
  });

  it("builds adjacent parent and Side Thread rows without promoting orphans", () => {
    const parentA = { sessionId: "parent-a", placement: "active" };
    const parentB = { sessionId: "parent-b", placement: "active" };
    const child = {
      sessionId: "child-a",
      placement: "active",
      owner: {
        kind: "side_thread",
        parentSessionId: parentA.sessionId,
        generation: 2,
      },
    };
    const archived = {
      ...child,
      sessionId: "child-archived",
      placement: "archived",
    };
    const orphan = {
      ...child,
      sessionId: "child-orphan",
      owner: { ...child.owner, parentSessionId: "missing-parent" },
    };

    expect(buildSessionRailTree([parentA, child, parentB, archived, orphan])).toEqual([
      { session: parentA, ariaLevel: 1, orphaned: false },
      {
        session: child,
        ariaLevel: 2,
        parentSessionId: parentA.sessionId,
        orphaned: false,
      },
      { session: parentB, ariaLevel: 1, orphaned: false },
      {
        session: orphan,
        ariaLevel: 2,
        parentSessionId: "missing-parent",
        orphaned: true,
      },
    ]);
    expect(
      buildSessionRailTree([parentA, child, parentB, archived], { includeArchived: true }).map(
        ({ session }) => session.sessionId,
      ),
    ).toEqual(["parent-a", "child-a", "child-archived", "parent-b"]);
  });
});
