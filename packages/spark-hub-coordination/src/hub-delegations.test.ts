import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  type SparkDaemonDelegationRespondedEvent,
} from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { createWorkspaceWithLease } from "./projection-services.ts";
import {
  cancelHubWorkspaceDelegation,
  createHubWorkspaceDelegation,
  dispatchPendingHubDelegationsForRuntime,
  HubWorkspaceDelegationError,
  listHubWorkspaceDelegationMessages,
  listHubWorkspaceDelegationsForWorkspaceMember,
  recordHubWorkspaceDelegationCommandResult,
  recordHubWorkspaceDelegationCommandReject,
  recordHubWorkspaceDelegationDaemonEvent,
  replyHubWorkspaceDelegation,
  requireHubWorkspaceDelegation,
} from "./hub-delegations.ts";
import {
  recordRuntimeControlCommandReject,
  requireRuntimeControlCommand,
} from "./runtime-control.ts";

function setup(input: { online?: boolean } = {}) {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-08-03T00:00:00.000Z";
  const ownerUserId = createId("usr");
  db.prepare(
    `INSERT INTO users
      (id, email, display_name, role, status, created_at, updated_at)
     VALUES (?, 'owner@example.test', 'Owner', 'owner', 'active', ?, ?)`,
  ).run(ownerUserId, now, now);

  const source = addWorkspace(db, "source", "sess_source_administrator", now, input.online ?? true);
  const target = addWorkspace(db, "target", "sess_target_administrator", now, input.online ?? true);
  return { db, now, ownerUserId, source, target };
}

function addWorkspace(
  db: ReturnType<typeof openMemoryDatabase>,
  name: string,
  administratorSessionId: string,
  now: string,
  online: boolean,
) {
  const runtimeId = createId("rt");
  const bindingId = createId("rtwb");
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, ?)`,
  ).run(
    runtimeId,
    `install-${name}`,
    `${name} runtime`,
    online ? "online" : "offline",
    runtimeProtocolVersion,
    now,
    now,
  );
  if (online) {
    db.prepare(
      `INSERT INTO runtime_sessions
        (id, runtime_id, transport, status, connected_at, last_seen_at)
       VALUES (?, ?, 'websocket', 'connected', ?, ?)`,
    ).run(createId("rtsn"), runtimeId, now, now);
  }
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
       diagnostics_json, administrator_session_id, administrator_provisioning_state,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', '{}', '{}', ?, 'active', ?, ?)`,
  ).run(
    bindingId,
    runtimeId,
    `${name}-local`,
    `${name} workspace`,
    administratorSessionId,
    now,
    now,
  );
  const workspace = createWorkspaceWithLease(db, {
    slug: name,
    name: `${name} workspace`,
    runtimeWorkspaceBindingId: bindingId,
    createdAt: now,
  });
  db.prepare("UPDATE workspaces SET provisioning_state = 'active' WHERE id = ?").run(workspace.id);
  return { workspaceId: workspace.id, runtimeId, bindingId, administratorSessionId };
}

function ownerRequest(h: ReturnType<typeof setup>) {
  return {
    delegationId: createId("dlg"),
    sourceWorkspaceId: h.source.workspaceId,
    targetWorkspaceId: h.target.workspaceId,
    goal: "Validate the compatibility change",
    constraints: ["Do not publish externally"],
    actor: { kind: "hub_owner" as const, id: h.ownerUserId },
    lineage: [],
    hopCount: 1,
    idempotencyKey: createId("idem"),
    createdAt: h.now,
  };
}

function messageCommand(
  db: ReturnType<typeof openMemoryDatabase>,
  delegationId: string,
  sequence: number,
) {
  const row = db
    .prepare(
      `SELECT runtime_control_command_id AS commandId
       FROM workspace_delegation_messages WHERE delegation_id = ? AND sequence = ?`,
    )
    .get(delegationId, sequence) as { commandId: string };
  return requireRuntimeControlCommand(db, row.commandId);
}

function deliverySucceeded(
  db: ReturnType<typeof openMemoryDatabase>,
  delegationId: string,
  sequence: number,
  input: { sessionId: string; invocationId: string },
) {
  recordHubWorkspaceDelegationCommandResult(db, messageCommand(db, delegationId, sequence), {
    status: "succeeded",
    result: {
      delegationId,
      messageSequence: sequence,
      administratorSessionId: input.sessionId,
      invocationId: input.invocationId,
      status: "running",
    },
    completedAt: "2026-08-03T00:00:01.000Z",
  });
}

function responseEvent(
  input: Omit<SparkDaemonDelegationRespondedEvent, "version" | "source" | "metadata">,
): SparkDaemonDelegationRespondedEvent {
  return { version: 2, source: "daemon", metadata: {}, ...input };
}

describe("Hub workspace delegations", () => {
  it("persists idempotently and waits durably when target runtime is offline", () => {
    const h = setup({ online: false });
    const request = ownerRequest(h);
    const first = createHubWorkspaceDelegation(h.db, request);
    const replay = createHubWorkspaceDelegation(h.db, request);
    expect(first.status).toBe("retry_wait");
    expect(replay.request.delegationId).toBe(request.delegationId);
    expect(h.db.prepare("SELECT COUNT(*) AS count FROM workspace_delegations").get()).toEqual({
      count: 1,
    });
    expect(() =>
      createHubWorkspaceDelegation(h.db, { ...request, goal: "Different goal" }),
    ).toThrowError(HubWorkspaceDelegationError);
    h.db.close();
  });

  it("cancels an offline queued delivery without replaying it after reconnect", () => {
    const h = setup({ online: false });
    const request = ownerRequest(h);
    createHubWorkspaceDelegation(h.db, request);

    const cancelled = cancelHubWorkspaceDelegation(h.db, {
      delegationId: request.delegationId,
      ownerUserId: h.ownerUserId,
      reason: "No longer needed.",
    });

    expect(cancelled).toMatchObject({
      status: "cancelled",
      receipt: { outcome: "cancelled", summary: "No longer needed." },
    });
    expect(messageCommand(h.db, request.delegationId, 1).status).toBe("cancelled");
    expect(listHubWorkspaceDelegationMessages(h.db, request.delegationId)).toMatchObject([
      { sequence: 1, kind: "request", deliveryStatus: "cancelled" },
    ]);
    h.db.close();
  });

  it("retries a retryable daemon rejection with a fresh outbox command", () => {
    const h = setup();
    const request = ownerRequest(h);
    createHubWorkspaceDelegation(h.db, request);
    const firstCommand = messageCommand(h.db, request.delegationId, 1);
    const rejection = {
      reasonCode: "WORKSPACE_TEMPORARILY_UNAVAILABLE",
      message: "Workspace is still restoring.",
      retryable: true,
    };
    recordRuntimeControlCommandReject(h.db, {
      runtimeId: h.target.runtimeId,
      commandId: firstCommand.commandId,
      payload: rejection,
    });
    recordHubWorkspaceDelegationCommandReject(h.db, firstCommand, rejection);

    expect(requireHubWorkspaceDelegation(h.db, request.delegationId).status).toBe("retry_wait");
    dispatchPendingHubDelegationsForRuntime(h.db, h.target.runtimeId);
    const retried = messageCommand(h.db, request.delegationId, 1);
    expect(retried.commandId).not.toBe(firstCommand.commandId);
    expect(retried.status).toBe("queued");
    expect(requireHubWorkspaceDelegation(h.db, request.delegationId).status).toBe("delivering");
    h.db.close();
  });

  it("reroutes a never-delivered command after the target binding changes", () => {
    const h = setup();
    const request = ownerRequest(h);
    createHubWorkspaceDelegation(h.db, request);
    const firstCommand = messageCommand(h.db, request.delegationId, 1);
    const replacementBindingId = createId("rtwb");
    h.db
      .prepare(
        `INSERT INTO runtime_workspace_bindings
        (id, runtime_id, local_workspace_key, display_name, status, capabilities_json,
         diagnostics_json, administrator_session_id, administrator_provisioning_state,
         created_at, updated_at)
       VALUES (?, ?, 'target-local-replacement', 'Replacement target', 'available', '{}', '{}',
               ?, 'active', ?, ?)`,
      )
      .run(replacementBindingId, h.target.runtimeId, h.target.administratorSessionId, h.now, h.now);
    h.db
      .prepare(
        "UPDATE workspace_leases SET ended_at = ? WHERE workspace_id = ? AND ended_at IS NULL",
      )
      .run("2026-08-03T00:00:02.000Z", h.target.workspaceId);
    h.db
      .prepare(
        `INSERT INTO workspace_leases
        (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
      )
      .run(
        createId("wob"),
        h.target.workspaceId,
        replacementBindingId,
        "2026-08-03T00:00:02.000Z",
        "2026-08-03T00:00:02.000Z",
      );

    dispatchPendingHubDelegationsForRuntime(h.db, h.target.runtimeId);

    const rerouted = messageCommand(h.db, request.delegationId, 1);
    expect(rerouted.commandId).not.toBe(firstCommand.commandId);
    expect(rerouted.runtimeWorkspaceBindingId).toBe(replacementBindingId);
    expect(requireRuntimeControlCommand(h.db, firstCommand.commandId).status).toBe("cancelled");
    h.db.close();
  });

  it("runs request, ask/reply, and verified structured completion", () => {
    const h = setup();
    const request = ownerRequest(h);
    const created = createHubWorkspaceDelegation(h.db, request);
    expect(created.status).toBe("delivering");
    const targetInvocationId = createId("inv");
    deliverySucceeded(h.db, request.delegationId, 1, {
      sessionId: h.target.administratorSessionId,
      invocationId: targetInvocationId,
    });
    expect(requireHubWorkspaceDelegation(h.db, request.delegationId).status).toBe("running");

    recordHubWorkspaceDelegationDaemonEvent(
      h.db,
      h.target.workspaceId,
      responseEvent({
        type: "daemon.delegation.responded",
        workspaceId: h.target.workspaceId,
        sessionId: h.target.administratorSessionId,
        invocationId: targetInvocationId,
        delegationId: request.delegationId,
        action: "ask",
        messageSequence: 1,
        text: "Which compatibility range should be supported?",
      }),
    );
    expect(requireHubWorkspaceDelegation(h.db, request.delegationId).status).toBe(
      "awaiting_source",
    );

    replyHubWorkspaceDelegation(h.db, {
      delegationId: request.delegationId,
      ownerUserId: h.ownerUserId,
      text: "Support the current and previous minor release.",
    });
    const resumedInvocationId = createId("inv");
    deliverySucceeded(h.db, request.delegationId, 3, {
      sessionId: h.target.administratorSessionId,
      invocationId: resumedInvocationId,
    });

    h.db
      .prepare(
        `INSERT INTO artifacts
        (id, workspace_id, scope, kind, title, format, source, content_ref_json,
         provenance_json, created_at, updated_at)
       VALUES (?, ?, 'workspace', 'document', 'Compatibility report', 'markdown', 'runtime',
               '{}', ?, ?, ?)`,
      )
      .run(
        createId("art"),
        h.target.workspaceId,
        JSON.stringify({ artifactRef: "artifact:compatibility-report" }),
        h.now,
        h.now,
      );
    recordHubWorkspaceDelegationDaemonEvent(
      h.db,
      h.target.workspaceId,
      responseEvent({
        type: "daemon.delegation.responded",
        workspaceId: h.target.workspaceId,
        sessionId: h.target.administratorSessionId,
        invocationId: resumedInvocationId,
        delegationId: request.delegationId,
        action: "complete",
        messageSequence: 3,
        receipt: {
          outcome: "completed",
          summary: "Compatibility verified.",
          artifactRefs: ["artifact:compatibility-report"],
          verification: [{ label: "unit tests", status: "passed", summary: "42 passed" }],
        },
      }),
    );
    expect(requireHubWorkspaceDelegation(h.db, request.delegationId)).toMatchObject({
      status: "completed",
      receipt: {
        summary: "Compatibility verified.",
        artifactRefs: ["artifact:compatibility-report"],
      },
    });
    const sourceView = listHubWorkspaceDelegationsForWorkspaceMember(h.db, h.source.workspaceId);
    const targetView = listHubWorkspaceDelegationsForWorkspaceMember(h.db, h.target.workspaceId);
    expect(sourceView[0]).not.toHaveProperty("targetSessionId");
    expect(sourceView[0]?.request).not.toHaveProperty("actor");
    expect(sourceView[0]?.request).not.toHaveProperty("idempotencyKey");
    expect(targetView[0]?.targetSessionId).toBe(h.target.administratorSessionId);
    expect(JSON.stringify(sourceView)).not.toContain("evidence:");
    h.db.close();
  });

  it("rejects ordinary-session response forgery and foreign artifacts", () => {
    const h = setup();
    const request = ownerRequest(h);
    createHubWorkspaceDelegation(h.db, request);
    const invocationId = createId("inv");
    deliverySucceeded(h.db, request.delegationId, 1, {
      sessionId: h.target.administratorSessionId,
      invocationId,
    });
    expect(() =>
      recordHubWorkspaceDelegationDaemonEvent(
        h.db,
        h.target.workspaceId,
        responseEvent({
          type: "daemon.delegation.responded",
          workspaceId: h.target.workspaceId,
          sessionId: "sess_ordinary",
          invocationId,
          delegationId: request.delegationId,
          action: "complete",
          messageSequence: 1,
          receipt: {
            outcome: "completed",
            summary: "Forged completion.",
            artifactRefs: [],
            verification: [],
          },
        }),
      ),
    ).toThrow(/not the projected Administrator Session/u);
    expect(() =>
      recordHubWorkspaceDelegationDaemonEvent(
        h.db,
        h.target.workspaceId,
        responseEvent({
          type: "daemon.delegation.responded",
          workspaceId: h.target.workspaceId,
          sessionId: h.target.administratorSessionId,
          invocationId,
          delegationId: request.delegationId,
          action: "complete",
          messageSequence: 1,
          receipt: {
            outcome: "completed",
            summary: "Foreign artifact.",
            artifactRefs: ["artifact:not-projected"],
            verification: [],
          },
        }),
      ),
    ).toThrow(/not projected from target workspace/u);
    expect(requireHubWorkspaceDelegation(h.db, request.delegationId).status).toBe("running");
    h.db.close();
  });

  it("rejects a Hub Owner request whose source has no active Administrator binding", () => {
    const h = setup();
    h.db
      .prepare(
        "UPDATE workspace_leases SET ended_at = ? WHERE workspace_id = ? AND ended_at IS NULL",
      )
      .run("2026-08-03T00:00:02.000Z", h.source.workspaceId);

    expect(() => createHubWorkspaceDelegation(h.db, ownerRequest(h))).toThrow(
      /no active runtime binding with an Administrator Session/u,
    );
    h.db.close();
  });
});
