import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import type { SparkDaemonSessionRunTask, SparkDaemonTaskExecutionContext } from "../core/types.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { listWorkspaceClients, registerWorkspace } from "../store/workspaces.ts";
import { acquireDaemonSessionLease } from "./session-lease.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon Session lease", () => {
  it("attaches a canonical daemon-fenced lease to the managed execution Session", async () => {
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
      const lease = await acquireDaemonSessionLease({
        db,
        task,
        context: executionContext(),
        sessionRegistry: {
          get: async (sessionId) =>
            sessionId === task.sessionId
              ? (managedTaskSession(task.sessionId, workspace.id) as never)
              : sessionId === "sess_workspace_administrator"
                ? (administratorSession(workspace.id) as never)
                : undefined,
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
          kind: "interactive",
          status: "connected",
          sessionId: "session:sess_task_managed",
          leaseFence: lease?.identity.leaseFence,
          metadata: expect.objectContaining({
            purpose: "managed_execution_session",
            ownerKind: "task_run",
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

  it("attaches a fenced lease to an ordinary scoped Session without using Administrator mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-scoped-session-lease-"));
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
      const administrator = administratorSession(workspace.id);
      const child = ordinarySession("sess_execute_child", workspace.id, administrator.sessionId);
      const lease = await acquireDaemonSessionLease({
        db,
        task: { ...sessionTask(workspace.id), sessionId: child.sessionId },
        context: executionContext(),
        sessionRegistry: {
          get: async (sessionId) =>
            sessionId === child.sessionId
              ? (child as never)
              : sessionId === administrator.sessionId
                ? (administrator as never)
                : undefined,
        },
      });

      expect(lease?.identity).toMatchObject({
        workspaceId: workspace.id,
        sessionId: "session:sess_execute_child",
        leaseFence: expect.stringMatching(/^wclf_/u),
      });
      expect(listWorkspaceClients(db, workspace.id)).toContainEqual(
        expect.objectContaining({
          id: lease?.identity.clientId,
          sessionId: "session:sess_execute_child",
          metadata: expect.objectContaining({ ownerKind: "session" }),
        }),
      );
      lease?.release();
    } finally {
      db.close();
    }
  });

  it("does not attach a TaskRun lease to a workspace-owned Administrator Session", async () => {
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
        acquireDaemonSessionLease({
          db,
          task: sessionTask(workspace.id),
          context: executionContext(),
          sessionRegistry: {
            get: async () =>
              ({
                sessionId: "sess_administrator",
                scope: { kind: "workspace", workspaceId: workspace.id },
                owner: { kind: "workspace", workspaceId: workspace.id },
              }) as never,
          },
        }),
      ).resolves.toBeUndefined();
      expect(listWorkspaceClients(db, workspace.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("validates the Administrator boundary without importing its actor identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-owned-session-lease-"));
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
      const lease = await acquireDaemonSessionLease({
        db,
        task: {
          ...sessionTask(workspace.id),
          sessionId: "driver_tick_owned",
        },
        context: executionContext(),
        sessionRegistry: {
          get: async (sessionId) =>
            sessionId === "driver_tick_owned"
              ? ({
                  sessionId: "driver_tick_owned",
                  scope: { kind: "workspace", workspaceId: workspace.id },
                  owner: {
                    kind: "driver_tick",
                    driverId: "repro:managed",
                    generation: 4,
                    tickInvocationId: "inv_managed",
                    supervisorSessionId: "sess_workspace_administrator",
                  },
                  lifetime: "scoped",
                  stateBinding: { kind: "session", ref: "sess_workspace_administrator" },
                } as never)
              : sessionId === "sess_workspace_administrator"
                ? (administratorSession(workspace.id) as never)
                : undefined,
        },
      });

      expect(lease?.identity).toMatchObject({
        workspaceId: workspace.id,
        sessionId: "session:driver_tick_owned",
        leaseFence: expect.stringMatching(/^wclf_/u),
      });
      expect(listWorkspaceClients(db, workspace.id)).toContainEqual(
        expect.objectContaining({
          id: lease?.identity.clientId,
          sessionId: "session:driver_tick_owned",
          metadata: expect.objectContaining({
            purpose: "managed_execution_session",
            ownerKind: "driver_tick",
            driverId: "repro:managed",
            generation: 4,
            invocationId: "inv_managed",
          }),
        }),
      );

      lease?.release();
    } finally {
      db.close();
    }
  });

  it("leases the task's explicit state binding identity for an owned driver tick", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-state-bound-lease-"));
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
      const lease = await acquireDaemonSessionLease({
        db,
        task: {
          ...sessionTask(workspace.id),
          sessionId: "driver_tick_owned",
          stateBindingSessionId: "sess_workspace_administrator",
        },
        context: executionContext(),
        sessionRegistry: {
          get: async (sessionId) =>
            sessionId === "driver_tick_owned"
              ? ({
                  sessionId: "driver_tick_owned",
                  scope: { kind: "workspace", workspaceId: workspace.id },
                  owner: {
                    kind: "driver_tick",
                    driverId: "repro:managed",
                    generation: 4,
                    tickInvocationId: "inv_managed",
                    supervisorSessionId: "sess_workspace_administrator",
                  },
                  lifetime: "scoped",
                  stateBinding: { kind: "session", ref: "sess_workspace_administrator" },
                } as never)
              : sessionId === "sess_workspace_administrator"
                ? (administratorSession(workspace.id) as never)
                : undefined,
        },
      });

      // The execution Session is the actor, but its tool context is bound to
      // the owner Session's durable state, so the lease must name that same
      // identity or claim/finish symmetry breaks (spark task claims are
      // recorded and queried under it).
      expect(lease?.identity).toMatchObject({
        workspaceId: workspace.id,
        sessionId: "session:sess_workspace_administrator",
        leaseFence: expect.stringMatching(/^wclf_/u),
      });
      lease?.release();
    } finally {
      db.close();
    }
  });

  it("fails closed when the task state binding diverges from the Session binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-divergent-state-binding-lease-"));
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
        acquireDaemonSessionLease({
          db,
          task: {
            ...sessionTask(workspace.id),
            sessionId: "driver_tick_owned",
            stateBindingSessionId: "sess_other_owner",
          },
          context: executionContext(),
          sessionRegistry: {
            get: async (sessionId) =>
              sessionId === "driver_tick_owned"
                ? ({
                    sessionId: "driver_tick_owned",
                    scope: { kind: "workspace", workspaceId: workspace.id },
                    owner: {
                      kind: "driver_tick",
                      driverId: "repro:managed",
                      generation: 4,
                      tickInvocationId: "inv_managed",
                      supervisorSessionId: "sess_workspace_administrator",
                    },
                    lifetime: "scoped",
                    stateBinding: { kind: "session", ref: "sess_workspace_administrator" },
                  } as never)
                : sessionId === "sess_workspace_administrator"
                  ? (administratorSession(workspace.id) as never)
                  : undefined,
          },
        }),
      ).rejects.toThrow("task state binding does not match its Session state binding");
      expect(listWorkspaceClients(db, workspace.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not invent a lease for an unowned daemon Session", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-unowned-session-lease-"));
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
      const child = ordinarySession("sess_unowned", workspace.id, "sess_missing_admin");
      await expect(
        acquireDaemonSessionLease({
          db,
          task: { ...unownedSessionTask(), sessionId: child.sessionId },
          context: executionContext(),
          sessionRegistry: {
            get: async (sessionId) =>
              sessionId === child.sessionId ? (child as never) : undefined,
          },
        }),
      ).rejects.toThrow("not under the open Workspace Administrator");
      expect(listWorkspaceClients(db, workspace.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("fails closed when a managed execution state binding is not the Administrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-invalid-state-owner-lease-"));
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
        acquireDaemonSessionLease({
          db,
          task: sessionTask(workspace.id),
          context: executionContext(),
          sessionRegistry: {
            get: async (sessionId) =>
              sessionId === "sess_task_managed"
                ? (managedTaskSession(sessionId, workspace.id) as never)
                : sessionId === "sess_workspace_administrator"
                  ? ({
                      ...administratorSession(workspace.id),
                      roleBinding: { kind: "none" },
                    } as never)
                  : undefined,
          },
        }),
      ).rejects.toThrow("not under the open Workspace Administrator");
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
        acquireDaemonSessionLease({
          db,
          task: sessionTask("workspace-other"),
          context: executionContext(),
          sessionRegistry: {
            get: async () =>
              ({
                scope: { kind: "workspace", workspaceId: workspace.id },
                owner: { kind: "task_run", taskRef: "task:managed" },
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

function unownedSessionTask(): SparkDaemonSessionRunTask {
  return {
    type: "session.run",
    sessionId: "sess_task_managed",
    prompt: "work",
  };
}

function executionContext(): SparkDaemonTaskExecutionContext {
  return {
    invocationId: "inv_managed",
    signal: new AbortController().signal,
  };
}

function managedTaskSession(sessionId: string, workspaceId: string) {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId },
    owner: {
      kind: "task_run",
      taskRef: "task:managed",
      runRef: "run:managed",
      supervisorSessionId: "sess_workspace_administrator",
    },
    stateBinding: { kind: "session", ref: "sess_workspace_administrator" },
  };
}

function ordinarySession(sessionId: string, workspaceId: string, supervisorSessionId: string) {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId },
    owner: { kind: "session", supervisorSessionId },
    lifecycle: "open",
    placement: "active",
    roleBinding: { kind: "none" },
    stateBinding: { kind: "session", ref: supervisorSessionId },
  };
}

function administratorSession(workspaceId: string) {
  return {
    sessionId: "sess_workspace_administrator",
    scope: { kind: "workspace", workspaceId },
    owner: { kind: "workspace", workspaceId },
    lifecycle: "open",
    placement: "active",
    roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
  };
}
