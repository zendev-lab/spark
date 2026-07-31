import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutionContext } from "../core/types.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { listWorkspaceClients, registerWorkspace } from "../store/workspaces.ts";
import { acquireManagedTaskSessionLease } from "./session-lease.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Task Session lease", () => {
  it("attaches a canonical daemon-fenced lease and releases it after the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-managed-task-session-lease-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    try {
      const workspace = registerWorkspace(db, { localPath: root, displayName: "Lease workspace" });
      const task = sessionTask(workspace.id);
      const lease = await acquireManagedTaskSessionLease({
        db,
        task,
        context: executionContext(),
        sessionRegistry: {
          get: async () =>
            ({
              sessionId: task.sessionId,
              workspaceId: workspace.id,
              relation: { kind: "task_execution", taskRef: "task:managed" },
            }) as never,
        },
      });

      expect(lease?.identity).toMatchObject({
        workspaceId: workspace.id,
        sessionId: "session:sess_task_managed",
        leaseFence: expect.stringMatching(/^wclf_/u),
      });
      expect(listWorkspaceClients(db, workspace.id)).toContainEqual(
        expect.objectContaining({
          id: lease?.identity.clientId,
          status: "connected",
          sessionId: "session:sess_task_managed",
          leaseFence: lease?.identity.leaseFence,
          metadata: expect.objectContaining({
            purpose: "managed_task_session",
            invocationId: "inv_managed",
            taskRef: "task:managed",
          }),
        }),
      );

      lease?.release();
      lease?.release();
      expect(listWorkspaceClients(db, workspace.id, "9999-01-01T00:00:00.000Z")).toContainEqual(
        expect.objectContaining({ id: lease?.identity.clientId, status: "disconnected" }),
      );
    } finally {
      db.close();
    }
  });

  it("does not grant a task-claim lease to ordinary daemon sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-ordinary-session-lease-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    try {
      const workspace = registerWorkspace(db, { localPath: root });
      await expect(
        acquireManagedTaskSessionLease({
          db,
          task: sessionTask(workspace.id),
          context: executionContext(),
          sessionRegistry: {
            get: async () => ({ workspaceId: workspace.id, relation: undefined }) as never,
          },
        }),
      ).resolves.toBeUndefined();
      expect(listWorkspaceClients(db, workspace.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails closed when the queued task and registry disagree on workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-mismatched-task-session-lease-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    try {
      const workspace = registerWorkspace(db, { localPath: root });
      await expect(
        acquireManagedTaskSessionLease({
          db,
          task: sessionTask("workspace-other"),
          context: executionContext(),
          sessionRegistry: {
            get: async () =>
              ({
                workspaceId: workspace.id,
                relation: { kind: "task_execution", taskRef: "task:managed" },
              }) as never,
          },
        }),
      ).rejects.toThrow("workspace mismatch");
      expect(listWorkspaceClients(db, workspace.id)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function sessionTask(workspaceId: string): SparkDaemonSessionRunTask {
  return {
    type: "session.run",
    sessionId: "sess_task_managed",
    prompt: "work",
    workspaceId,
  };
}

function executionContext(): SparkDaemonTaskExecutionContext {
  return {
    invocationId: "inv_managed",
    signal: new AbortController().signal,
  };
}
