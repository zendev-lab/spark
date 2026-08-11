import { describe, expect, it } from "vitest";
import {
  parseSparkSessionRegistryRecord,
  SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT,
  SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCloseReceiptSchema,
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

  it("round-trips a bounded close candidate and daemon-sealed receipt", () => {
    const completion = {
      source: "structured_outcome",
      status: "completed",
      code: "implementation_complete",
      summary: "Implemented and verified the requested change.",
      nextAction: "Review the retained Evidence refs.",
      evidenceRefs: ["evidence:verification"],
      artifactRefs: ["artifact:git-change"],
      sourceInvocationIds: ["inv_role"],
    } as const;
    expect(sparkSessionArchiveRequestSchema.parse({ sessionId: "sess_role", completion })).toEqual({
      sessionId: "sess_role",
      completion,
    });

    const receipt = sparkSessionCloseReceiptSchema.parse({
      version: 1,
      ...completion,
      quality: "semantic",
      incarnation: 2,
      createdAt: timestamps.updatedAt,
    });
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_role",
        scope: { kind: "workspace", workspaceId: "ws_role" },
        closeReceipts: [receipt],
        ...timestamps,
      }).closeReceipts,
    ).toEqual([receipt]);
  });

  it("rejects forged, duplicate, oversized, or contradictory close metadata", () => {
    const completion = {
      source: "domain_completion",
      status: "blocked",
      code: "task_blocked",
      summary: "The task requires a user decision.",
      evidenceRefs: ["evidence:blocker"],
      artifactRefs: [],
      sourceInvocationIds: ["inv_task"],
    } as const;
    expect(() =>
      sparkSessionArchiveRequestSchema.parse({
        sessionId: "sess_task",
        completion: { ...completion, unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      sparkSessionArchiveRequestSchema.parse({
        sessionId: "sess_task",
        completion: {
          ...completion,
          evidenceRefs: ["evidence:blocker", "evidence:blocker"],
        },
      }),
    ).toThrow(/unique/u);
    expect(() =>
      sparkSessionArchiveRequestSchema.parse({
        sessionId: "sess_task",
        completion: { ...completion, artifactRefs: ["evidence:not-an-artifact"] },
      }),
    ).toThrow(/artifact/u);
    expect(() =>
      sparkSessionCloseReceiptSchema.parse({
        version: 1,
        ...completion,
        source: "deterministic_fallback",
        quality: "semantic",
        incarnation: 1,
        createdAt: timestamps.updatedAt,
      }),
    ).toThrow(/fallback quality/u);
    expect(
      sparkSessionCloseReceiptSchema.parse({
        version: 1,
        source: "deterministic_fallback",
        quality: "fallback",
        status: "cancelled",
        code: "session_closed_without_invocation",
        summary: "The owned Session closed before starting an invocation.",
        evidenceRefs: [],
        artifactRefs: [],
        sourceInvocationIds: [],
        incarnation: 1,
        createdAt: timestamps.updatedAt,
      }).sourceInvocationIds,
    ).toEqual([]);
    expect(() =>
      sparkSessionCloseReceiptSchema.parse({
        version: 1,
        ...completion,
        summary: "x".repeat(4_096),
        nextAction: "y".repeat(2_048),
        evidenceRefs: Array.from(
          { length: 20 },
          (_, index) => `evidence:${index}:${"z".repeat(500)}`,
        ),
        quality: "semantic",
        incarnation: 1,
        createdAt: timestamps.updatedAt,
      }),
    ).toThrow(new RegExp(String(SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES), "u"));
    expect(() =>
      parseSparkSessionRegistryRecord({
        sessionId: "sess_history",
        scope: { kind: "workspace", workspaceId: "ws_history" },
        closeReceipts: Array.from(
          { length: SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT + 1 },
          () => ({
            version: 1,
            ...completion,
            quality: "semantic",
            incarnation: 1,
            createdAt: timestamps.updatedAt,
          }),
        ),
        ...timestamps,
      }),
    ).toThrow();
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

  it("validates the stable Fleet worker lane relation and internal create binding", () => {
    const fleetWorker = {
      ownerSessionId: "sess_owner",
      projectRef: "proj:fleet",
      roleRef: "role:builtin-worker",
      laneKey: "lane:owner:project:worker:primary:targets",
      primaryArtifactRef: "artifact:primary",
      writableArtifactRefs: ["artifact:primary", "artifact:secondary"],
    };
    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        fleetWorker,
      }),
    ).toMatchObject({ fleetWorker });
    expect(
      parseSparkSessionRegistryRecord({
        sessionId: "sess_fleet_worker",
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        relation: { kind: "fleet_worker", ...fleetWorker },
        ...timestamps,
      }),
    ).toMatchObject({ relation: { kind: "fleet_worker", ...fleetWorker } });

    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        fleetWorker: {
          ...fleetWorker,
          writableArtifactRefs: ["artifact:secondary"],
        },
      }),
    ).toThrow(/primaryArtifactRef must appear/u);
    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        taskExecution: {
          ownerSessionId: "sess_owner",
          projectRef: "proj:fleet",
          taskRef: "task:one",
          runRef: "run:one",
          sessionGoalId: "goal-one",
          roleRef: "role:builtin-worker",
          jobId: "job-one",
          attempt: 1,
        },
        fleetWorker,
      }),
    ).toThrow(/mutually exclusive/u);
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
