import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceWithLease,
  queueCommandForWorkspaceLease,
  recordInvocationUpdate,
} from "@zendev-lab/spark-hub-coordination/projection-services";
import { conversationActivityStatus, loadConversationSummaries } from "./conversation-summaries";
import { workspaceSessionRecord } from "../../../../../test/support/session-fixtures.ts";

describe("conversation summaries", () => {
  it("does not let a stale Hub invocation override settled daemon truth", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-10T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithLease(db, {
      slug: "local",
      name: "Local",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const workspaceId = workspace.id;

    const command = queueCommandForWorkspaceLease(db, {
      workspaceId,
      createdAt: "2026-07-10T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Improve the UI",
        payload: {
          goal: "Improve the UI",
          target: { sessionId: "sess_visible", workspaceId },
          source: { kind: "hub" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_visible",
        status: "running",
        agentName: "spark-runtime",
        payload: {},
      },
    });
    const invocation = db
      .prepare("SELECT updated_at AS updatedAt FROM mirrored_invocations WHERE command_id = ?")
      .get(command.id) as { updatedAt: string };

    const [summary] = loadConversationSummaries(db, [
      workspaceSessionRecord({
        sessionId: "sess_visible",
        workspaceId,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    expect(summary).toMatchObject({
      sessionId: "sess_visible",
      activityStatus: "ready",
      activityUpdatedAt: invocation.updatedAt,
    });
  });

  it("keeps settled daemon truth when stale activity exceeds the old row window", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-10T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithLease(db, {
      slug: "local",
      name: "Local",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });

    const visibleCommand = queueCommandForWorkspaceLease(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-10T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Keep visible status",
        payload: {
          goal: "Keep visible status",
          target: { sessionId: "sess_visible", workspaceId: workspace.id },
          source: { kind: "hub" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      commandId: visibleCommand.id,
      payload: {
        runtimeInvocationId: "inv_visible",
        status: "running",
        agentName: "spark-runtime",
        payload: {},
      },
    });

    for (let index = 0; index < 205; index += 1) {
      const createdAt = new Date(
        Date.parse("2026-07-10T01:00:00.000Z") + index * 1_000,
      ).toISOString();
      queueCommandForWorkspaceLease(db, {
        workspaceId: workspace.id,
        createdAt,
        payload: {
          kind: "assignment.create.request",
          title: `Unrelated ${index}`,
          payload: {
            goal: `Unrelated ${index}`,
            target: { sessionId: `sess_unrelated_${index}`, workspaceId: workspace.id },
            source: { kind: "hub" },
          },
        },
      });
    }

    const [summary] = loadConversationSummaries(db, [
      workspaceSessionRecord({
        sessionId: "sess_visible",
        workspaceId: workspace.id,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    expect(summary).toMatchObject({
      sessionId: "sess_visible",
      activityStatus: "ready",
    });
  });

  it("uses newer daemon conversation state instead of stale Web-only command state", () => {
    const db = openMemoryDatabase();
    migrate(db);
    const now = "2026-07-10T00:00:00.000Z";
    const runtimeId = createId("rt");
    const bindingId = createId("rtwb");
    db.prepare(
      `INSERT INTO runtime_connections
        (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
       VALUES (?, 'install', 'Runtime', 'online', ?, '{}', '{}', ?, ?)`,
    ).run(runtimeId, runtimeProtocolVersion, now, now);
    db.prepare(
      `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
       VALUES (?, ?, 'local', 'Local', 'available', '{}', '{}', ?, ?)`,
    ).run(bindingId, runtimeId, now, now);
    const workspace = createWorkspaceWithLease(db, {
      slug: "local",
      name: "Local",
      runtimeWorkspaceBindingId: bindingId,
      createdAt: now,
    });
    const command = queueCommandForWorkspaceLease(db, {
      workspaceId: workspace.id,
      createdAt: "2026-07-10T00:01:00.000Z",
      payload: {
        kind: "assignment.create.request",
        title: "Legacy Web turn",
        payload: {
          goal: "Legacy Web turn",
          target: { sessionId: "sess_unified", workspaceId: workspace.id },
          source: { kind: "hub" },
        },
      },
    });
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId: bindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId: "inv_legacy",
        status: "succeeded",
        agentName: "spark-runtime",
        payload: {},
      },
    });

    const [summary] = loadConversationSummaries(db, [
      workspaceSessionRecord({
        sessionId: "sess_unified",
        workspaceId: workspace.id,
        activity: "running",
        createdAt: now,
        updatedAt: "2099-07-10T00:10:00.000Z",
      }),
    ]);

    expect(summary).toMatchObject({
      activityStatus: "running",
      activityUpdatedAt: "2099-07-10T00:10:00.000Z",
    });
  });

  it("normalizes internal states without exposing the task model", () => {
    expect(conversationActivityStatus("needs-input")).toBe("blocked");
    expect(conversationActivityStatus("succeeded")).toBe("completed");
    expect(conversationActivityStatus("acked")).toBe("queued");
    expect(conversationActivityStatus("lost")).toBe("failed");
  });
});
