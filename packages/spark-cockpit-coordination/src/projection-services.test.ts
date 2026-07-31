import { describe, expect, it } from "vitest";
import {
  createId,
  runtimeProtocolVersion,
  sparkAgentsCockpitSource,
  type ArtifactProjectionPayload,
} from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-cockpit-db";
import {
  buildApprovalDecisionPayload,
  buildApprovalDeliveryCommandPayload,
  describeApprovalCenterItem,
  type ApprovalDecision,
} from "./approval-center";
import {
  appendEvent,
  createProject,
  createWorkspaceWithLease,
  ingestTaskGraphSnapshot,
  loadWorkspaceServerControl,
  queueCommandForWorkspaceLease,
  recordArtifactProjection,
  recordHumanRequestFromRuntime,
  recordHumanResponse,
  recordHumanResponseAck,
  recordInvocationLogChunk,
  recordInvocationUpdate,
  archiveWorkspace,
  unbindWorkspaceLease,
} from "./projection-services";
import { cursorFromEvent, loadEventBatch, serializeEventRow } from "./events";

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Expected ${label} to contain valid JSON`, { cause: error });
  }
}

function setupRuntimeBinding() {
  const db = openMemoryDatabase();
  migrate(db);

  const now = "2026-05-22T00:00:00.000Z";
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");

  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeWorkspaceBindingId, runtimeId, now, now);

  return { db, runtimeId, runtimeWorkspaceBindingId, now };
}

describe("projection services", () => {
  it("archives a workspace, ends its lease, and frees the slug", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    const result = archiveWorkspace(db, {
      workspaceId: workspace.id,
      actorId: "user_owner",
      archivedAt: "2026-05-22T00:02:00.000Z",
    });

    expect(result).toMatchObject({
      outcome: "archived",
      previousSlug: "local-default",
      archivedSlug: `archived-${workspace.id}`,
      leaseUnbound: true,
    });
    expect(
      db
        .prepare(
          `SELECT status, slug
           FROM workspaces
           WHERE id = ?`,
        )
        .get(workspace.id),
    ).toEqual({ status: "archived", slug: `archived-${workspace.id}` });
    expect(
      db
        .prepare(
          `SELECT ended_at AS endedAt
           FROM workspace_leases
           WHERE workspace_id = ?`,
        )
        .get(workspace.id),
    ).toEqual({ endedAt: "2026-05-22T00:02:00.000Z" });
    expect(
      createWorkspaceWithLease(db, {
        slug: "local-default",
        name: "Local default again",
        runtimeWorkspaceBindingId,
        createdAt: "2026-05-22T00:03:00.000Z",
      }).id,
    ).not.toBe(workspace.id);
  });

  it("ends only the Cockpit lease and keeps daemon binding history", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    const result = unbindWorkspaceLease(db, {
      workspaceId: workspace.id,
      expectedRuntimeWorkspaceBindingId: runtimeWorkspaceBindingId,
      actorId: "user_owner",
      endedAt: "2026-05-22T00:01:00.000Z",
    });

    expect(result).toMatchObject({ outcome: "unbound", runtimeWorkspaceBindingId });
    expect(
      db
        .prepare(
          `SELECT ended_at AS endedAt
           FROM workspace_leases
           WHERE workspace_id = ?`,
        )
        .get(workspace.id),
    ).toEqual({ endedAt: "2026-05-22T00:01:00.000Z" });
    expect(
      db
        .prepare("SELECT id FROM runtime_workspace_bindings WHERE id = ?")
        .get(runtimeWorkspaceBindingId),
    ).toEqual({ id: runtimeWorkspaceBindingId });
    expect(
      db.prepare("SELECT kind FROM events WHERE kind = 'workspace.lease_unbound'").get(),
    ).toEqual({ kind: "workspace.lease_unbound" });
    expect(unbindWorkspaceLease(db, { workspaceId: workspace.id })).toMatchObject({
      outcome: "already_unbound",
    });
    db.close();
  });

  it("creates a workspace, leases it to a runtime, creates a project, and queues a command", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();

    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt: now,
    });
    const command = queueCommandForWorkspaceLease(db, {
      workspaceId: workspace.id,
      projectId: project.id,
      idempotencyKey: createId("idem"),
      payload: {
        kind: "task.start.request",
        title: "Start MVP task",
      },
      createdAt: now,
    });

    const lease = db
      .prepare(
        "SELECT runtime_workspace_binding_id AS bindingId FROM workspace_leases WHERE workspace_id = ?",
      )
      .get(workspace.id) as { bindingId: string };
    expect(lease.bindingId).toBe(runtimeWorkspaceBindingId);

    const projectRow = db
      .prepare("SELECT metadata_json AS metadataJson FROM projects WHERE id = ?")
      .get(project.id) as { metadataJson: string };
    const delivery = db
      .prepare("SELECT status FROM command_deliveries WHERE command_id = ?")
      .get(command.id) as { status: string };
    expect(parseJson(projectRow.metadataJson, "project metadata")).toMatchObject({
      sourceOfTruth: "spark-cockpit-routing",
    });
    expect(delivery.status).toBe("pending");

    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
      count: number;
    };
    expect(eventCount.count).toBe(3);
    const queuedEvent = db
      .prepare("SELECT payload_json AS payloadJson FROM events WHERE kind = 'command.queued'")
      .get() as { payloadJson: string };
    expect(parseJson(queuedEvent.payloadJson, "queued event payload")).toMatchObject({
      runtimeWorkspaceBindingId,
      command: {
        id: command.id,
        kind: "task.start.request",
        title: "Start MVP task",
        status: "queued",
        deliveryStatus: "pending",
      },
    });
    db.close();
  });

  it("records invocation streaming chunks as replayable SSE payloads", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const command = queueCommandForWorkspaceLease(db, {
      workspaceId: workspace.id,
      idempotencyKey: createId("idem"),
      payload: {
        kind: "task.start.request",
        title: "Agents prompt",
        payload: { source: sparkAgentsCockpitSource, runtimeTaskId: "task-1" },
      },
      createdAt: "2026-05-22T00:00:01.000Z",
    });

    const runtimeInvocationId = createId("inv");
    recordInvocationUpdate(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId,
        sequence: 1,
        taskRuntimeId: "task-1",
        agentName: "spark-runtime",
        status: "running",
        payload: {},
      },
      updatedAt: "2026-05-22T00:00:02.000Z",
    });
    recordInvocationLogChunk(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId,
        stream: "assistant",
        sequence: 1,
        content: "Hello",
        metadata: { delta: true },
      },
      createdAt: "2026-05-22T00:00:03.000Z",
    });
    recordInvocationLogChunk(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId,
        stream: "assistant",
        sequence: 2,
        content: " world",
      },
      createdAt: "2026-05-22T00:00:04.000Z",
    });

    const durableChunks = db
      .prepare(
        `SELECT stream, sequence, content
         FROM invocation_log_chunks
         ORDER BY sequence`,
      )
      .all() as Array<{ stream: string; sequence: number; content: string }>;
    expect(durableChunks).toEqual([
      { stream: "assistant", sequence: 1, content: "Hello" },
      { stream: "assistant", sequence: 2, content: " world" },
    ]);

    const firstBatch = loadEventBatch(db, null, 10).map(serializeEventRow);
    const streamingEvents = firstBatch.filter((event) => event.subjectId === runtimeInvocationId);
    expect(streamingEvents.map((event) => event.kind)).toEqual([
      "invocation.updated",
      "invocation.log_chunk",
      "invocation.log_chunk",
    ]);
    expect(streamingEvents[0]?.payload).toMatchObject({
      runtimeInvocationId,
      commandId: command.id,
      taskRuntimeId: "task-1",
      status: "running",
      sequence: 1,
    });
    expect(streamingEvents[1]?.payload).toMatchObject({
      runtimeInvocationId,
      commandId: command.id,
      stream: "assistant",
      sequence: 1,
      content: "Hello",
      metadata: { delta: true },
    });
    expect(
      db
        .prepare(
          `SELECT ie.sequence
           FROM invocation_events ie
           JOIN mirrored_invocations mi ON mi.id = ie.invocation_id
           WHERE mi.runtime_invocation_id = ? AND ie.kind = 'invocation.running'`,
        )
        .get(runtimeInvocationId),
    ).toEqual({ sequence: 1 });

    const cursor = cursorFromEvent(streamingEvents[1]!);
    const replay = loadEventBatch(db, cursor, 10).map(serializeEventRow);
    expect(replay.filter((event) => event.subjectId === runtimeInvocationId)).toMatchObject([
      {
        kind: "invocation.log_chunk",
        payload: { stream: "assistant", sequence: 2, content: " world" },
      },
    ]);

    // Replays are idempotent, but unrelated database constraints must still fail.
    recordInvocationLogChunk(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      commandId: command.id,
      payload: {
        runtimeInvocationId,
        stream: "assistant",
        sequence: 2,
        content: "duplicate",
      },
      createdAt: "2026-05-22T00:00:04.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM invocation_log_chunks").get()).toEqual({
      count: 2,
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM events
           WHERE kind = 'invocation.log_chunk' AND subject_id = ?`,
        )
        .get(runtimeInvocationId),
    ).toEqual({ count: 2 });
    expect(() =>
      recordInvocationLogChunk(db, {
        runtimeWorkspaceBindingId,
        workspaceId: workspace.id,
        commandId: command.id,
        payload: {
          runtimeInvocationId,
          stream: "invalid" as never,
          sequence: 3,
          content: "must fail",
        },
        createdAt: "2026-05-22T00:00:05.000Z",
      }),
    ).toThrow(/constraint|CHECK/u);
    db.close();
  });

  it("records approval-center approve/reject decisions through the command outbox", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const cases = [
      {
        name: "ask",
        requestKind: "ask_user",
        title: "Choose database",
        prompt: "Which database should Spark use?",
        context: {},
        approvalKind: "ask",
      },
      {
        name: "workflow-risk",
        requestKind: "approval",
        title: "Approve generated workflow",
        prompt: "Approve write-enabled fan-out?",
        context: { approvalKind: "workflow-risk", risks: ["fan-out=4"] },
        approvalKind: "workflow_risk",
      },
      {
        name: "goal-review",
        requestKind: "review",
        title: "Goal completion reviewer gate",
        prompt: "Approve completion?",
        context: { reviewer: "goal", verdict: "pending" },
        approvalKind: "goal_review",
      },
    ] as const;
    const decisions: ApprovalDecision[] = ["approve", "reject"];

    for (const testCase of cases) {
      for (const decision of decisions) {
        const runtimeRequestId = `${testCase.name}-${decision}`;
        const request = recordHumanRequestFromRuntime(db, {
          runtimeWorkspaceBindingId,
          workspaceId: workspace.id,
          runtimeRequestId,
          payload: {
            kind: testCase.requestKind,
            title: testCase.title,
            prompt: testCase.prompt,
            questions: [],
            context: testCase.context,
            contextArtifactRefs: [],
          },
          createdAt: now,
        });
        const approval = describeApprovalCenterItem({
          requestKind: testCase.requestKind,
          title: testCase.title,
          prompt: testCase.prompt,
          context: testCase.context,
        });
        const responsePayload = buildApprovalDecisionPayload({
          approval,
          decision,
          operatorNote: decision === "reject" ? `${testCase.name} blocked` : undefined,
        });
        const response = recordHumanResponse(db, {
          humanRequestId: request.humanRequestId,
          payload: responsePayload,
          createdAt: "2026-05-22T00:00:01.000Z",
        });
        const command = queueCommandForWorkspaceLease(db, {
          workspaceId: workspace.id,
          idempotencyKey: `approval:${request.humanRequestId}:${decision}`,
          payload: buildApprovalDeliveryCommandPayload({
            approval,
            decision,
            humanRequestId: request.humanRequestId,
            humanResponseId: response.humanResponseId,
            runtimeRequestId,
            response: responsePayload,
          }),
          createdAt: "2026-05-22T00:00:02.000Z",
        });

        const row = db
          .prepare(
            `SELECT hr.status AS requestStatus,
                    ii.status AS inboxStatus,
                    hres.status AS responseStatus,
                    hres.answer_json AS answerJson
             FROM human_requests hr
             JOIN inbox_items ii ON ii.human_request_id = hr.id
             JOIN human_responses hres ON hres.human_request_id = hr.id
             WHERE hres.id = ?`,
          )
          .get(response.humanResponseId) as {
          requestStatus: string;
          inboxStatus: string;
          responseStatus: string;
          answerJson: string;
        };
        expect(row.requestStatus).toBe("pending");
        expect(row.inboxStatus).toBe("pending");
        expect(row.responseStatus).toBe("delivering");
        expect(parseJson(row.answerJson, "approval answer")).toMatchObject({
          status: "answered",
          answers: {
            decision,
            approved: decision === "approve",
            approvalKind: testCase.approvalKind,
          },
        });
        const delivery = db
          .prepare(
            `SELECT c.kind, c.payload_json AS payloadJson, cd.status AS deliveryStatus
             FROM commands c
             JOIN command_deliveries cd ON cd.command_id = c.id
             WHERE c.id = ?`,
          )
          .get(command.id) as { kind: string; payloadJson: string; deliveryStatus: string };
        expect(delivery.kind).toBe("human.response.deliver.request");
        expect(delivery.deliveryStatus).toBe("pending");
        expect(parseJson(delivery.payloadJson, "approval delivery payload")).toMatchObject({
          kind: "human.response.deliver.request",
          payload: {
            humanRequestId: request.humanRequestId,
            humanResponseId: response.humanResponseId,
            runtimeRequestId,
            approval: { kind: testCase.approvalKind },
            response: { answers: { decision, approved: decision === "approve" } },
          },
        });
      }
    }
    db.close();
  });

  it("projects borrowed workspaces as snapshot-only and blocks server mutations", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt: now,
    });

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "workspace.snapshot.received",
      subjectKind: "runtime_workspace_binding",
      subjectId: runtimeWorkspaceBindingId,
      payload: {
        displayName: "Local default",
        status: "available",
        borrowed: {
          borrowed: true,
          interactiveClientCount: 1,
          borrowedByClientIds: ["wcl-tui"],
          since: now,
        },
        workspaceClients: [
          {
            clientId: "wcl-tui",
            kind: "interactive",
            status: "connected",
            attachedAt: now,
            lastSeenAt: now,
          },
        ],
        executor: {
          state: "online",
          clientId: "exec-local",
          activeInvocationCount: 2,
          activeAgentCount: 2,
          lastSeenAt: now,
        },
      },
      createdAt: now,
    });

    const control = loadWorkspaceServerControl(db, workspace.id);
    expect(control.connection).toMatchObject({ status: "connected", lastSeenAt: now });
    expect(control.borrowed).toMatchObject({
      borrowed: true,
      interactiveClientCount: 1,
      borrowedByClientIds: ["wcl-tui"],
    });
    expect(control.executor).toMatchObject({
      state: "online",
      clientId: "exec-local",
      activeInvocationCount: 2,
      activeAgentCount: 2,
    });
    expect(control.control).toMatchObject({
      mode: "snapshot_only",
      reason: "workspace_borrowed",
      serverMutationAllowed: false,
    });
    expect(() =>
      queueCommandForWorkspaceLease(db, {
        workspaceId: workspace.id,
        projectId: project.id,
        payload: { kind: "task.start.request", title: "Start MVP task" },
        createdAt: now,
      }),
    ).toThrow(/occupied by another interactive session/);

    const commandCount = db.prepare("SELECT COUNT(*) AS count FROM commands").get() as {
      count: number;
    };
    expect(commandCount.count).toBe(0);
    db.close();
  });

  it("keeps cockpit-only occupancy mutable while still reporting occupied sessions", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "workspace.snapshot.received",
      subjectKind: "runtime_workspace_binding",
      subjectId: runtimeWorkspaceBindingId,
      payload: {
        displayName: "Local default",
        status: "available",
        borrowed: {
          borrowed: true,
          occupied: true,
          interactiveClientCount: 1,
          borrowedByClientIds: ["wcl-cockpit"],
          sessions: [
            {
              sessionId: "wcl-cockpit",
              clientId: "wcl-cockpit",
              kind: "interactive",
              surface: "cockpit",
              displayName: "Cockpit workbench",
              attachedAt: now,
              lastSeenAt: now,
            },
          ],
          since: now,
        },
        workspaceClients: [
          {
            clientId: "wcl-cockpit",
            kind: "interactive",
            status: "connected",
            surface: "cockpit",
            sessionId: "wcl-cockpit",
            attachedAt: now,
            lastSeenAt: now,
          },
        ],
        control: {
          mode: "full",
          serverMutationAllowed: true,
        },
      },
      createdAt: now,
    });

    const control = loadWorkspaceServerControl(db, workspace.id);
    expect(control.borrowed).toMatchObject({
      borrowed: true,
      occupied: true,
      sessions: [expect.objectContaining({ surface: "cockpit", clientId: "wcl-cockpit" })],
    });
    expect(control.control).toMatchObject({
      mode: "full",
      serverMutationAllowed: true,
    });
    expect(() =>
      queueCommandForWorkspaceLease(db, {
        workspaceId: workspace.id,
        payload: { kind: "task.start.request", title: "Start MVP task" },
        createdAt: now,
      }),
    ).not.toThrow();
    db.close();
  });

  it("projects disconnected workspaces as snapshot-only without stale status wording", () => {
    const { db, runtimeId, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    db.prepare(
      "UPDATE runtime_connections SET status = 'offline', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, "2026-05-22T00:01:00.000Z", runtimeId);

    const control = loadWorkspaceServerControl(db, workspace.id);
    expect(control.connection).toMatchObject({
      status: "disconnected",
      runtimeStatus: "offline",
      lastSeenAt: now,
    });
    expect(control.control).toMatchObject({
      mode: "snapshot_only",
      reason: "daemon_disconnected",
      serverMutationAllowed: false,
    });
    expect(control.control.message).not.toMatch(/stale/iu);
    expect(() =>
      queueCommandForWorkspaceLease(db, {
        workspaceId: workspace.id,
        payload: { kind: "task.start.request", title: "Start MVP task" },
        createdAt: now,
      }),
    ).toThrow(/disconnected/);
    db.close();
  });

  it("allows server mutations for connected unborrowed workspaces", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    appendEvent(db, {
      workspaceId: workspace.id,
      actorKind: "runtime",
      actorId: runtimeWorkspaceBindingId,
      kind: "workspace.snapshot.received",
      payload: {
        displayName: "Local default",
        status: "available",
        borrowed: { borrowed: false, interactiveClientCount: 0, borrowedByClientIds: [] },
        executor: { state: "online", activeInvocationCount: 0, activeAgentCount: 0 },
        control: { mode: "full", serverMutationAllowed: true },
      },
      createdAt: now,
    });

    expect(loadWorkspaceServerControl(db, workspace.id).control).toMatchObject({
      mode: "full",
      serverMutationAllowed: true,
    });
    expect(() =>
      queueCommandForWorkspaceLease(db, {
        workspaceId: workspace.id,
        payload: { kind: "task.start.request", title: "Start MVP task" },
        createdAt: now,
      }),
    ).not.toThrow();
    db.close();
  });

  it("finalizes the workspace already leased to a registered binding", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspaceId = createId("ws");
    const leaseId = createId("wob");
    db.prepare(
      `INSERT INTO workspaces
        (id, slug, name, description, status, settings_json, created_at, updated_at)
       VALUES (?, 'local-default', 'Pending local', NULL, 'active', '{}', ?, ?)`,
    ).run(workspaceId, now, now);
    db.prepare(
      `INSERT INTO workspace_leases
        (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, ended_at, created_at)
       VALUES (?, ?, ?, 'primary', ?, NULL, ?)`,
    ).run(leaseId, workspaceId, runtimeWorkspaceBindingId, now, now);

    const input = {
      slug: "spark-dev",
      name: "Spark Dev",
      description: "Ready for work",
      settings: { profileInputs: { workspaceSlug: "spark-dev" } },
      profileSource: {
        sourceKind: "builtin" as const,
        profileId: "fresh",
        profileName: "Fresh workspace",
        schemaVersion: "1",
      },
      agentSpecs: [
        {
          name: "Planner",
          source: "builtin" as const,
          status: "active" as const,
        },
      ],
      resources: [
        {
          kind: "repo" as const,
          name: "Local checkout",
          uri: "file:///tmp/local-default",
          status: "available" as const,
        },
      ],
      runtimeWorkspaceBindingId,
      createdAt: "2026-05-22T00:01:00.000Z",
    };
    const finalized = createWorkspaceWithLease(db, input);
    const finalizedAgain = createWorkspaceWithLease(db, input);

    const workspaceCount = db.prepare("SELECT COUNT(*) AS count FROM workspaces").get() as {
      count: number;
    };
    const workspace = db
      .prepare(
        `SELECT slug,
                name,
                description,
                settings_json AS settingsJson
         FROM workspaces
         WHERE id = ?`,
      )
      .get(workspaceId) as {
      slug: string;
      name: string;
      description: string | null;
      settingsJson: string;
    };
    const activeLeaseCount = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM workspace_leases
         WHERE workspace_id = ? AND ended_at IS NULL`,
      )
      .get(workspaceId) as { count: number };
    const profileCount = db
      .prepare("SELECT COUNT(*) AS count FROM workspace_profile_sources WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };
    const agentCount = db
      .prepare("SELECT COUNT(*) AS count FROM agent_specs WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };
    const resourceCount = db
      .prepare("SELECT COUNT(*) AS count FROM resources WHERE workspace_id = ?")
      .get(workspaceId) as { count: number };

    expect(finalized.id).toBe(workspaceId);
    expect(finalized.leaseId).toBe(leaseId);
    expect(finalizedAgain.id).toBe(workspaceId);
    expect(workspaceCount.count).toBe(1);
    expect(workspace).toMatchObject({
      slug: "spark-dev",
      name: "Spark Dev",
      description: "Ready for work",
    });
    expect(parseJson(workspace.settingsJson, "workspace settings")).toEqual({
      profileInputs: { workspaceSlug: "spark-dev" },
    });
    expect(activeLeaseCount.count).toBe(1);
    expect(profileCount.count).toBe(1);
    expect(agentCount.count).toBe(1);
    expect(resourceCount.count).toBe(1);
    db.close();
  });

  it("records runtime-originated human requests and user responses", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });

    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "tool-call-1",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope should Spark Cockpit apply?",
        questions: [
          {
            id: "scope",
            type: "single",
            prompt: "Scope?",
            required: true,
            options: [{ value: "mvp", label: "MVP", description: "Proceed to MVP." }],
          },
        ],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });

    const inbox = db
      .prepare("SELECT status, kind FROM inbox_items WHERE human_request_id = ?")
      .get(request.humanRequestId) as { status: string; kind: string };
    expect(inbox).toEqual({ status: "pending", kind: "ask" });

    const response = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: {
        status: "answered",
        answers: { scope: "mvp" },
        responseArtifactRefs: [],
      },
      createdAt: now,
    });

    const requestRow = db
      .prepare(
        `SELECT hr.status AS requestStatus, ii.status AS inboxStatus
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         WHERE hr.id = ?`,
      )
      .get(request.humanRequestId) as { requestStatus: string; inboxStatus: string };
    const responseRow = db
      .prepare("SELECT status FROM human_responses WHERE id = ?")
      .get(response.humanResponseId) as { status: string };

    expect(requestRow).toEqual({ requestStatus: "pending", inboxStatus: "pending" });
    expect(responseRow.status).toBe("delivering");

    recordHumanResponseAck(db, {
      runtimeWorkspaceBindingId,
      humanRequestId: request.humanRequestId,
      humanResponseId: response.humanResponseId,
      payload: { returnedToTool: true, outcome: "accepted" },
      acknowledgedAt: "2026-05-22T00:00:01.000Z",
    });

    const accepted = db
      .prepare(
        `SELECT hr.status AS requestStatus,
                ii.status AS inboxStatus,
                ii.resolved_as AS resolvedAs,
                hres.status AS responseStatus,
                hres.acked_at AS ackedAt
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         JOIN human_responses hres ON hres.human_request_id = hr.id
         WHERE hres.id = ?`,
      )
      .get(response.humanResponseId) as {
      requestStatus: string;
      inboxStatus: string;
      resolvedAs: string | null;
      responseStatus: string;
      ackedAt: string | null;
    };
    expect(accepted).toEqual({
      requestStatus: "answered",
      inboxStatus: "resolved",
      resolvedAs: "answered",
      responseStatus: "acked",
      ackedAt: "2026-05-22T00:00:01.000Z",
    });
    db.close();
  });

  it("deduplicates human requests by runtime binding and runtime request id", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const runtimeRequestId = "tool-call-replayed";
    const first = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId,
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const replay = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      humanRequestId: createId("hreq"),
      runtimeRequestId,
      payload: {
        kind: "ask_user",
        title: "Replayed title must not replace the projection",
        prompt: "Replayed prompt",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: "2026-05-22T00:00:01.000Z",
    });

    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM human_requests) AS requests,
                (SELECT COUNT(*) FROM inbox_items) AS inboxItems,
                (SELECT COUNT(*) FROM events WHERE kind = 'human.request.created') AS events`,
      )
      .get() as { requests: number; inboxItems: number; events: number };
    expect(replay).toEqual(first);
    expect(counts).toEqual({ requests: 1, inboxItems: 1, events: 1 });
    db.close();
  });

  it.each([
    {
      outcome: "replayed" as const,
      returnedToTool: true,
      requestStatus: "answered",
      inboxStatus: "resolved",
      resolvedAs: "answered",
      responseStatus: "acked",
      ackedAt: "2026-05-22T00:00:01.000Z",
    },
    {
      outcome: "orphaned" as const,
      returnedToTool: false,
      requestStatus: "archived",
      inboxStatus: "archived",
      resolvedAs: "orphaned",
      responseStatus: "failed",
      ackedAt: null,
    },
    {
      outcome: "unknown_request" as const,
      returnedToTool: false,
      requestStatus: "archived",
      inboxStatus: "archived",
      resolvedAs: "unknown_request",
      responseStatus: "failed",
      ackedAt: null,
    },
    {
      outcome: "transient" as const,
      returnedToTool: false,
      requestStatus: "pending",
      inboxStatus: "pending",
      resolvedAs: null,
      responseStatus: "delivering",
      ackedAt: null,
    },
  ])("projects a $outcome human response ack", (testCase) => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: `local-${testCase.outcome}`,
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: `tool-call-${testCase.outcome}`,
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const response = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: {
        status: "answered",
        answers: { scope: "mvp" },
        responseArtifactRefs: [],
      },
      createdAt: now,
    });

    recordHumanResponseAck(db, {
      runtimeWorkspaceBindingId,
      humanRequestId: request.humanRequestId,
      humanResponseId: response.humanResponseId,
      payload: {
        returnedToTool: testCase.returnedToTool,
        outcome: testCase.outcome,
        retryable: testCase.outcome === "transient",
      },
      acknowledgedAt: "2026-05-22T00:00:01.000Z",
    });

    const row = db
      .prepare(
        `SELECT hr.status AS requestStatus,
                ii.status AS inboxStatus,
                ii.resolved_as AS resolvedAs,
                hres.status AS responseStatus,
                hres.acked_at AS ackedAt
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         JOIN human_responses hres ON hres.human_request_id = hr.id
         WHERE hres.id = ?`,
      )
      .get(response.humanResponseId) as {
      requestStatus: string;
      inboxStatus: string;
      resolvedAs: string | null;
      responseStatus: string;
      ackedAt: string | null;
    };
    expect(row).toEqual({
      requestStatus: testCase.requestStatus,
      inboxStatus: testCase.inboxStatus,
      resolvedAs: testCase.resolvedAs,
      responseStatus: testCase.responseStatus,
      ackedAt: testCase.ackedAt,
    });
    db.close();
  });

  it("keeps the winner resolved and marks an already-resolved competing response failed", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "tool-call-race",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const winner = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: { status: "answered", answers: { scope: "mvp" }, responseArtifactRefs: [] },
      createdAt: now,
    });
    recordHumanResponseAck(db, {
      runtimeWorkspaceBindingId,
      humanRequestId: request.humanRequestId,
      humanResponseId: winner.humanResponseId,
      payload: { returnedToTool: true, outcome: "accepted" },
      acknowledgedAt: "2026-05-22T00:00:01.000Z",
    });
    const loser = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: { status: "answered", answers: { scope: "all" }, responseArtifactRefs: [] },
      createdAt: "2026-05-22T00:00:02.000Z",
    });
    recordHumanResponseAck(db, {
      runtimeWorkspaceBindingId,
      humanRequestId: request.humanRequestId,
      humanResponseId: loser.humanResponseId,
      payload: {
        returnedToTool: false,
        outcome: "already_resolved",
        winnerResponseId: winner.humanResponseId,
      },
      acknowledgedAt: "2026-05-22T00:00:03.000Z",
    });

    const projection = db
      .prepare(
        `SELECT hr.status AS requestStatus,
                ii.status AS inboxStatus,
                winner.status AS winnerStatus,
                loser.status AS loserStatus
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         JOIN human_responses winner ON winner.id = ?
         JOIN human_responses loser ON loser.id = ?
         WHERE hr.id = ?`,
      )
      .get(winner.humanResponseId, loser.humanResponseId, request.humanRequestId) as {
      requestStatus: string;
      inboxStatus: string;
      winnerStatus: string;
      loserStatus: string;
    };
    expect(projection).toEqual({
      requestStatus: "answered",
      inboxStatus: "resolved",
      winnerStatus: "acked",
      loserStatus: "failed",
    });
    db.close();
  });

  it("treats legacy human response acks without an outcome as accepted", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const request = recordHumanRequestFromRuntime(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      runtimeRequestId: "tool-call-legacy-ack",
      payload: {
        kind: "ask_user",
        title: "Choose scope",
        prompt: "Which scope?",
        questions: [],
        context: {},
        contextArtifactRefs: [],
      },
      createdAt: now,
    });
    const response = recordHumanResponse(db, {
      humanRequestId: request.humanRequestId,
      payload: { status: "cancelled", answers: {}, responseArtifactRefs: [] },
      createdAt: now,
    });

    recordHumanResponseAck(db, {
      runtimeWorkspaceBindingId,
      humanRequestId: request.humanRequestId,
      humanResponseId: response.humanResponseId,
      payload: { returnedToTool: false },
      acknowledgedAt: "2026-05-22T00:00:01.000Z",
    });

    const projection = db
      .prepare(
        `SELECT hr.status AS requestStatus, ii.status AS inboxStatus, hres.status AS responseStatus
         FROM human_requests hr
         JOIN inbox_items ii ON ii.human_request_id = hr.id
         JOIN human_responses hres ON hres.human_request_id = hr.id
         WHERE hres.id = ?`,
      )
      .get(response.humanResponseId);
    expect(projection).toEqual({
      requestStatus: "cancelled",
      inboxStatus: "archived",
      responseStatus: "acked",
    });
    db.close();
  });

  it("ingests task graph snapshots and artifact projections", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "local-default",
      name: "Local default",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "mvp",
      name: "MVP",
      createdAt: now,
    });

    const snapshotPayload = {
      runtimeSnapshotId: "snap-1",
      snapshotVersion: 1,
      clusters: [
        { runtimeClusterId: "cluster-main", title: "Main", status: "running", payload: {} },
      ],
      tasks: [
        {
          runtimeTaskId: "task-a",
          title: "A",
          status: "completed",
          inputArtifactIds: [],
          outputArtifactIds: [],
          runIds: [],
          payload: {},
        },
        {
          runtimeTaskId: "task-b",
          title: "B",
          status: "running",
          inputArtifactIds: [],
          outputArtifactIds: [],
          runIds: [],
          payload: {},
        },
      ],
      dependencies: [
        { fromTaskRuntimeId: "task-a", toTaskRuntimeId: "task-b", kind: "depends_on" },
      ],
      payload: {},
    };
    const snapshot = ingestTaskGraphSnapshot(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: snapshotPayload,
      receivedAt: now,
    });
    const replayedSnapshot = ingestTaskGraphSnapshot(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: snapshotPayload,
      receivedAt: "2026-05-22T00:02:00.000Z",
    });

    const taskCount = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph_tasks WHERE snapshot_id = ?")
      .get(snapshot.snapshotId) as { count: number };
    expect(taskCount.count).toBe(2);

    const artifactId = createId("art");
    const artifactPayload = {
      artifactId,
      scope: "project" as const,
      kind: "report",
      title: "MVP report",
      format: "markdown" as const,
      source: "runtime" as const,
      contentRef: { runtimePathRef: "artifact://local/mvp.md" },
      provenance: { runtimeSnapshotId: "snap-1" },
      links: [{ targetKind: "task", targetId: "task-b", relation: "output" }],
    };
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: artifactPayload,
      createdAt: now,
    });
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: artifactPayload,
      createdAt: "2026-05-22T00:02:00.000Z",
    });
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      payload: { ...artifactPayload, scope: "workspace" },
      createdAt: "2026-05-22T00:03:00.000Z",
    });

    const snapshotCount = db
      .prepare("SELECT COUNT(*) AS count FROM task_graph_snapshots")
      .get() as {
      count: number;
    };
    const artifactCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE id = ?")
      .get(artifactId) as {
      count: number;
    };
    const artifact = db
      .prepare("SELECT title, project_id AS projectId, scope FROM artifacts WHERE id = ?")
      .get(artifactId) as {
      title: string;
      projectId: string | null;
      scope: string;
    };
    const linkCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifact_links WHERE artifact_id = ?")
      .get(artifactId) as { count: number };

    expect(replayedSnapshot.snapshotId).toBe(snapshot.snapshotId);
    expect(snapshotCount.count).toBe(1);
    expect(artifact.title).toBe("MVP report");
    expect(artifact.projectId).toBe(project.id);
    expect(artifact.scope).toBe("project");
    expect(artifactCount.count).toBe(1);
    expect(linkCount.count).toBe(1);
    db.close();
  });

  it("keeps Artifact revisions monotonic while reconcile preserves rich associations", () => {
    const { db, runtimeWorkspaceBindingId, now } = setupRuntimeBinding();
    const workspace = createWorkspaceWithLease(db, {
      slug: "artifacts",
      name: "Artifacts",
      runtimeWorkspaceBindingId,
      createdAt: now,
    });
    const project = createProject(db, {
      workspaceId: workspace.id,
      slug: "preview",
      name: "Preview",
      createdAt: now,
    });
    const artifactId = createId("art");
    const artifactRef = "artifact:preview:monotonic";
    const projection = (
      version: number,
      updatedAt: string,
      content: string,
    ): ArtifactProjectionPayload => ({
      artifactId,
      scope: "project" as const,
      kind: "preview",
      title: "Monotonic preview",
      format: "text" as const,
      source: "runtime" as const,
      hash: `hash-v${version}`,
      sizeBytes: Buffer.byteLength(content),
      contentRef: {
        artifactRef,
        previewFormat: "mdx",
        version,
        progress: null,
        inlineText: content,
      },
      provenance: {
        producer: "spark-artifact",
        artifactRef,
        artifactUpdatedAt: updatedAt,
        runtimeInvocationId: `inv-${version}`,
      },
      links: [
        {
          targetKind: "invocation",
          targetId: `inv-${version}`,
          relation: "produced-by",
        },
      ],
    });

    const revisionOne = projection(1, "2026-05-22T00:01:00.000Z", "version one");
    const revisionTwo = projection(2, "2026-05-22T00:02:00.000Z", "version two");
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: revisionOne,
      createdAt: "2026-05-22T00:01:00.000Z",
    });
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      projectId: project.id,
      payload: revisionTwo,
      createdAt: "2026-05-22T00:02:00.000Z",
    });

    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        ...revisionOne,
        scope: "workspace",
        provenance: {
          producer: "spark-artifact",
          artifactRef,
          artifactUpdatedAt: "2026-05-22T00:01:00.000Z",
        },
        links: [],
      },
      preserveAssociations: true,
      createdAt: "2026-05-22T00:03:00.000Z",
    });

    const revisionThree = projection(3, "2026-05-22T00:04:00.000Z", "version three");
    recordArtifactProjection(db, {
      runtimeWorkspaceBindingId,
      workspaceId: workspace.id,
      payload: {
        ...revisionThree,
        scope: "workspace",
        provenance: {
          producer: "spark-artifact",
          artifactRef,
          artifactUpdatedAt: "2026-05-22T00:04:00.000Z",
        },
        links: [],
      },
      preserveAssociations: true,
      createdAt: "2026-05-22T00:04:00.000Z",
    });

    const stored = db
      .prepare(
        `SELECT project_id AS projectId,
                scope,
                hash,
                content_ref_json AS contentRefJson,
                provenance_json AS provenanceJson
         FROM artifacts
         WHERE id = ?`,
      )
      .get(artifactId) as {
      projectId: string | null;
      scope: string;
      hash: string | null;
      contentRefJson: string;
      provenanceJson: string;
    };
    expect(stored.projectId).toBe(project.id);
    expect(stored.scope).toBe("project");
    expect(stored.hash).toBe("hash-v3");
    expect(parseJson(stored.contentRefJson, "content ref")).toMatchObject({
      version: 3,
      inlineText: "version three",
    });
    expect(parseJson(stored.provenanceJson, "provenance")).toMatchObject({
      artifactUpdatedAt: "2026-05-22T00:04:00.000Z",
      runtimeInvocationId: "inv-2",
    });
    expect(
      db
        .prepare(
          `SELECT target_id AS targetId, relation
           FROM artifact_links
           WHERE artifact_id = ?`,
        )
        .all(artifactId),
    ).toEqual([{ targetId: "inv-2", relation: "produced-by" }]);

    expect(() =>
      recordArtifactProjection(db, {
        runtimeWorkspaceBindingId,
        workspaceId: "ws_other",
        payload: revisionThree,
      }),
    ).toThrow(/already belongs to another workspace/);
    db.close();
  });
});
