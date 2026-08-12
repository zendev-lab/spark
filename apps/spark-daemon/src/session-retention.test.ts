import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDaemonSessionRegistry } from "./session-registry.ts";
import { reconcileInactiveSessionRetention } from "./session-retention.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("inactive Session retention", () => {
  it("archives only inactive unassigned Sessions and makes policy tags searchable", async () => {
    const registry = await tempRegistry();
    const administrator = await registry.ensureWorkspaceAdministrator("ws_history");
    const stale = await registry.create({
      scope: { kind: "workspace", workspaceId: "ws_history" },
      supervisorSessionId: administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "none" },
      sessionId: "sess_stale",
      sessionPath: "/tmp/sess_stale.jsonl",
      now: new Date("2026-07-01T00:00:00.000Z") as never,
    } as never);
    await registry.create({
      scope: { kind: "workspace", workspaceId: "ws_history" },
      supervisorSessionId: administrator.sessionId,
      placement: "child",
      sessionId: "sess_role_owner",
      name: "Quality Verification",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-reviewer" },
      now: new Date("2026-07-01T00:00:00.000Z") as never,
    } as never);
    await registry.create({
      scope: { kind: "workspace", workspaceId: "ws_history" },
      supervisorSessionId: administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "none" },
      sessionId: "sess_recent",
      now: new Date("2026-08-20T00:00:00.000Z") as never,
    } as never);

    const result = await reconcileInactiveSessionRetention({
      registry,
      loopStore: { list: () => [] } as never,
      invocationStore: { sessionActivities: () => new Map() },
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ examined: 4, eligible: 1, archived: [stale.sessionId] });
    await expect(
      registry.list({ includeArchived: true, tags: ["policy:inactive-unassigned-30d"] }),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "sess_stale",
        placement: "archived",
        tags: expect.arrayContaining([
          "archive-source:retention",
          "policy:inactive-unassigned-30d",
          "last-active:2026-07",
        ]),
      }),
    ]);
    await expect(registry.get("sess_role_owner")).resolves.toMatchObject({ placement: "active" });
    await expect(registry.get("sess_recent")).resolves.toMatchObject({ placement: "active" });
  });

  it("does not archive a Goal/Repro owner while a daemon Loop remains active", async () => {
    const registry = await tempRegistry();
    const administrator = await registry.ensureWorkspaceAdministrator("ws_driver");
    await registry.create({
      scope: { kind: "workspace", workspaceId: "ws_driver" },
      sessionId: "sess_loop_owner",
      supervisorSessionId: administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "none" },
      now: new Date("2026-01-01T00:00:00.000Z") as never,
    } as never);

    const result = await reconcileInactiveSessionRetention({
      registry,
      loopStore: {
        list: ({ ownerSessionId }: { ownerSessionId?: string }) =>
          ownerSessionId === "sess_loop_owner" ? ([{ status: "dormant" }] as never) : [],
      } as never,
      invocationStore: { sessionActivities: () => new Map() },
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      eligible: 1,
      archived: [],
      skippedActiveLoop: ["sess_loop_owner"],
    });
    await expect(registry.get("sess_loop_owner")).resolves.toMatchObject({ placement: "active" });
  });
  it("does not archive a Session with queued/running invocation truth", async () => {
    const registry = await tempRegistry();
    const administrator = await registry.ensureWorkspaceAdministrator("ws_invocation");
    await registry.create({
      scope: { kind: "workspace", workspaceId: "ws_invocation" },
      supervisorSessionId: administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "none" },
      sessionId: "sess_invocation_owner",
      now: new Date("2026-01-01T00:00:00.000Z") as never,
    } as never);

    const result = await reconcileInactiveSessionRetention({
      registry,
      loopStore: { list: () => [] } as never,
      invocationStore: {
        sessionActivities: () =>
          new Map([
            [
              "sess_invocation_owner",
              {
                active: true,
                activity: "running",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          ]),
      },
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      eligible: 1,
      archived: [],
      skippedActiveInvocation: ["sess_invocation_owner"],
    });
    await expect(registry.get("sess_invocation_owner")).resolves.toMatchObject({
      placement: "active",
    });
  });
});

async function tempRegistry() {
  const root = await mkdtemp(join(tmpdir(), "spark-session-retention-"));
  roots.push(root);
  return createDaemonSessionRegistry(root);
}
