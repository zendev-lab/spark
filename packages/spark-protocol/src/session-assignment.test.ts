import { describe, expect, it } from "vitest";
import {
  parseSparkSessionProjection,
  parseSparkSessionState,
  sparkSessionLifetimeForOwner,
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

function workspaceRecord(owner: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_test",
    scope: { kind: "workspace", workspaceId: "ws_test" },
    lifecycle: "open",
    placement: "active",
    activity: "idle",
    lifetime: sparkSessionLifetimeForOwner(owner as never),
    roleBinding:
      owner.kind === "workspace"
        ? { kind: "explicit", roleRef: "role:builtin-administrator" }
        : { kind: "none" },
    owner,
    incarnation: 1,
    stateBinding: { kind: "session", ref: "sess_test" },
    visibility: owner.kind === "invocation" ? "internal" : "public",
    retention: owner.kind === "workspace" ? "audit" : "retain",
    purpose: "protocol test",
    bindings: [],
    ...timestamps,
    ...extra,
  };
}

describe("session ownership protocol", () => {
  it.each([
    [{ kind: "workspace", workspaceId: "ws_test" }, "persistent"],
    [{ kind: "session", supervisorSessionId: "sess_admin" }, "scoped"],
    [{ kind: "side_thread", parentSessionId: "sess_parent", generation: 2 }, "scoped"],
    [
      {
        kind: "task_run",
        supervisorSessionId: "sess_admin",
        projectRef: "proj:repro",
        taskRef: "task:trace",
        runRef: "run:trace-1",
        sessionGoalId: "goal-trace-1",
        roleRef: "role:builtin-explorer",
        jobId: "task-job:trace",
        attempt: 1,
      },
      "scoped",
    ],
    [
      {
        kind: "driver",
        driverId: "driver-1",
        generation: 3,
        supervisorSessionId: "sess_admin",
      },
      "scoped",
    ],
    [
      {
        kind: "invocation",
        invocationId: "inv-1",
        supervisorSessionId: "sess_admin",
      },
      "ephemeral",
    ],
  ] as const)("derives %s owner lifetime as %s and round-trips it", (owner, lifetime) => {
    const record = parseSparkSessionProjection(workspaceRecord(owner));
    expect(record.lifetime).toBe(lifetime);
    expect(parseSparkSessionProjection(record)).toEqual(record);
    expect(() =>
      parseSparkSessionProjection({
        ...record,
        lifetime: lifetime === "persistent" ? "ephemeral" : "persistent",
      }),
    ).toThrow(/lifetime must be/u);
  });

  it("hard-rejects retired writable role, relation, status, and workspaceId fields", () => {
    const canonical = workspaceRecord({ kind: "session", supervisorSessionId: "sess_admin" });
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
    const administrator = workspaceRecord({ kind: "workspace", workspaceId: "ws_test" });
    expect(() => parseSparkSessionProjection({ ...administrator, retention: "retain" })).toThrow(
      /audit-retained/u,
    );
  });

  it("keeps derived fields out of strict stored state", () => {
    const projection = workspaceRecord({ kind: "session", supervisorSessionId: "sess_admin" });
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
      owner: {
        kind: "invocation",
        invocationId: "inv_legacy_audit",
        supervisorSessionId: "sess_legacy_audit",
      },
      incarnation: 1,
      stateBinding: { kind: "session", ref: "sess_global_audit" },
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
        { kind: "session", supervisorSessionId: "sess_admin" },
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
      ownerKind: "task_run" as const,
      supervisorSessionId: "sess_owner",
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
        roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
        taskExecution,
      }),
    ).toMatchObject({ taskExecution });

    const { ownerKind: _ownerKind, ...taskRunOwner } = taskExecution;
    const record = parseSparkSessionProjection({
      ...workspaceRecord({ kind: "task_run", ...taskRunOwner }),
      roleBinding: { kind: "explicit", roleRef: "role:builtin-explorer" },
    });
    expect(record.owner).toEqual({ kind: "task_run", ...taskRunOwner });
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
          { kind: "session", supervisorSessionId: "sess_owner" },
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
          ownerKind: "task_run",
          supervisorSessionId: "sess_owner",
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
