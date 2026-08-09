import { describe, expect, it } from "vitest";
import {
  parseSparkSessionRegistryRecord,
  sparkSessionBindRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionUnbindRequestSchema,
} from "./session-assignment.ts";

const timestamps = {
  createdAt: "2026-07-10T06:00:00.000Z",
  updatedAt: "2026-07-10T06:00:01.000Z",
};

describe("session ownership protocol", () => {
  it("normalizes legacy workspaceId-only records into canonical workspace scope", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_legacy",
        workspaceId: "ws_legacy",
        ...timestamps,
      }),
    ).toMatchObject({
      sessionId: "sess_legacy",
      scope: { kind: "workspace", workspaceId: "ws_legacy" },
      workspaceId: "ws_legacy",
    });
  });

  it("represents daemon-global records without a synthetic workspace", () => {
    const record = parseSparkSessionRegistryRecord({
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "spark-daemon-install-test" },
      ...timestamps,
    });
    expect(record.scope).toEqual({
      kind: "daemon",
      daemonId: "spark-daemon-install-test",
    });
    expect(record).not.toHaveProperty("workspaceId");
  });

  it("preserves configured and stable account identities on channel bindings", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_channel",
        scope: { kind: "workspace", workspaceId: "ws_channel" },
        bindings: [
          {
            kind: "channel",
            adapter: "infoflow",
            adapterId: "info-main",
            adapterAccountIdentity: "channel-account:infoflow:account-a",
            externalKey: "infoflow:user:alice",
          },
        ],
        ...timestamps,
      }),
    ).toMatchObject({
      bindings: [
        {
          adapterId: "info-main",
          adapterAccountIdentity: "channel-account:infoflow:account-a",
        },
      ],
    });
    expect(
      sparkSessionBindRequestSchema.parse({
        sessionId: "sess_channel",
        externalKey: "infoflow:user:alice",
        adapterId: "info-main",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).toMatchObject({ adapterId: "info-main", adapterAccountIdentity: expect.any(String) });
    expect(
      sparkSessionUnbindRequestSchema.parse({
        sessionId: "sess_channel",
        externalKey: "infoflow:user:alice",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).toMatchObject({ adapterAccountIdentity: "channel-account:infoflow:account-a" });
  });

  it("lets clients request daemon scope but rejects a client-supplied daemonId", () => {
    expect(sparkSessionCreateRequestSchema.parse({ scope: { kind: "daemon" } })).toEqual({
      scope: { kind: "daemon" },
    });
    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "daemon", daemonId: "spoofed-installation" },
      }),
    ).toThrow();
    expect(
      sparkSessionListRequestSchema.parse({
        scope: { kind: "daemon" },
        cursor: "sess_cursor",
        limit: 100,
      }),
    ).toEqual({
      scope: { kind: "daemon" },
      cursor: "sess_cursor",
      limit: 100,
    });
    expect(() =>
      sparkSessionListRequestSchema.parse({ scope: { kind: "daemon" }, limit: 101 }),
    ).toThrow();
  });

  it("preserves daemon-emitted side-thread relations without accepting them on create", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_side",
        scope: { kind: "workspace", workspaceId: "ws_side" },
        relation: {
          kind: "side_thread",
          parentSessionId: "sess_parent",
          generation: 3,
          mode: "tangent",
        },
        ...timestamps,
      }),
    ).toMatchObject({
      relation: {
        kind: "side_thread",
        parentSessionId: "sess_parent",
        generation: 3,
        mode: "tangent",
      },
    });

    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_side" },
        relation: {
          kind: "side_thread",
          parentSessionId: "sess_parent",
          generation: 1,
          mode: "contextual",
        },
      }),
    ).not.toHaveProperty("relation");

    expect(sparkSessionListRequestSchema.parse({ includeSideThreads: true })).not.toHaveProperty(
      "includeSideThreads",
    );
  });

  it("preserves the complete managed Task execution chain", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_task",
        scope: { kind: "workspace", workspaceId: "ws_task" },
        relation: {
          kind: "task_execution",
          ownerSessionId: "sess_owner",
          projectRef: "proj:repro",
          taskRef: "task:trace",
          subgoalRef: "subgoal:trace",
          runRef: "run:trace-1",
          sessionGoalId: "goal-trace-1",
          roleRef: "role:builtin-explorer",
          planRevision: 2,
          definitionDigest: "digest",
          jobId: "job",
          attempt: 1,
        },
        ...timestamps,
      }),
    ).toMatchObject({
      relation: {
        kind: "task_execution",
        projectRef: "proj:repro",
        taskRef: "task:trace",
        subgoalRef: "subgoal:trace",
        runRef: "run:trace-1",
        sessionGoalId: "goal-trace-1",
        attempt: 1,
      },
    });
  });

  it("accepts canonical Role/Session ownership fields on records and create requests", () => {
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_role",
        scope: { kind: "workspace", workspaceId: "ws_role" },
        lifecycle: "open",
        incarnation: 2,
        lifetime: "owned",
        owner: { kind: "role_call", ref: "inv_role" },
        roleRef: "role:builtin-explorer",
        roleRevision: 3,
        modelType: "exploration",
        authority: { kind: "role", ref: "role:builtin-explorer" },
        stateBinding: { kind: "session", ref: "sess_parent" },
        visibility: "owner",
        retention: "discard_on_close",
        purpose: "Inspect the current repository.",
        transcriptRef: "transcript:sess_role:2",
        ...timestamps,
      }),
    ).toMatchObject({
      lifecycle: "open",
      lifetime: "owned",
      owner: { kind: "role_call", ref: "inv_role" },
      retention: "discard_on_close",
    });

    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_role" },
        roleRef: "role:builtin-explorer",
        parentSessionId: "sess_parent",
        purpose: "Inspect the current repository.",
      }),
    ).toMatchObject({
      roleRef: "role:builtin-explorer",
      parentSessionId: "sess_parent",
      purpose: "Inspect the current repository.",
    });
  });

  it("accepts an internal task-execution binding and preserves only daemon-emitted relation", () => {
    const taskExecution = {
      ownerSessionId: "sess_owner",
      projectRef: "proj:model-repro",
      taskRef: "task:trace-reference",
      subgoalRef: "subgoal:trace-reference",
      runRef: "run:trace-reference-1",
      sessionGoalId: "goal-trace-reference-1",
      roleRef: "role:builtin-explorer",
      planRevision: 6,
      definitionDigest: "abc123",
      jobId: "task-job:abc123",
      attempt: 1,
    };
    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_repro" },
        taskExecution,
      }),
    ).toMatchObject({ taskExecution });
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_task",
        scope: { kind: "workspace", workspaceId: "ws_repro" },
        relation: { kind: "task_execution", ...taskExecution },
        ...timestamps,
      }),
    ).toMatchObject({ relation: { kind: "task_execution", ...taskExecution } });
    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_repro" },
        relation: { kind: "task_execution", ...taskExecution },
      }),
    ).not.toHaveProperty("relation");
  });

  it("rejects mismatched workspace ids and normalizes list legacy workspaceId", () => {
    expect(() =>
      parseSparkSessionRegistryRecord({
        sessionId: "sess_mismatch",
        scope: { kind: "workspace", workspaceId: "ws_a" },
        workspaceId: "ws_b",
        createdAt: "2026-07-10T06:00:00.000Z",
        updatedAt: "2026-07-10T06:00:01.000Z",
      }),
    ).toThrow(/workspaceId must match scope.workspaceId/u);

    expect(
      sparkSessionListRequestSchema.parse({
        workspaceId: "ws_legacy_list",
        limit: 10,
      }),
    ).toMatchObject({
      scope: { kind: "workspace", workspaceId: "ws_legacy_list" },
      workspaceId: "ws_legacy_list",
      limit: 10,
    });

    expect(() => sparkSessionListRequestSchema.parse(null)).toThrow();
    expect(() => sparkSessionListRequestSchema.parse([])).toThrow();
  });
});
