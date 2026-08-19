import { describe, expect, it } from "vitest";
import {
  parseSparkSessionProjection,
  parseSparkSessionState,
  sparkSessionLifetimeForLineage,
  sparkSessionParentId,
  SPARK_SESSION_CLOSE_RECEIPT_HISTORY_LIMIT,
  SPARK_SESSION_CLOSE_RECEIPT_MAX_BYTES,
  SPARK_SESSION_COMPACT_CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  sparkSessionArchiveRequestSchema,
  sparkSessionBindRequestSchema,
  sparkSessionCloseReceiptSchema,
  sparkSessionCompactRequestSchema,
  sparkSessionCreateRequestSchema,
  sparkSessionListRequestSchema,
  sparkSessionUnbindRequestSchema,
} from "./session-assignment.ts";

const timestamps = {
  createdAt: "2026-07-10T06:00:00.000Z",
  updatedAt: "2026-07-10T06:00:01.000Z",
};

function workspaceRecord(lineage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_test",
    scope: { kind: "workspace", workspaceId: "ws_test" },
    lifecycle: "open",
    placement: "active",
    activity: "idle",
    lifetime: sparkSessionLifetimeForLineage(lineage as never),
    roleBinding:
      lineage.kind === "root"
        ? { kind: "explicit", roleRef: "role:builtin-administrator" }
        : { kind: "none" },
    lineage,
    incarnation: 1,
    visibility:
      lineage.kind === "child" &&
      (lineage.origin as { kind?: string } | undefined)?.kind === "invocation"
        ? "internal"
        : "public",
    retention: lineage.kind === "root" ? "audit" : "retain",
    purpose: "protocol test",
    bindings: [],
    ...timestamps,
    ...extra,
  };
}

describe("session lineage protocol", () => {
  it.each([
    [{ kind: "root", workspaceId: "ws_test" }, "persistent"],
    [{ kind: "child", parentSessionId: "sess_admin", origin: { kind: "session" } }, "scoped"],
    [
      {
        kind: "child",
        parentSessionId: "sess_parent",
        origin: { kind: "side_thread", generation: 2 },
      },
      "scoped",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: {
          kind: "task_run",
          projectRef: "proj:repro",
          taskRef: "task:trace",
          runRef: "run:trace-1",
          sessionGoalId: "goal-trace-1",
          roleRef: "role:builtin-explorer",
          jobId: "task-job:trace",
          attempt: 1,
        },
      },
      "scoped",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: { kind: "driver", driverId: "driver-1", generation: 3 },
      },
      "scoped",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: { kind: "invocation", invocationId: "inv-1" },
      },
      "ephemeral",
    ],
  ] as const)("derives %s lineage lifetime as %s and round-trips it", (lineage, lifetime) => {
    const record = parseSparkSessionProjection(workspaceRecord(lineage));
    expect(record.lifetime).toBe(lifetime);
    expect(parseSparkSessionProjection(record)).toEqual(record);
    expect(() =>
      parseSparkSessionProjection({
        ...record,
        lifetime: lifetime === "persistent" ? "ephemeral" : "persistent",
      }),
    ).toThrow(/lifetime must be/u);
  });

  it.each([
    [{ kind: "root", workspaceId: "ws_test" }, undefined],
    [{ kind: "child", parentSessionId: "sess_admin", origin: { kind: "session" } }, "sess_admin"],
    [
      {
        kind: "child",
        parentSessionId: "sess_parent",
        origin: { kind: "side_thread", generation: 2 },
      },
      "sess_parent",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: {
          kind: "task_run",
          projectRef: "proj:repro",
          taskRef: "task:trace",
          runRef: "run:trace-1",
          sessionGoalId: "goal-trace-1",
          roleRef: "role:builtin-explorer",
          jobId: "task-job:trace",
          attempt: 1,
        },
      },
      "sess_admin",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: {
          kind: "task_revision",
          projectRef: "proj:repro",
          taskRef: "task:trace",
          sessionGoalId: "goal-trace-1",
          roleRef: "role:builtin-explorer",
          jobId: "task-job:trace",
          attempt: 1,
          revisionRef: "rev:trace-1",
          originatingRunRef: "run:trace-1",
        },
      },
      "sess_admin",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: {
          kind: "workflow_run",
          workflowRef: "workflow:trace",
          runRef: "run:workflow-1",
          generation: 1,
        },
      },
      "sess_admin",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: { kind: "invocation", invocationId: "inv-1" },
      },
      "sess_admin",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: { kind: "driver", driverId: "driver-1", generation: 3 },
      },
      "sess_admin",
    ],
    [
      {
        kind: "child",
        parentSessionId: "sess_admin",
        origin: {
          kind: "driver_tick",
          driverId: "driver-1",
          generation: 3,
          tickInvocationId: "inv-tick-1",
        },
      },
      "sess_admin",
    ],
  ] as const)("resolves %s parent session id", (lineage, sessionId) => {
    expect(sparkSessionParentId(lineage as never)).toBe(sessionId);
  });

  it("normalizes bounded manual compaction instructions", () => {
    expect(
      sparkSessionCompactRequestSchema.parse({
        sessionId: " session-compact ",
        customInstructions: " preserve exact identifiers ",
        idempotencyKey: " compact-once ",
      }),
    ).toEqual({
      sessionId: "session-compact",
      customInstructions: "preserve exact identifiers",
      idempotencyKey: "compact-once",
    });
    expect(() =>
      sparkSessionCompactRequestSchema.parse({
        sessionId: "session-compact",
        customInstructions: "x".repeat(SPARK_SESSION_COMPACT_CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("hard-rejects retired writable role, relation, status, and workspaceId fields", () => {
    const canonical = workspaceRecord({
      kind: "child",
      parentSessionId: "sess_admin",
      origin: { kind: "session" },
    });
    for (const retired of [
      { workspaceId: "ws_test" },
      { role: "explorer" },
      { title: "Explorer" },
      { status: "ready" },
      { authority: { kind: "administrator" } },
      { relation: { kind: "side_thread", parentSessionId: "sess_parent", generation: 1 } },
    ]) {
      expect(() => parseSparkSessionProjection({ ...canonical, ...retired })).toThrow();
    }
  });

  it("requires the workspace-owned Administrator projection to remain audit-retained", () => {
    const administrator = workspaceRecord({ kind: "root", workspaceId: "ws_test" });
    expect(() => parseSparkSessionProjection({ ...administrator, retention: "retain" })).toThrow(
      /audit-retained/u,
    );
  });

  it("keeps derived fields out of strict stored state", () => {
    const projection = workspaceRecord({
      kind: "child",
      parentSessionId: "sess_admin",
      origin: { kind: "session" },
    });
    const { activity: _activity, lifetime: _lifetime, ...state } = projection;
    expect(parseSparkSessionState(state)).not.toHaveProperty("activity");
    expect(() => parseSparkSessionState(projection)).toThrow(/unrecognized_/u);
  });

  it("represents legacy daemon-global state only as a closed audit record", () => {
    const audit = parseSparkSessionProjection({
      sessionId: "sess_global_audit",
      scope: { kind: "daemon", daemonId: "spark-daemon-install-test" },
      lifecycle: "closed",
      placement: "active",
      activity: "idle",
      lifetime: "ephemeral",
      roleBinding: { kind: "none" },
      lineage: {
        kind: "child",
        parentSessionId: "sess_legacy_audit",
        origin: { kind: "invocation", invocationId: "inv_legacy_audit" },
      },
      incarnation: 1,
      visibility: "internal",
      retention: "audit",
      purpose: "legacy daemon audit",
      bindings: [],
      ...timestamps,
    });
    expect(audit).toMatchObject({ lifecycle: "closed", lifetime: "ephemeral" });
    expect(() => parseSparkSessionProjection({ ...audit, lifecycle: "open" })).toThrow(
      /closed audit records only/u,
    );
  });

  it("preserves configured and stable account identities on channel bindings", () => {
    const record = parseSparkSessionProjection(
      workspaceRecord(
        { kind: "child", parentSessionId: "sess_admin", origin: { kind: "session" } },
        {
          bindings: [
            {
              kind: "channel",
              adapter: "infoflow",
              adapterId: "info-main",
              adapterAccountIdentity: "channel-account:infoflow:account-a",
              externalKey: "infoflow:user:alice",
            },
          ],
        },
      ),
    );
    expect(record.bindings[0]).toMatchObject({
      adapterId: "info-main",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
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

  it("hard-cuts Session create to scoped child or sibling requests", () => {
    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_test" },
        supervisorSessionId: "sess_admin",
        placement: "child",
        name: "Investigation",
        roleBinding: { kind: "none" },
      }),
    ).toEqual({
      scope: { kind: "workspace", workspaceId: "ws_test" },
      supervisorSessionId: "sess_admin",
      placement: "child",
      name: "Investigation",
      roleBinding: { kind: "none" },
    });
    for (const retired of [
      { workspaceId: "ws_test" },
      { title: "Investigation" },
      { role: "explorer" },
      { status: "ready" },
      { relation: { kind: "side_thread", parentSessionId: "sess_parent", generation: 1 } },
    ]) {
      expect(() =>
        sparkSessionCreateRequestSchema.parse({
          scope: { kind: "workspace", workspaceId: "ws_test" },
          supervisorSessionId: "sess_admin",
          ...retired,
        }),
      ).toThrow();
    }
    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "daemon", daemonId: "spoofed-installation" },
      }),
    ).toThrow();
  });

  it("accepts the internal TaskRun binding with a supervisor and no relation alias", () => {
    const taskExecution = {
      originKind: "task_run" as const,
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
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
        taskExecution,
      }),
    ).toMatchObject({ taskExecution });

    const { originKind: _originKind, ...taskRunOrigin } = taskExecution;
    const record = parseSparkSessionProjection({
      ...workspaceRecord({
        kind: "child",
        parentSessionId: "sess_owner",
        origin: { kind: "task_run", ...taskRunOrigin },
      }),
      roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
    });
    expect(record.lineage).toEqual({
      kind: "child",
      parentSessionId: "sess_owner",
      origin: { kind: "task_run", ...taskRunOrigin },
    });
    expect(record).not.toHaveProperty("relation");
  });

  it("validates the stable Fleet worker lane binding without reviving relation", () => {
    const fleetWorker = {
      ownerSessionId: "sess_owner",
      projectRef: "proj:fleet",
      roleRef: "role:builtin-executor",
      laneKey: "lane:owner:project:worker:primary:targets",
      primaryArtifactRef: "artifact:primary",
      writableArtifactRefs: ["artifact:primary", "artifact:secondary"],
    };
    expect(
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        fleetWorker,
      }),
    ).toMatchObject({ fleetWorker });
    expect(
      parseSparkSessionProjection(
        workspaceRecord(
          { kind: "child", parentSessionId: "sess_owner", origin: { kind: "session" } },
          {
            sessionId: "sess_fleet_worker",
            scope: { kind: "workspace", workspaceId: "ws_fleet" },
            roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
            fleetWorker,
          },
        ),
      ),
    ).toMatchObject({ fleetWorker });

    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        fleetWorker: {
          ...fleetWorker,
          writableArtifactRefs: ["artifact:secondary"],
        },
      }),
    ).toThrow(/primaryArtifactRef must appear/u);
    expect(() =>
      sparkSessionCreateRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_fleet" },
        supervisorSessionId: "sess_owner",
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        taskExecution: {
          originKind: "task_run",
          projectRef: "proj:fleet",
          taskRef: "task:one",
          runRef: "run:one",
          sessionGoalId: "goal-one",
          roleRef: "role:builtin-executor",
          jobId: "job-one",
          attempt: 1,
        },
        fleetWorker,
      }),
    ).toThrow(/mutually exclusive/u);
  });

  it("keeps list scope explicit and rejects legacy workspaceId", () => {
    expect(
      sparkSessionListRequestSchema.parse({
        scope: { kind: "workspace", workspaceId: "ws_test" },
        includeArchived: true,
        limit: 10,
      }),
    ).toMatchObject({
      scope: { kind: "workspace", workspaceId: "ws_test" },
      includeArchived: true,
      limit: 10,
    });
    expect(() => sparkSessionListRequestSchema.parse({ workspaceId: "ws_legacy" })).toThrow();
    expect(() => sparkSessionListRequestSchema.parse(null)).toThrow();
    expect(() => sparkSessionListRequestSchema.parse([])).toThrow();
  });
});
