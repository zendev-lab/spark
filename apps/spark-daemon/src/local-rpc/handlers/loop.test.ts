import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import type { SparkWorkbenchActionRequest } from "@zendev-lab/spark-protocol/a2ui";
import { describe, expect, it } from "vitest";

import type { LocalRpcDispatchContext } from "./context.ts";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "../../session-registry.ts";
import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkLoopStore } from "../../store/loops.ts";
import { migrateSparkDaemonDatabase } from "../../store/schema.ts";
import { WorkbenchArtifactBindingStore } from "../../store/workbench-artifact-bindings.ts";
import { registerWorkspace } from "../../store/workspaces.ts";
import { handleLoopRequest } from "./loop.ts";

describe("trusted Workbench Loop control", () => {
  it("binds owner-derived Loop invocations to the runtime workspace delivery route", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-loop-route-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, {
      localPath: workspaceCwd,
      serverWorkspaceId: "ws_11111111111111111111111111111111",
      serverBindingId: "rtwb_22222222222222222222222222222222",
    });
    const context = {
      db,
      options: {
        sessionRegistry: {
          get: async () => ({
            sessionId: "session-loop-owner",
            lifecycle: "open",
            placement: "active",
            cwd: workspaceCwd,
            scope: { kind: "workspace", workspaceId: workspace.id },
          }),
          commitOpenSessionMutation: async <T>(
            _sessionId: string,
            commit: (session: SparkSessionState) => T,
          ) =>
            commit({
              sessionId: "session-loop-owner",
              lifecycle: "open",
              placement: "active",
              cwd: workspaceCwd,
              scope: { kind: "workspace", workspaceId: workspace.id },
            } as unknown as SparkSessionState),
        },
      },
    } as unknown as LocalRpcDispatchContext;

    const started = await handleLoopRequest(context, {
      method: "loop.start",
      params: {
        loopId: "loop-route",
        ownerSessionId: "session-loop-owner",
        sessionLifetime: "driver",
        continuity: "session",
        cwd: workspaceCwd,
        prompt: "continue",
      },
    });
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));

    expect(started).toBeDefined();
    expect(loops.require("loop-route").route).toMatchObject({
      workspaceId: workspace.id,
      workspaceBindingId: "rtwb_22222222222222222222222222222222",
      cwd: workspaceCwd,
    });
    db.close();
  });

  it("closes the prior driver Session when loop.start transfers a Loop to another owner", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-loop-owner-transfer-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const closedSessionIds: string[] = [];
    const context = {
      db,
      options: {
        sessionRegistry: {
          get: async (sessionId: string) => ({
            sessionId,
            lifecycle: "open",
            placement: "active",
            cwd: workspaceCwd,
            scope: { kind: "side_thread", parentSessionId: "session-root" },
          }),
          commitOpenSessionMutation: async <T>(
            sessionId: string,
            commit: (session: SparkSessionState) => T,
          ) =>
            commit({
              sessionId,
              lifecycle: "open",
              placement: "active",
              cwd: workspaceCwd,
              scope: { kind: "side_thread", parentSessionId: "session-root" },
            } as unknown as SparkSessionState),
        },
        sessionSupervisor: {
          close: async ({ sessionId }: { sessionId: string }) => {
            closedSessionIds.push(sessionId);
          },
        },
      },
    } as unknown as LocalRpcDispatchContext;

    await handleLoopRequest(context, {
      method: "loop.start",
      params: {
        loopId: "loop-owner-transfer",
        ownerSessionId: "session-owner-before",
        sessionLifetime: "driver",
        continuity: "session",
        cwd: workspaceCwd,
        prompt: "first owner",
      },
    });
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const before = loops.require("loop-owner-transfer");

    await handleLoopRequest(context, {
      method: "loop.start",
      params: {
        loopId: before.loopId,
        ownerSessionId: "session-owner-after",
        sessionLifetime: "driver",
        continuity: "session",
        cwd: workspaceCwd,
        prompt: "second owner",
      },
    });
    const after = loops.require(before.loopId);

    expect(after.driverSessionId).not.toBe(before.driverSessionId);
    expect(after.ownerSessionId).toBe("session-owner-after");
    expect(closedSessionIds).toEqual([before.driverSessionId]);
    db.close();
  });

  it("rejects start, restart, and wake after the owner close fence wins", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-loop-close-first-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: workspaceCwd });
    const registry = createDaemonSessionRegistry(join(workspaceCwd, ".spark"), {
      resolveWorkspaceCwd: () => workspaceCwd,
    });
    const administrator = await registry.ensureWorkspaceAdministrator(workspace.id);
    const owners = await Promise.all(
      ["start", "restart", "wake"].map(
        async (operation) =>
          await registry.create({
            sessionId: `session-close-first-${operation}`,
            scope: { kind: "workspace", workspaceId: workspace.id },
            supervisorSessionId: administrator.sessionId,
          }),
      ),
    );
    const [startOwner, restartOwner, wakeOwner] = owners as [
      SparkSessionState,
      SparkSessionState,
      SparkSessionState,
    ];
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const restartBefore = loops.start({
      loopId: "loop-close-first-restart",
      ownerSessionId: restartOwner.sessionId,
      sessionLifetime: "driver",
      cwd: workspaceCwd,
      prompt: "continue",
    });
    const wakeBefore = loops.start({
      loopId: "loop-close-first-wake",
      ownerSessionId: wakeOwner.sessionId,
      sessionLifetime: "driver",
      cwd: workspaceCwd,
      prompt: "continue",
    });
    await Promise.all(
      owners.map(async (owner) => await registry.markClosing({ sessionId: owner.sessionId })),
    );
    const context = { db, options: { sessionRegistry: registry } } as LocalRpcDispatchContext;

    await expect(
      handleLoopRequest(context, {
        method: "loop.start",
        params: {
          loopId: "loop-close-first-start",
          ownerSessionId: startOwner.sessionId,
          sessionLifetime: "driver",
          continuity: "session",
          cwd: workspaceCwd,
          prompt: "continue",
        },
      }),
    ).rejects.toMatchObject({ code: "loop_owner_archived" });
    await expect(
      handleLoopRequest(context, {
        method: "loop.restart",
        params: { loopId: restartBefore.loopId },
      }),
    ).rejects.toMatchObject({ code: "loop_owner_archived" });
    await expect(
      handleLoopRequest(context, {
        method: "loop.wake",
        params: { loopId: wakeBefore.loopId },
      }),
    ).rejects.toMatchObject({ code: "loop_owner_archived" });

    expect(loops.get("loop-close-first-start")).toBeUndefined();
    expect(loops.require(restartBefore.loopId)).toEqual(restartBefore);
    expect(loops.require(wakeBefore.loopId)).toEqual(wakeBefore);
    db.close();
  });

  it("commits start, restart, and wake before a queued owner close", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-loop-admission-first-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: workspaceCwd });
    const registry = createDaemonSessionRegistry(join(workspaceCwd, ".spark"), {
      resolveWorkspaceCwd: () => workspaceCwd,
    });
    const administrator = await registry.ensureWorkspaceAdministrator(workspace.id);
    const owners = await Promise.all(
      ["start", "restart", "wake"].map(
        async (operation) =>
          await registry.create({
            sessionId: `session-admission-first-${operation}`,
            scope: { kind: "workspace", workspaceId: workspace.id },
            supervisorSessionId: administrator.sessionId,
          }),
      ),
    );
    const [startOwner, restartOwner, wakeOwner] = owners as [
      SparkSessionState,
      SparkSessionState,
      SparkSessionState,
    ];
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const restartBefore = loops.start({
      loopId: "loop-admission-first-restart",
      ownerSessionId: restartOwner.sessionId,
      sessionLifetime: "driver",
      cwd: workspaceCwd,
      prompt: "continue",
    });
    const wakeBefore = loops.start({
      loopId: "loop-admission-first-wake",
      ownerSessionId: wakeOwner.sessionId,
      sessionLifetime: "driver",
      cwd: workspaceCwd,
      prompt: "continue",
    });
    const closing = new Map<string, Promise<SparkSessionState>>();
    const sessionRegistry: DaemonSessionRegistry = {
      ...registry,
      commitOpenSessionMutation: async <T>(
        sessionId: string,
        commit: (session: SparkSessionState) => T,
      ) =>
        await registry.commitOpenSessionMutation(sessionId, (session) => {
          const result = commit(session);
          closing.set(sessionId, registry.markClosing({ sessionId }));
          return result;
        }),
    };
    const context = { db, options: { sessionRegistry } } as LocalRpcDispatchContext;

    await handleLoopRequest(context, {
      method: "loop.start",
      params: {
        loopId: "loop-admission-first-start",
        ownerSessionId: startOwner.sessionId,
        sessionLifetime: "driver",
        continuity: "session",
        cwd: workspaceCwd,
        prompt: "continue",
      },
    });
    await handleLoopRequest(context, {
      method: "loop.restart",
      params: { loopId: restartBefore.loopId },
    });
    await handleLoopRequest(context, {
      method: "loop.wake",
      params: { loopId: wakeBefore.loopId },
    });
    await Promise.all(closing.values());

    expect(loops.require("loop-admission-first-start")).toMatchObject({ generation: 1 });
    expect(loops.require(restartBefore.loopId)).toMatchObject({
      generation: restartBefore.generation + 1,
    });
    expect(loops.require(wakeBefore.loopId)).toMatchObject({
      generation: wakeBefore.generation + 1,
    });
    await expect(
      Promise.all(owners.map(async (owner) => await registry.get(owner.sessionId))),
    ).resolves.toEqual(owners.map(() => expect.objectContaining({ lifecycle: "closing" })));
    db.close();
  });

  it("applies an idempotent action and rejects stale, unbound, or tampered Artifacts", async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), "spark-workbench-action-"));
    const cwd = join(workspaceCwd, "packages", "demo");
    await mkdir(cwd, { recursive: true });
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const workspace = registerWorkspace(db, { localPath: workspaceCwd });
    const loops = new SparkLoopStore(db, new SparkInvocationStore(db));
    const started = loops.start({
      loopId: "loop-1",
      ownerSessionId: "session-1",
      cwd,
      workspaceId: workspace.id,
      prompt: "continue",
      binding: {
        goalId: "goal-1",
        workflowRunId: "workflow-run:repro-1",
        workflowSelector: "builtin:repro",
        reproId: "repro-1",
      },
    });
    const bindings = new WorkbenchArtifactBindingStore(db);
    const binding = bindings.ensure({
      ownerSessionId: started.ownerSessionId,
      goalId: started.binding.goalId!,
      workflowRunId: started.binding.workflowRunId!,
      loopId: started.loopId,
      reproId: started.binding.reproId!,
      generation: started.generation,
    });
    const artifact = await defaultArtifactStore(workspaceCwd).putManagedDocument({
      ref: binding.artifactRef,
      bindingId: binding.bindingId,
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[]}',
      expectedRevision: null,
    });
    bindings.recordProjection({
      bindingId: binding.bindingId,
      expectedRevision: 0,
      revision: 1,
      artifactHash: artifact.artifact.hash!,
      projectionDigest: "projection-1",
      generation: started.generation,
      stage: "contract",
      sealed: false,
    });
    const context = { db, options: {} } as unknown as LocalRpcDispatchContext;
    const pause = actionRequest({
      artifactRef: binding.artifactRef,
      revision: 1,
      loopId: started.loopId,
      generation: started.generation,
      actionId: "pause",
      idempotencyKey: "pause-1",
    });

    db.exec(`CREATE TRIGGER fail_workbench_receipt
      BEFORE INSERT ON workbench_action_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END`);
    await expect(
      handleLoopRequest(context, { method: "loop.control", params: pause }),
    ).rejects.toThrow("receipt write failed");
    expect(loops.require(started.loopId)).toMatchObject({ status: "scheduled", generation: 1 });
    db.exec("DROP TRIGGER fail_workbench_receipt");

    const applied = await handleLoopRequest(context, { method: "loop.control", params: pause });
    expect(applied).toMatchObject({ loop: { status: "paused", generation: 2 } });
    await expect(
      handleLoopRequest(context, { method: "loop.control", params: pause }),
    ).resolves.toEqual(applied);

    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          ...pause.action.context,
          idempotencyKey: "pause-stale",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_action_stale" });

    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          ...pause.action.context,
          artifactRef: "artifact:ordinary-agent-a2ui",
          idempotencyKey: "ordinary",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_binding_not_found" });

    const refreshedBinding = bindings.getByLoop(started.loopId)!;
    db.prepare(
      `UPDATE workbench_artifact_bindings SET generation = ?, updated_at = ? WHERE binding_id = ?`,
    ).run(2, "2026-08-04T01:00:00.000Z", refreshedBinding.bindingId);
    const artifactStore = defaultArtifactStore(workspaceCwd);
    await expect(
      artifactStore.put({
        ref: refreshedBinding.artifactRef,
        kind: "document",
        title: "Forged Workbench",
        body: {
          ...artifact.artifact.body,
          content: '{"messages":[{"forged":true}]}',
          revision: 2,
        },
      }),
    ).rejects.toThrow("managed Document writes require expected-revision authority");
    const metadataPath = artifactStore.pathFor(refreshedBinding.artifactRef);
    const tamperedMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      blobPath?: string;
    };
    if (!tamperedMetadata.blobPath) throw new Error("missing Workbench blobPath fixture");
    const blobPath = join(workspaceCwd, ".spark", "artifacts", tamperedMetadata.blobPath);
    const tamperedBody = JSON.parse(await readFile(blobPath, "utf8")) as Record<string, unknown>;
    tamperedBody.content = '{"messages":[{"forged":true}]}';
    await writeFile(blobPath, JSON.stringify(tamperedBody), "utf8");
    await expect(
      handleLoopRequest(context, {
        method: "loop.control",
        params: actionRequest({
          artifactRef: refreshedBinding.artifactRef,
          revision: 1,
          loopId: started.loopId,
          generation: 2,
          actionId: "resume",
          idempotencyKey: "tampered",
        }),
      }),
    ).rejects.toMatchObject({ code: "workbench_action_untrusted" });
    db.close();
  });
});

function actionRequest(
  context: SparkWorkbenchActionRequest["action"]["context"],
): SparkWorkbenchActionRequest {
  return {
    version: "v0.9.1",
    action: {
      name: "spark.loop.control",
      surfaceId: "spark-repro-repro-1",
      sourceComponentId: `control-${context.actionId}`,
      timestamp: "2026-08-04T00:00:00.000Z",
      context,
    },
  };
}
