import {
  parseSparkSessionProjection,
  type SparkSessionProjection,
} from "@zendev-lab/spark-protocol";
import { RuntimeControlCommandError } from "@zendev-lab/spark-hub-coordination/runtime-control";
import { describe, expect, it, vi } from "vitest";
import {
  archiveManagedSessionForHub,
  bindManagedSessionForHub,
  createManagedSessionForHub,
  getManagedSessionForHub,
  getLiveManagedSessionForHub,
  getManagedSideThreadSnapshotForHub,
  getManagedSessionSnapshotForHub,
  listManagedSessionsForHub,
  type HubManagedSessionsClient,
} from "./managed-sessions";
import { HubRuntimeSessionUnavailableError } from "./hub-runtime-session-client";

const session: SparkSessionProjection = {
  sessionId: "sess_a",
  scope: { kind: "workspace", workspaceId: "ws_a" },
  name: "Alpha",
  lifecycle: "open",
  placement: "active",
  activity: "idle",
  roleBinding: { kind: "none" },
  incarnation: 1,
  owner: { kind: "session", supervisorSessionId: "sess_admin" },
  stateBinding: { kind: "session", ref: "sess_a" },
  visibility: "public",
  retention: "retain",
  purpose: "test",
  lifetime: "scoped",
  bindings: [],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

const daemonSession: SparkSessionProjection = {
  ...session,
  sessionId: "sess_daemon",
  scope: { kind: "daemon", daemonId: "daemon-a" },
  lifecycle: "closed",
  owner: {
    kind: "invocation",
    invocationId: "migration:sess_daemon",
    supervisorSessionId: "migration:closed-daemon-audit",
  },
  lifetime: "ephemeral",
};

const secondParent: SparkSessionProjection = {
  ...session,
  sessionId: "sess_b",
  name: "Beta",
};

function sideThread(
  sessionId: string,
  parentSessionId: string,
  generation: number,
  mode: "contextual" | "tangent",
  overrides: {
    placement?: SparkSessionProjection["placement"];
    scope?: { kind: "workspace"; workspaceId: string };
  } = {},
): SparkSessionProjection {
  return parseSparkSessionProjection({
    ...session,
    sessionId,
    name: `${mode} child`,
    roleBinding: { kind: "inherit" },
    owner: { kind: "side_thread", parentSessionId, generation },
    sideThreadMode: mode,
    ...overrides,
  });
}

const snapshot = {
  version: 2 as const,
  sessionId: "sess_a",
  title: "Alpha",
  status: "idle" as const,
  messages: [
    {
      version: 2 as const,
      id: "msg_user",
      role: "user" as const,
      text: "Message from Infoflow",
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

const snapshotWindow = {
  snapshot,
  history: {
    totalMessages: 1,
    loadedMessages: 1,
    hiddenMessages: 0,
    earlierMessages: 0,
    laterMessages: 0,
    hasEarlierMessages: false,
  },
};

describe("managed sessions for hub", () => {
  it("delegates reads to the daemon-owned session RPC", async () => {
    const client = daemonClient();

    const workspaceScope = {
      scope: { kind: "workspace" as const, workspaceId: "ws_a" },
    };
    await expect(listManagedSessionsForHub(workspaceScope, client)).resolves.toEqual({
      available: true,
      controlAvailable: true,
      sessions: [session],
    });
    await expect(getManagedSessionForHub("sess_a", client)).resolves.toEqual(session);
    await expect(getManagedSessionSnapshotForHub("sess_a", {}, client)).resolves.toEqual(
      snapshotWindow,
    );

    expect(client.list).toHaveBeenCalledWith(workspaceScope);
    expect(client.controlAvailable).toHaveBeenCalledWith(workspaceScope);
    expect(client.get).toHaveBeenCalledWith("sess_a");
    expect(client.snapshot).toHaveBeenCalledWith("sess_a", {});
  });

  it("reads an existing Side Thread without materializing one", async () => {
    const client = daemonClient();
    const sideThread = {
      parentSessionId: session.sessionId,
      sessionId: "sess_a_btw",
      generation: 1,
      mode: "contextual" as const,
      status: "idle" as const,
      pendingTurns: [],
      exchanges: [],
      hasMore: false,
    };
    client.sideThreadSnapshot.mockResolvedValue(sideThread);

    await expect(
      getManagedSideThreadSnapshotForHub(session.sessionId, {}, client),
    ).resolves.toEqual(sideThread);
    expect(client.sideThreadSnapshot).toHaveBeenCalledWith(session.sessionId, {});
    expect(client.create).not.toHaveBeenCalled();
  });

  it("rechecks the live parent workspace before reading Side Thread content", async () => {
    const client = daemonClient();

    await expect(
      getManagedSideThreadSnapshotForHub(session.sessionId, { workspaceId: "ws_foreign" }, client),
    ).resolves.toBeNull();
    expect(client.get).toHaveBeenCalledWith(session.sessionId);
    expect(client.sideThreadSnapshot).not.toHaveBeenCalled();
  });

  it("preserves Side Thread owner unavailability instead of reporting absence", async () => {
    const client = daemonClient();
    client.sideThreadSnapshot.mockRejectedValueOnce(
      new HubRuntimeSessionUnavailableError("daemon offline"),
    );

    await expect(getManagedSideThreadSnapshotForHub(session.sessionId, {}, client)).rejects.toThrow(
      HubRuntimeSessionUnavailableError,
    );
  });

  it("keeps daemon-scoped sessions outside every Hub read surface", async () => {
    const client = daemonClient();
    client.list.mockResolvedValueOnce([session, daemonSession]);
    client.get.mockResolvedValue(daemonSession);

    await expect(listManagedSessionsForHub({}, client)).resolves.toEqual({
      available: true,
      controlAvailable: true,
      sessions: [session],
    });
    await expect(listManagedSessionsForHub({ scope: { kind: "daemon" } }, client)).resolves.toEqual(
      { available: true, controlAvailable: false, sessions: [] },
    );
    await expect(getManagedSessionForHub(daemonSession.sessionId, client)).resolves.toBeNull();
    await expect(
      getManagedSessionSnapshotForHub(daemonSession.sessionId, {}, client),
    ).resolves.toBeNull();

    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it("returns related workspace sessions only when the rail requests them", async () => {
    const client = daemonClient();
    const activeChildren = [
      sideThread("sess_a_context", session.sessionId, 1, "contextual"),
      sideThread("sess_a_tangent", session.sessionId, 2, "tangent"),
      sideThread("sess_b_context", secondParent.sessionId, 1, "contextual"),
    ];
    const archivedChild = sideThread("sess_a_archived", session.sessionId, 3, "contextual", {
      placement: "archived",
    });
    client.list.mockResolvedValue([session, ...activeChildren, secondParent, archivedChild]);
    const workspace = {
      scope: { kind: "workspace" as const, workspaceId: "ws_a" },
    };

    await expect(listManagedSessionsForHub(workspace, client)).resolves.toMatchObject({
      sessions: [session, secondParent],
    });
    await expect(
      listManagedSessionsForHub({ ...workspace, related: true }, client),
    ).resolves.toMatchObject({ sessions: [session, ...activeChildren, secondParent] });
    await expect(
      listManagedSessionsForHub({ ...workspace, related: true, includeArchived: true }, client),
    ).resolves.toMatchObject({
      sessions: [session, ...activeChildren, secondParent, archivedChild],
    });
  });

  it("excludes related sessions from another workspace", async () => {
    const client = daemonClient();
    const foreign = sideThread("sess_foreign_child", "sess_foreign_parent", 1, "contextual", {
      scope: { kind: "workspace", workspaceId: "ws_foreign" },
    });
    client.list.mockResolvedValue([session, foreign]);

    await expect(
      listManagedSessionsForHub(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
          related: true,
        },
        client,
      ),
    ).resolves.toMatchObject({ sessions: [session] });
  });

  it("returns an empty read model when the daemon is unavailable or stale", async () => {
    const client = daemonClient();
    client.list.mockRejectedValueOnce(
      new HubRuntimeSessionUnavailableError("restart or upgrade the daemon"),
    );

    await expect(listManagedSessionsForHub({}, client)).resolves.toEqual({
      available: false,
      controlAvailable: false,
      sessions: [],
      error: "restart or upgrade the daemon",
    });
  });

  it("keeps cached conversations readable when workspace control is offline", async () => {
    const client = daemonClient();
    client.controlAvailable.mockReturnValueOnce(false);

    await expect(
      listManagedSessionsForHub(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
        },
        client,
      ),
    ).resolves.toEqual({
      available: true,
      controlAvailable: false,
      sessions: [session],
    });
  });

  it("uses the current list attempt instead of a stale route availability hint", async () => {
    const baseClient = daemonClient();
    const client = {
      ...baseClient,
      listWithControlState: vi.fn(async () => ({
        sessions: [session],
        controlAvailable: false,
      })),
    };

    await expect(
      listManagedSessionsForHub(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
        },
        client,
      ),
    ).resolves.toEqual({
      available: true,
      controlAvailable: false,
      sessions: [session],
    });
    expect(baseClient.list).not.toHaveBeenCalled();
    expect(baseClient.controlAvailable).not.toHaveBeenCalled();
  });

  it("returns null for get when the daemon is unavailable or the session is missing", async () => {
    const client = daemonClient();
    client.get
      .mockRejectedValueOnce(new HubRuntimeSessionUnavailableError("daemon offline"))
      .mockRejectedValueOnce(
        new RuntimeControlCommandError("unknown session: sess_missing", "session_not_found"),
      )
      .mockRejectedValueOnce(
        new RuntimeControlCommandError(
          "session sess_foreign does not belong to workspace ws_a",
          "session_scope_mismatch",
        ),
      );

    await expect(getManagedSessionForHub("sess_a", client)).resolves.toBeNull();
    await expect(getManagedSessionForHub("sess_missing", client)).resolves.toBeNull();
    await expect(getManagedSessionForHub("sess_foreign", client)).resolves.toBeNull();
  });

  it("preserves owner unavailability for authorization-sensitive reads", async () => {
    const client = daemonClient();
    client.get.mockRejectedValueOnce(new HubRuntimeSessionUnavailableError("daemon offline"));

    await expect(getLiveManagedSessionForHub("sess_a", client)).rejects.toThrow(
      HubRuntimeSessionUnavailableError,
    );
  });

  it("returns null for unavailable snapshots and surfaces invalid daemon responses", async () => {
    const client = daemonClient();
    client.snapshot
      .mockRejectedValueOnce(new HubRuntimeSessionUnavailableError("daemon offline"))
      .mockRejectedValueOnce(new Error("invalid session view"));

    await expect(getManagedSessionSnapshotForHub("sess_a", {}, client)).resolves.toBeNull();
    await expect(getManagedSessionSnapshotForHub("sess_a", {}, client)).rejects.toThrow(
      "invalid session view",
    );
  });

  it("returns mutations only after the daemon acknowledges them", async () => {
    const archived = {
      ...session,
      placement: "archived" as const,
      updatedAt: "2026-07-10T00:01:00.000Z",
    };
    const bound = {
      ...session,
      bindings: [
        {
          kind: "channel" as const,
          adapter: "infoflow" as const,
          externalKey: "infoflow:user:u1",
          boundAt: "2026-07-10T00:00:30.000Z",
        },
      ],
      updatedAt: "2026-07-10T00:00:30.000Z",
    };
    const client = daemonClient({ archiveResult: archived, bindResult: bound });

    await expect(
      createManagedSessionForHub(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
          supervisorSessionId: "sess_admin",
          name: "Alpha",
          roleBinding: { kind: "none" },
        },
        client,
      ),
    ).resolves.toEqual(session);
    await expect(
      bindManagedSessionForHub({ sessionId: "sess_a", externalKey: "infoflow:user:u1" }, client),
    ).resolves.toEqual(bound);
    await expect(archiveManagedSessionForHub("sess_a", client)).resolves.toEqual(archived);

    expect(client.create).toHaveBeenCalledWith({
      scope: { kind: "workspace", workspaceId: "ws_a" },
      supervisorSessionId: "sess_admin",
      name: "Alpha",
      roleBinding: { kind: "none" },
    });
    expect(client.bind).toHaveBeenCalledWith({
      sessionId: "sess_a",
      externalKey: "infoflow:user:u1",
    });
    expect(client.archive).toHaveBeenCalledWith("sess_a");
  });

  it("rejects the retired daemon-global creation scope", async () => {
    const client = daemonClient();

    await expect(
      createManagedSessionForHub(
        {
          runtimeId: "runtime-a",
          scope: { kind: "daemon" } as never,
          name: "Legacy daemon session",
        } as never,
        client,
      ),
    ).rejects.toThrow("workspace-scoped sessions only");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("does not fabricate an offline fallback when the daemon rejects a mutation", async () => {
    const client = daemonClient();
    client.create.mockRejectedValueOnce(new Error("Spark daemon is offline"));

    await expect(
      createManagedSessionForHub(
        {
          scope: { kind: "workspace", workspaceId: "ws_a" },
          supervisorSessionId: "sess_admin",
          name: "Alpha",
          roleBinding: { kind: "none" },
        },
        client,
      ),
    ).rejects.toThrow("Spark daemon is offline");
  });
});

function daemonClient(
  options: {
    archiveResult?: SparkSessionProjection;
    bindResult?: SparkSessionProjection;
  } = {},
) {
  return {
    controlAvailable: vi.fn(() => true),
    list: vi.fn(async () => [session]),
    get: vi.fn(async () => session),
    snapshot: vi.fn(async () => snapshotWindow),
    sideThreadSnapshot: vi.fn(),
    create: vi.fn(async () => session),
    bind: vi.fn(async () => options.bindResult ?? session),
    unbind: vi.fn(async () => options.bindResult ?? session),
    archive: vi.fn(async () => options.archiveResult ?? session),
    close: vi.fn(async () => ({ ...session, lifecycle: "closed" as const })),
  } satisfies HubManagedSessionsClient;
}
