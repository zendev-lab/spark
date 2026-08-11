import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { loadSparkSessionWorkspaceState } from "@zendev-lab/spark-loop";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  sparkSessionSnapshotPageSchema,
  type SparkSessionSnapshotPage,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it, vi } from "vitest";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { channelReplyDeliveryForCompletion } from "./spark/session-run.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";
import { createDaemonWorkspaceSession } from "../../../test/support/session-fixtures.ts";

describe("daemon session control admission", () => {
  it("creates ordinary UI conversations as Administrator children of one workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-admin-root-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const workspace = registerWorkspace(db, {
      serverUrl: "https://hub.example",
      serverBindingId: "workspace-admin-root",
      workspaceName: "admin-root",
      localPath: root,
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      resolveWorkspaceCwd: () => root,
    });
    const supervisor = new SessionSupervisor({
      registry: sessionRegistry,
      invocations: new SparkInvocationStore(db),
    });
    try {
      const administrator = await supervisor.ensureWorkspaceAdministrator(workspace.id);
      const create = async (sessionId: string, title: string) =>
        await executeSparkDaemonSessionControl(
          {
            paths,
            db,
            sessionRegistry,
            sessionSupervisor: supervisor,
            actor: "spark-daemon-runtime-ws",
          },
          {
            kind: "session.create.request",
            scope: "workspace",
            workspaceId: workspace.id,
            payload: {
              sessionId,
              name: title,
              scope: { kind: "workspace", workspaceId: workspace.id },
              supervisorSessionId: administrator.sessionId,
              roleBinding: { kind: "none" },
            },
          },
        );
      const first = await create("ui-admin-one", "Release planning");
      await create("ui-admin-two", "Architecture review");
      const sessions = await sessionRegistry.list({ includeArchived: true });
      const workspaceRoot = sessions.find((session) => session.owner.kind === "workspace");

      expect(workspaceRoot).toBeTruthy();
      expect(sessions.filter((session) => session.owner.kind === "workspace")).toHaveLength(1);
      expect(first.result.session).toMatchObject({
        sessionId: "ui-admin-one",
        name: "Release planning",
        roleBinding: { kind: "none" },
        lifetime: "scoped",
        owner: { kind: "session", supervisorSessionId: administrator.sessionId },
        stateBinding: { kind: "session", ref: workspaceRoot?.sessionId },
        lifecycle: "open",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists typed Fleet mode for the owning workspace Session", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-mode-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const workspace = registerWorkspace(db, {
      serverUrl: "https://hub.example",
      serverBindingId: "workspace-mode",
      workspaceName: "mode",
      localPath: root,
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "mode-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-mode",
      workspaceId: workspace.id,
      cwd: root,
    });
    try {
      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            kind: "session.mode.set.request",
            scope: "any",
            sessionId: "session-mode",
            payload: { sessionId: "session-mode", mode: "fleet" },
          },
        ),
      ).resolves.toEqual({ result: { sessionId: "session-mode", mode: "fleet" } });
      await expect(
        loadSparkSessionWorkspaceState(root, { sessionId: "session-mode" }),
      ).resolves.toMatchObject({ version: 3, mode: "fleet" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects new daemon-global top-level sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-workspace-only-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "workspace-only-test",
      daemonCwd: root,
    });
    try {
      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            kind: "session.create.request",
            scope: "any",
            payload: {
              sessionId: "session-retired-daemon-scope",
              scope: { kind: "daemon" },
            },
          },
        ),
      ).rejects.toMatchObject({
        code: "invalid_scope",
        message: "New Sessions must belong to a workspace.",
      });
      await expect(sessionRegistry.get("session-retired-daemon-scope")).resolves.toBeUndefined();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides ephemeral Role Sessions from public Session APIs while preserving Invocation receipts", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-ephemeral-visibility-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"));
    const workspaceId = "workspace-ephemeral-visibility";
    const invocationId = "inv_EphemeralVisibility";
    const ephemeralSessionId = "session-ephemeral-visibility";
    try {
      const administrator = await sessionRegistry.ensureWorkspaceAdministrator(workspaceId);
      await sessionRegistry.createSupervised({
        sessionId: ephemeralSessionId,
        scope: { kind: "workspace", workspaceId },
        cwd: root,
        roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
        owner: {
          kind: "invocation",
          invocationId,
          supervisorSessionId: administrator.sessionId,
        },
        stateBinding: { kind: "session", ref: administrator.sessionId },
        visibility: "internal",
        retention: "discard_on_close",
        purpose: "role_call",
      });
      const invocation = new SparkInvocationStore(db).submit({
        invocationId,
        sessionId: ephemeralSessionId,
        prompt: "perform one ephemeral Role Invocation",
      });
      const options = {
        paths,
        db,
        sessionRegistry,
        actor: "spark-daemon-local-rpc" as const,
      };

      const listed = await executeSparkDaemonSessionControl(options, {
        kind: "session.list.request",
        scope: "any",
        payload: {},
      });
      expect(listed.result.sessions).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: ephemeralSessionId })]),
      );
      await expect(
        executeSparkDaemonSessionControl(options, {
          kind: "session.get.request",
          scope: "any",
          sessionId: ephemeralSessionId,
          payload: { sessionId: ephemeralSessionId },
        }),
      ).rejects.toMatchObject({ code: "session_not_found" });
      await expect(
        executeSparkDaemonSessionControl(options, {
          kind: "session.close.request",
          scope: "any",
          sessionId: ephemeralSessionId,
          payload: { sessionId: ephemeralSessionId },
        }),
      ).rejects.toMatchObject({ code: "session_not_found" });

      const status = await executeSparkDaemonSessionControl(options, {
        kind: "turn.status.request",
        scope: "any",
        payload: { invocationId: invocation.invocationId },
      });
      expect(status.result).toMatchObject({
        invocationId: invocation.invocationId,
        status: "queued",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes an originating QQ binding into the durable child invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-origin-binding-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "origin-binding-test",
      daemonCwd: root,
    });
    const workspace = registerWorkspace(db, {
      serverUrl: "https://hub.example",
      serverBindingId: "workspace-original",
      workspaceName: "origin",
      localPath: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-worker",
      workspaceId: workspace.id,
      cwd: root,
    });
    try {
      const originBinding = {
        workspaceId: "workspace-original",
        adapter: "qqbot" as const,
        adapterId: "qq-account-original",
        adapterAccountIdentity: "channel-account:qqbot:original",
        externalKey: "qqbot:c2c:user-original",
        recipient: "c2c:user-original",
      };
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-worker",
          payload: {
            sessionId: "session-worker",
            prompt: "complete the delegated work",
            idempotencyKey: "origin-binding-request",
            originBinding,
          },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      expect(invocation.task).toMatchObject({
        channelReply: {
          workspaceId: "workspace-original",
          adapter: "qqbot",
          adapterId: "qq-account-original",
          adapterAccountIdentity: "channel-account:qqbot:original",
          recipient: "c2c:user-original",
        },
        channelContext: { externalKey: "qqbot:c2c:user-original" },
      });
      expect(
        channelReplyDeliveryForCompletion(
          invocation.task as never,
          invocation.invocationId,
          "final",
          { assistantText: "delegated result" },
        ),
      ).toMatchObject({
        workspaceId: "workspace-original",
        adapterId: "qq-account-original",
        adapterAccountIdentity: "channel-account:qqbot:original",
        externalKey: "qqbot:c2c:user-original",
        target: { recipient: "c2c:user-original" },
        text: "delegated result",
      });

      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            kind: "turn.submit.request",
            scope: "any",
            sessionId: "session-worker",
            payload: {
              sessionId: "session-worker",
              prompt: "complete the delegated work",
              idempotencyKey: "origin-binding-request",
              originBinding: { ...originBinding, adapterId: "qq-account-drifted" },
            },
          },
        ),
      ).rejects.toThrow(/idempotency conflict/u);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps local-origin turn submission compatible without a channel binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-local-origin-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "local-origin-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-local",
      workspaceId: "workspace-local",
      cwd: root,
    });
    try {
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-local",
          payload: { sessionId: "session-local", prompt: "local work" },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      expect(invocation.task).not.toHaveProperty("channelReply");
      expect(invocation.task).not.toHaveProperty("channelContext");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists an explicit causal parent for a child turn and rejects replay ancestry drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-parent-invocation-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "parent-invocation-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-child",
      workspaceId: "workspace-parent",
      cwd: root,
    });
    const store = new SparkInvocationStore(db);
    const parent = store.submit({
      sessionId: "session-parent",
      prompt: "parent",
      now: "2026-08-03T00:00:00.000Z",
    });
    try {
      const request = {
        kind: "turn.submit.request" as const,
        scope: "any" as const,
        sessionId: "session-child",
        payload: {
          sessionId: "session-child",
          prompt: "child work",
          idempotencyKey: "child-parent-attribution",
          parentInvocationId: parent.invocationId,
        },
      };
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        request,
      );
      expect(store.require(submitted.invocationId!)).toMatchObject({
        parentInvocationId: parent.invocationId,
        sourceKind: "turn.parent",
      });

      const otherParent = store.submit({
        sessionId: "session-other-parent",
        prompt: "other parent",
        now: "2026-08-03T00:00:01.000Z",
      });
      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            ...request,
            payload: { ...request.payload, parentInvocationId: otherParent.invocationId },
          },
        ),
      ).rejects.toThrow(/idempotency conflict/u);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("converges concurrent lease claimants on one semantic turn despite dynamic model drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-admission-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "admission-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-race",
      workspaceId: "workspace-race",
      cwd: root,
    });

    const firstModel = deferred<{ providerName: string; modelId: string }>();
    let modelReadCount = 0;
    const effectiveModel = vi.fn(async () => {
      modelReadCount += 1;
      return modelReadCount === 1
        ? await firstModel.promise
        : { providerName: "provider-b", modelId: "model-b" };
    });
    const modelControl = {
      effectiveModel,
      prepareModel: vi.fn(async () => undefined),
      effectiveThinkingLevel: vi.fn(async () => undefined),
    } as unknown as SparkDaemonModelControl;
    const request = {
      kind: "turn.submit.request" as const,
      scope: "any" as const,
      sessionId: "session-race",
      idempotencyKey: "idem_10000000000000000000000000000000",
      payload: { sessionId: "session-race", prompt: "admit exactly once" },
    };
    const onInvocationQueued = vi.fn();
    const options = {
      paths,
      db,
      sessionRegistry,
      modelControl,
      onInvocationQueued,
      actor: "spark-daemon-runtime-ws" as const,
    };

    try {
      const slowClaimant = executeSparkDaemonSessionControl(options, request);
      await vi.waitFor(() => expect(effectiveModel).toHaveBeenCalledTimes(1));
      const winningClaimant = await executeSparkDaemonSessionControl(options, request);
      firstModel.resolve({ providerName: "provider-a", modelId: "model-a" });
      const reclaimedClaimant = await slowClaimant;

      expect(reclaimedClaimant).toEqual(winningClaimant);
      expect(
        new SparkInvocationStore(db).findByIdempotencyKey(request.idempotencyKey),
      ).toMatchObject({
        invocationId: winningClaimant.invocationId,
        task: { model: "provider-b/model-b" },
      });
      expect(await sessionRegistry.get(request.sessionId)).toMatchObject({
        lifecycle: "open",
      });
      expect(await sessionRegistry.get(request.sessionId)).not.toHaveProperty("activity");
      expect(onInvocationQueued).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects authoritative running and queued turns in session snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-pending-truth-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "pending-truth-test",
      daemonCwd: root,
    });
    const sessionId = "session-pending-truth";

    try {
      await createDaemonWorkspaceSession(sessionRegistry, {
        sessionId,
        workspaceId: "workspace-pending",
        cwd: root,
      });
      const store = new SparkInvocationStore(db);
      const running = store.submit({
        sessionId,
        prompt: "currently running",
        task: { type: "session.run", sessionId, prompt: "currently running" },
        now: "2026-07-17T07:46:14.348Z",
      });
      await sessionRegistry.recordTurnQueued(sessionId);
      const queuedOnlySession = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.get.request",
          scope: "any",
          sessionId,
          payload: { sessionId },
        },
      );
      expect(queuedOnlySession.result.session).toMatchObject({ activity: "queued" });
      const queuedOnlyResponse = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      const queuedOnlyPage = sparkSessionSnapshotPageSchema.parse(queuedOnlyResponse.result);
      expect(queuedOnlyPage.snapshot.status).toBe("queued");
      expect(queuedOnlyPage.snapshot.pendingTurns).toMatchObject([
        { invocationId: running.invocationId, status: "queued" },
      ]);

      store.claimNext("worker-pending-truth", "2026-07-17T07:46:14.589Z");
      const queued = store.submit({
        sessionId,
        prompt: "actual follow-up",
        task: { type: "session.run", sessionId, prompt: "actual follow-up" },
        now: "2026-07-17T07:47:00.000Z",
      });

      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      const page = sparkSessionSnapshotPageSchema.parse(response.result);

      expect(page.snapshot.status).toBe("running");
      expect(page.snapshot.pendingTurns).toEqual([
        {
          invocationId: running.invocationId,
          prompt: "currently running",
          status: "running",
          createdAt: "2026-07-17T07:46:14.348Z",
          startedAt: "2026-07-17T07:46:14.589Z",
        },
        {
          invocationId: queued.invocationId,
          prompt: "actual follow-up",
          status: "queued",
          createdAt: "2026-07-17T07:47:00.000Z",
        },
      ]);
      expect(page.snapshot.messages.map((message) => message.metadata.invocationStatus)).toEqual([
        "running",
        "queued",
      ]);

      store.complete(running.invocationId, {
        status: "succeeded",
        now: "2026-07-17T07:48:00.000Z",
      });
      const queuedFollowerSession = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.get.request",
          scope: "any",
          sessionId,
          payload: { sessionId },
        },
      );
      expect(queuedFollowerSession.result.session).toMatchObject({ activity: "queued" });

      const queuedFollowerSnapshot = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId,
          payload: { sessionId, messageLimit: 32 },
        },
      );
      expect(
        sparkSessionSnapshotPageSchema.parse(queuedFollowerSnapshot.result).snapshot,
      ).toMatchObject({
        status: "queued",
        pendingTurns: [{ invocationId: queued.invocationId, status: "queued" }],
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls owned child Invocation activity into the parent Session without exposing its prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-owned-activity-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"));
    try {
      const administrator =
        await sessionRegistry.ensureWorkspaceAdministrator("workspace-activity");
      const parent = await sessionRegistry.create({
        sessionId: "activity-parent",
        scope: { kind: "workspace", workspaceId: "workspace-activity" },
        supervisorSessionId: administrator.sessionId,
        cwd: root,
      });
      const child = await sessionRegistry.createSupervised({
        sessionId: "activity-child",
        scope: parent.scope,
        owner: {
          kind: "driver",
          driverId: "loop:activity",
          generation: 1,
          supervisorSessionId: parent.sessionId,
        },
        stateBinding: { kind: "session", ref: parent.sessionId },
        visibility: "internal",
        retention: "discard_on_close",
        purpose: "driver",
      });
      const invocation = new SparkInvocationStore(db).submit({
        sessionId: child.sessionId,
        prompt: "private managed prompt",
        task: {
          type: "session.run",
          sessionId: child.sessionId,
          prompt: "private managed prompt",
        },
        sourceKind: "loop.tick",
      });

      const detail = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "session.get.request",
          scope: "any",
          sessionId: parent.sessionId,
          payload: { sessionId: parent.sessionId },
        },
      );
      expect(detail.result.session).toMatchObject({ activity: "queued" });

      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
        {
          kind: "session.snapshot.request",
          scope: "any",
          sessionId: parent.sessionId,
          payload: { sessionId: parent.sessionId },
        },
      );
      const snapshot = sparkSessionSnapshotPageSchema.parse(response.result).snapshot;
      expect(snapshot.pendingTurns).toMatchObject([
        {
          invocationId: invocation.invocationId,
          status: "queued",
          prompt: "Owned Session activity (loop.tick)",
        },
      ]);
      expect(JSON.stringify(snapshot.messages)).not.toContain("private managed prompt");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes the runtime workspace binding onto submitted turns for lifecycle delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-binding-route-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const workspaceId = "ws_binding_route";
    const bindingId = "rtwb_binding_route";
    const workspace = registerWorkspace(db, {
      serverUrl: "https://hub.example",
      serverBindingId: bindingId,
      serverWorkspaceId: workspaceId,
      localWorkspaceKey: "binding-route",
      displayName: "Binding route",
      localPath: root,
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "binding-route-test",
      daemonCwd: root,
    });
    const sessionId = "session-binding-route";

    try {
      await createDaemonWorkspaceSession(sessionRegistry, {
        sessionId,
        workspaceId,
      });
      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "turn.submit.request",
          scope: "workspace",
          workspaceId,
          workspaceBindingId: bindingId,
          sessionId,
          idempotencyKey: "idem_binding_route_00000000000000000000",
          payload: { sessionId, prompt: "keep lifecycle on this uplink" },
        },
      );
      const invocation = new SparkInvocationStore(db).require(response.invocationId!);

      expect(workspace.id).toBe(bindingId);
      expect(invocation).toMatchObject({
        workspaceBindingId: bindingId,
        task: { workspaceBindingId: bindingId, workspaceId },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects workspace aliases without merging same-path workspace identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-workspace-alias-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const localWorkspace = registerWorkspace(db, {
      localPath: root,
      localWorkspaceKey: "spark",
      displayName: "Spark",
    });
    const hubWorkspaceId = "ws_hub_workspace";
    const hubBindingId = "rtwb_hub_workspace";
    registerWorkspace(db, {
      serverUrl: "https://hub.example",
      serverBindingId: hubBindingId,
      serverWorkspaceId: hubWorkspaceId,
      localPath: root,
      localWorkspaceKey: "spore",
      displayName: "Spore",
    });
    const otherWorkspaceId = "ws_other_hub";
    registerWorkspace(db, {
      serverUrl: "https://other-hub.example",
      serverBindingId: "rtwb_other_hub",
      serverWorkspaceId: otherWorkspaceId,
      localPath: root,
      localWorkspaceKey: "spore",
      displayName: "Other Spore",
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "workspace-alias-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-local-tui",
      workspaceId: localWorkspace.id,
      cwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-hub",
      workspaceId: hubWorkspaceId,
      cwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-other-hub",
      workspaceId: otherWorkspaceId,
      cwd: root,
    });

    try {
      const response = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
        {
          kind: "session.list.request",
          scope: "workspace",
          workspaceId: hubWorkspaceId,
          workspaceBindingId: hubBindingId,
          payload: { scope: { kind: "workspace", workspaceId: hubWorkspaceId } },
        },
      );

      expect(response.result.sessions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-hub",
            scope: { kind: "workspace", workspaceId: hubWorkspaceId },
          }),
          expect.objectContaining({
            owner: { kind: "workspace", workspaceId: hubWorkspaceId },
            roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
          }),
        ]),
      );
      expect(response.result.sessions).toHaveLength(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("walks a byte-capped transcript with a strictly advancing exclusive cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-pages-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "pagination-test",
      daemonCwd: root,
    });
    const sessionId = "session-byte-capped-pages";
    const transcriptPath = join(root, "session.jsonl");
    const expectedIds = Array.from({ length: 18 }, (_, index) => `msg_${index}`);
    const entries = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-07-17T00:00:00.000Z",
        cwd: root,
      },
      ...expectedIds.map((id, index) => ({
        type: "message",
        id,
        parentId: index === 0 ? null : expectedIds[index - 1],
        timestamp: new Date(Date.UTC(2026, 6, 17, 0, 0, index + 1)).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${id}:${"large-message".repeat(500)}`,
        },
      })),
    ];
    writeFileSync(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    try {
      await createDaemonWorkspaceSession(sessionRegistry, {
        sessionId,
        workspaceId: "workspace-snapshot",
        cwd: root,
      });
      await sessionRegistry.recordRun({ sessionId, sessionPath: transcriptPath });
      const requestPage = async (beforeMessageId?: string): Promise<SparkSessionSnapshotPage> => {
        const response = await executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-runtime-ws" },
          {
            kind: "session.snapshot.request",
            scope: "any",
            sessionId,
            payload: {
              sessionId,
              messageLimit: 32,
              ...(beforeMessageId ? { beforeMessageId } : {}),
            },
          },
        );
        return sparkSessionSnapshotPageSchema.parse(response.result);
      };

      const chronologicalPages: string[][] = [];
      let cursor: string | undefined;
      let laterMessages = 0;
      let firstPageSize = 0;
      while (true) {
        const page = await requestPage(cursor);
        if (firstPageSize === 0) firstPageSize = page.history.loadedMessages;
        expect(page.history.totalMessages).toBe(expectedIds.length);
        expect(page.history.laterMessages).toBe(laterMessages);
        expect(page.snapshot.messages.length).toBeGreaterThan(0);
        chronologicalPages.unshift(page.snapshot.messages.map(({ id }) => id));
        laterMessages += page.history.loadedMessages;
        if (!page.history.hasEarlierMessages) break;
        expect(page.history.nextBeforeMessageId).toBe(page.snapshot.messages[0]?.id);
        expect(page.history.nextBeforeMessageId).not.toBe(cursor);
        cursor = page.history.nextBeforeMessageId;
      }

      expect(firstPageSize).toBeLessThan(expectedIds.length);
      expect(chronologicalPages.flat()).toEqual(expectedIds);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("propagates explicit --model from CLI through to frozen invocation task", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-model-propagation-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "model-propagation-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-model",
      workspaceId: "workspace-model",
      cwd: root,
    });

    const effectiveModel = vi.fn(async () => ({
      providerName: "default-provider",
      modelId: "default-model",
    }));
    const modelControl = {
      effectiveModel,
      prepareModel: vi.fn(async () => undefined),
      effectiveThinkingLevel: vi.fn(async () => undefined),
    } as unknown as SparkDaemonModelControl;

    try {
      // Submit with explicit model in payload
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, modelControl, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-model",
          payload: {
            sessionId: "session-model",
            prompt: "use explicit model",
            model: "anthropic/claude-sonnet-4-20250514",
          },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      // The explicit model must be frozen into the task, bypassing modelControl
      expect(invocation.task).toMatchObject({ model: "anthropic/claude-sonnet-4-20250514" });
      // modelControl.effectiveModel should NOT have been called
      expect(effectiveModel).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid model format in turn submission", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-model-validation-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({ app: "daemon", env: { HOME: root } });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "model-validation-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-invalid-model",
      workspaceId: "workspace-invalid-model",
      cwd: root,
    });

    try {
      // Model without provider/ prefix should be rejected by schema
      await expect(
        executeSparkDaemonSessionControl(
          { paths, db, sessionRegistry, actor: "spark-daemon-local-rpc" },
          {
            kind: "turn.submit.request",
            scope: "any",
            sessionId: "session-invalid-model",
            payload: {
              sessionId: "session-invalid-model",
              prompt: "bad model",
              model: "just-a-model-name",
            },
          },
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to modelControl when no explicit model is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-session-model-fallback-"));
    const db = openMemoryDatabase();
    migrateSparkDaemonDatabase(db);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const sessionRegistry = createDaemonSessionRegistry(join(root, ".spark"), {
      daemonId: "model-fallback-test",
      daemonCwd: root,
    });
    await createDaemonWorkspaceSession(sessionRegistry, {
      sessionId: "session-fallback",
      workspaceId: "workspace-fallback",
      cwd: root,
    });

    const effectiveModel = vi.fn(async () => ({ providerName: "openai", modelId: "gpt-4o" }));
    const modelControl = {
      effectiveModel,
      prepareModel: vi.fn(async () => undefined),
      effectiveThinkingLevel: vi.fn(async () => undefined),
    } as unknown as SparkDaemonModelControl;

    try {
      const submitted = await executeSparkDaemonSessionControl(
        { paths, db, sessionRegistry, modelControl, actor: "spark-daemon-local-rpc" },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: "session-fallback",
          payload: {
            sessionId: "session-fallback",
            prompt: "no explicit model",
          },
        },
      );
      const invocation = new SparkInvocationStore(db).require(submitted.invocationId!);
      expect(invocation.task).toMatchObject({ model: "openai/gpt-4o" });
      expect(effectiveModel).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
