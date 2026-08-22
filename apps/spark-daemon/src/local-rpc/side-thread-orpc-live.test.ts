import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sparkSideThreadSnapshotSchema } from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  createSparkDaemonOrpcClient,
  invokeSparkDaemonOrpcLiveMethod,
  isSparkDaemonSideThreadOrpcError,
} from "@zendev-lab/spark-daemon-client";
import { describe, expect, it, vi } from "vitest";

import { createDaemonSessionRegistry } from "../session-registry.ts";
import { SessionSupervisor } from "../session-supervisor.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { registerWorkspace } from "../store/workspaces.ts";
import { startLocalRpcServer } from "./transport.ts";

describe("Side Thread local-rpc oRPC integration", () => {
  it("round-trips one durable child and does not replay a rejected mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-side-thread-orpc-live-"));
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
    const sparkHome = join(root, ".spark");
    const db = openSparkDaemonDatabase(paths);
    const workspace = registerWorkspace(db, { localPath: root });
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "side-thread-orpc-test",
      daemonCwd: root,
    });
    const ensureSideThread = vi.spyOn(sessionRegistry, "ensureSideThread");
    const resetSideThread = vi.spyOn(sessionRegistry, "resetSideThread");
    const sessionSupervisor = new SessionSupervisor({
      registry: sessionRegistry,
      invocations: new SparkInvocationStore(db),
    });
    const server = await startLocalRpcServer({
      paths,
      sparkHome,
      db,
      sessionRegistry,
      sessionSupervisor,
    });

    try {
      const handle = await createSparkDaemonOrpcClient({ paths });
      try {
        const resolvedWorkspace = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "workspace.ensure-local",
          { localPath: root },
        );
        expect(resolvedWorkspace.id).toBe(workspace.id);
        const administrator = await sessionRegistry.ensureWorkspaceAdministrator(
          resolvedWorkspace.id,
        );
        await invokeSparkDaemonOrpcLiveMethod(handle.client, "session.create", {
          sessionId: "parent-session",
          scope: { kind: "workspace", workspaceId: resolvedWorkspace.id },
          supervisorSessionId: administrator.sessionId,
          placement: "child",
          roleBinding: { kind: "none" },
          cwd: root,
        });

        const ensured = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.ensure", {
            parentSessionId: "parent-session",
            mode: "contextual",
          }),
        );
        expect(ensured).toMatchObject({
          parentSessionId: "parent-session",
          generation: 1,
          mode: "contextual",
          status: "idle",
          exchanges: [],
        });

        const repeated = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.ensure", {
            parentSessionId: "parent-session",
            mode: "tangent",
          }),
        );
        expect(repeated.sessionId).toBe(ensured.sessionId);
        expect(repeated.mode).toBe("contextual");
        expect(ensureSideThread).toHaveBeenCalledTimes(1);

        const snapshot = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.snapshot", {
            parentSessionId: "parent-session",
          }),
        );
        expect(snapshot).toEqual(repeated);
        expect(await sessionRegistry.list()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ sessionId: "parent-session" }),
            expect.objectContaining({
              lineage: { kind: "root" },
              roleBinding: {
                kind: "explicit",
                roleRef: "role:builtin-administrator",
              },
            }),
          ]),
        );

        const generationConflict = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "side-thread.reset",
          {
            parentSessionId: "parent-session",
            expectedGeneration: 99,
            mode: "tangent",
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isSparkDaemonSideThreadOrpcError(generationConflict)).toBe(true);
        if (isSparkDaemonSideThreadOrpcError(generationConflict)) {
          expect(generationConflict.code).toBe("side_thread_generation_conflict");
        }

        resetSideThread.mockRejectedValueOnce(
          Object.assign(new Error("injected registry write failure"), {
            code: "legacy_internal_detail",
          }),
        );
        const unknownLegacyFailure = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "side-thread.reset",
          {
            parentSessionId: "parent-session",
            expectedGeneration: 1,
            mode: "tangent",
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isSparkDaemonSideThreadOrpcError(unknownLegacyFailure)).toBe(false);
        expect(unknownLegacyFailure).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(String(unknownLegacyFailure)).not.toContain("legacy_internal_detail");
        expect(String(unknownLegacyFailure)).not.toContain("injected registry write failure");

        expect(resetSideThread).toHaveBeenCalledTimes(1);
        await expect(sessionRegistry.get(ensured.sessionId)).resolves.toMatchObject({
          lifecycle: "closed",
          placement: "archived",
          closeReceipts: [expect.objectContaining({ incarnation: 1 })],
        });

        const archivedSnapshot = await invokeSparkDaemonOrpcLiveMethod(
          handle.client,
          "side-thread.snapshot",
          {
            parentSessionId: "parent-session",
          },
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(isSparkDaemonSideThreadOrpcError(archivedSnapshot)).toBe(true);
        if (isSparkDaemonSideThreadOrpcError(archivedSnapshot)) {
          expect(archivedSnapshot.code).toBe("side_thread_not_found");
        }

        const recovered = sparkSideThreadSnapshotSchema.parse(
          await invokeSparkDaemonOrpcLiveMethod(handle.client, "side-thread.reset", {
            parentSessionId: "parent-session",
            expectedGeneration: 1,
            mode: "tangent",
          }),
        );
        expect(recovered).toMatchObject({ generation: 2, mode: "tangent", status: "idle" });
        expect(resetSideThread).toHaveBeenCalledTimes(2);
      } finally {
        handle.close();
      }
    } finally {
      await server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
