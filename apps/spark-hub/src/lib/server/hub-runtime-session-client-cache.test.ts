import { createWorkspaceWithLease } from "@zendev-lab/spark-hub-coordination/projection-services";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";
import {
  createHubRuntimeSessionClient,
  shouldRetainControlForStaleProjection,
} from "./hub-runtime-session-client";
import {
  getProjectedManagedSessionForHub,
  getProjectedManagedSessionSnapshotForHub,
} from "./managed-sessions";

describe("hub runtime session cache", () => {
  it("retains control only for explicit response timeouts with a stale projection", () => {
    const timeout = new RuntimeControlCommandError("timed out", "COMMAND_RESULT_TIMEOUT");
    const protocolFailure = new RuntimeControlCommandError("bad response", "INVALID_RESPONSE");

    expect(
      shouldRetainControlForStaleProjection([{ status: "rejected", reason: timeout }], true),
    ).toBe(true);
    expect(
      shouldRetainControlForStaleProjection(
        [{ status: "rejected", reason: protocolFailure }],
        true,
      ),
    ).toBe(false);
    expect(
      shouldRetainControlForStaleProjection([{ status: "rejected", reason: timeout }], false),
    ).toBe(false);
  });

  it("returns workspace projections without advertising control when the owner is offline", async () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-16T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, 'offline-cache-test', 'Offline owner', 'offline', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
         diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'offline-cache', 'Offline cache', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithLease(db, {
      slug: "offline-cache",
      name: "Offline cache",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const session = {
      sessionId: createId("sess"),
      scope: { kind: "workspace" as const, workspaceId: workspace.id },
      workspaceId: workspace.id,
      title: "Cached conversation",
      status: "ready" as const,
      bindings: [],
      createdAt: now,
      updatedAt: now,
    };
    const snapshot = {
      version: 1 as const,
      sessionId: session.sessionId,
      title: session.title,
      status: "idle" as const,
      messages: [
        {
          version: 1 as const,
          id: "msg_cached",
          role: "assistant" as const,
          text: "Cached response",
          status: "done" as const,
          metadata: {},
        },
      ],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    };
    db.prepare(
      `INSERT INTO runtime_session_projections
        (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id, status,
         record_json, snapshot_json, snapshot_total_messages, snapshot_loaded_messages,
         snapshot_hidden_messages, projected_at)
       VALUES (?, ?, 'workspace', ?, ?, 'ready', ?, ?, 1, 1, 0, ?)`,
    ).run(
      runtimeId,
      session.sessionId,
      workspace.id,
      bindingId,
      JSON.stringify(session),
      JSON.stringify(snapshot),
      now,
    );

    try {
      const client = createHubRuntimeSessionClient(db);
      const request = {
        scope: { kind: "workspace" as const, workspaceId: workspace.id },
        workspaceId: workspace.id,
      };

      await expect(client.listWithControlState(request)).resolves.toEqual({
        sessions: [session],
        controlAvailable: false,
      });
      await expect(client.list(request)).resolves.toEqual([session]);
      expect(getProjectedManagedSessionForHub(session.sessionId, db)).toEqual(session);
      expect(getProjectedManagedSessionSnapshotForHub(session.sessionId, db)).toEqual({
        snapshot,
        history: {
          totalMessages: 1,
          loadedMessages: 1,
          hiddenMessages: 0,
          earlierMessages: 0,
          laterMessages: 0,
          hasEarlierMessages: false,
        },
      });
    } finally {
      db.close();
    }
  });

  it("rejects direct side-thread submit", async () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-16T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
         created_at, updated_at)
       VALUES (?, 'side-thread-submit-test', 'Side Thread owner', 'offline', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
         diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'side-thread-submit', 'Side Thread submit', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithLease(db, {
      slug: "side-thread-submit",
      name: "Side Thread submit",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const child = {
      sessionId: createId("sess"),
      scope: { kind: "workspace" as const, workspaceId: workspace.id },
      workspaceId: workspace.id,
      title: "Context Side Thread",
      status: "ready" as const,
      bindings: [],
      relation: {
        kind: "side_thread" as const,
        parentSessionId: "sess_parent",
        generation: 1,
        mode: "contextual" as const,
      },
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO runtime_session_projections
        (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id, status,
         record_json, projected_at)
       VALUES (?, ?, 'workspace', ?, ?, 'ready', ?, ?)`,
    ).run(runtimeId, child.sessionId, workspace.id, bindingId, JSON.stringify(child), now);

    try {
      const client = createHubRuntimeSessionClient(db);
      await expect(
        client.submit({
          sessionId: child.sessionId,
          prompt: "bypass parent",
          assignment: {} as never,
        }),
      ).rejects.toMatchObject({ reasonCode: "side_thread_direct_submit_forbidden" });
    } finally {
      db.close();
    }
  });
});
