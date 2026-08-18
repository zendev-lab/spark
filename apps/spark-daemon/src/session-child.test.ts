import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { SparkSessionStore } from "@zendev-lab/spark-host/session-store";
import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedChildSession } from "./session-child.ts";
import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import { createDaemonSessionRegistry, type DaemonSessionRegistry } from "./session-registry.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("managed child Sessions", () => {
  it("spawns an empty Role-bound child without creating work", async () => {
    const fixture = await createFixture();

    const child = await createManagedChildSession({
      db: fixture.db,
      registry: fixture.registry,
      sparkHome: fixture.sparkHome,
      supervisorSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-executor",
      seed: "fresh",
      name: "Implementation",
    });

    expect(child).toMatchObject({
      name: "Implementation",
      lifecycle: "open",
      placement: "active",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      owner: { kind: "session", supervisorSessionId: fixture.administrator.sessionId },
      purpose: "interactive",
      retention: "retain",
      visibility: "public",
    });
    expect(child.sessionPath).toBeTruthy();
    const record = await fixture.store.load(child.sessionPath!);
    expect(record.header.id).toBe(child.sessionId);
    expect(record.header.parentSession).toBeUndefined();
    expect(record.entries).toEqual([]);
    expect(fixture.invocationCount()).toBe(0);
  });

  it("forks only the stable assistant prefix into an independent transcript", async () => {
    const fixture = await createFixture();
    const parent = await seedParentTranscript(fixture);

    const child = await createManagedChildSession({
      db: fixture.db,
      registry: fixture.registry,
      sparkHome: fixture.sparkHome,
      supervisorSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-explorer",
      seed: "fork",
    });

    const fork = await fixture.store.load(child.sessionPath!);
    expect(fork.header.parentSession).toBe(parent.path);
    expect(fork.entries.map((entry) => entry.id)).toEqual(
      parent.entries.slice(0, 2).map((entry) => entry.id),
    );
    expect(
      fork.entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role),
    ).toEqual(["user", "assistant"]);

    fixture.store.appendMessage(fork, { role: "user", content: "child-only" });
    await fixture.store.save(fork);
    expect((await fixture.store.load(parent.path)).entries).toHaveLength(parent.entries.length);
    expect((await fixture.store.load(fork.path)).entries).toHaveLength(3);
  });

  it("creates an empty fork when the parent has no completed assistant response", async () => {
    const fixture = await createFixture();
    const parent = fixture.store.createCanonicalSession({ id: fixture.administrator.sessionId });
    fixture.store.appendMessage(parent, { role: "user", content: "unfinished" });
    fixture.store.appendMessage(parent, {
      role: "assistant",
      content: "calling a tool",
      stopReason: "tool_use",
    });
    await fixture.store.save(parent);
    await fixture.registry.bindTranscriptPath({
      sessionId: fixture.administrator.sessionId,
      sessionPath: parent.path,
    });

    const child = await createManagedChildSession({
      db: fixture.db,
      registry: fixture.registry,
      sparkHome: fixture.sparkHome,
      supervisorSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-reviewer",
      seed: "fork",
    });

    expect((await fixture.store.load(child.sessionPath!)).entries).toEqual([]);
  });

  it("fails a changing parent checkpoint without registering a torn fork", async () => {
    const fixture = await createFixture();
    const parent = await seedParentTranscript(fixture);
    const originalLoad = fixture.store.load.bind(fixture.store);
    let parentLoads = 0;
    vi.spyOn(SparkSessionStore.prototype, "load").mockImplementation(async (path) => {
      const record = await originalLoad(path);
      if (path === parent.path) {
        parentLoads += 1;
        if (parentLoads >= 2) {
          fixture.store.appendCustomEntry(parent, "test.concurrent-change", { parentLoads });
          await fixture.store.save(parent);
        }
      }
      return record;
    });

    const before = await fixture.registry.list({ includeArchived: true });
    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: fixture.registry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: fixture.administrator.sessionId,
        roleRef: "role:builtin-explorer",
        seed: "fork",
      }),
    ).rejects.toMatchObject({ code: "session_transcript_changed" });
    expect(await fixture.registry.list({ includeArchived: true })).toHaveLength(before.length);
  });

  it("validates the Role before writing and removes a transcript after registry rejection", async () => {
    const fixture = await createFixture();
    const before = await fixture.store.list();

    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: fixture.registry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: fixture.administrator.sessionId,
        roleRef: "role:project-missing",
        seed: "fresh",
      }),
    ).rejects.toMatchObject({ code: "invalid_session_role" });
    expect(await fixture.store.list()).toEqual(before);

    const rejectingRegistry = {
      ...fixture.registry,
      create: async () => {
        throw new SparkSessionRegistryError("session_archived", "parent changed");
      },
    } satisfies DaemonSessionRegistry;
    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: rejectingRegistry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: fixture.administrator.sessionId,
        roleRef: "role:builtin-executor",
        seed: "fresh",
      }),
    ).rejects.toMatchObject({ code: "session_archived" });
    expect(await fixture.store.list()).toEqual(before);
  });

  it("rejects archived and channel-bound supervisors before creating a child", async () => {
    const fixture = await createFixture();
    const parent = await fixture.registry.create({
      scope: { kind: "workspace", workspaceId: fixture.workspace.id },
      supervisorSessionId: fixture.administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
    });
    await fixture.registry.archive(parent.sessionId);

    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: fixture.registry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: parent.sessionId,
        roleRef: "role:builtin-executor",
        seed: "fresh",
      }),
    ).rejects.toMatchObject({ code: "session_archived" });

    const channel = await fixture.registry.create({
      scope: { kind: "workspace", workspaceId: fixture.workspace.id },
      supervisorSessionId: fixture.administrator.sessionId,
      placement: "child",
      roleBinding: { kind: "none" },
    });
    await fixture.registry.bind({
      sessionId: channel.sessionId,
      externalKey: "qqbot:c2c:test-user",
    });
    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: fixture.registry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: channel.sessionId,
        roleRef: "role:builtin-executor",
        seed: "fork",
      }),
    ).rejects.toMatchObject({ code: "session_channel_bound" });
  });

  it("rejects ephemeral invocation supervisors before creating a child", async () => {
    const fixture = await createFixture();
    const ephemeral = {
      ...fixture.administrator,
      owner: {
        kind: "invocation",
        invocationId: "inv-managed-child-test",
        supervisorSessionId: fixture.administrator.sessionId,
      },
      purpose: "role_call",
    } satisfies SparkSessionState;
    const ephemeralRegistry = {
      ...fixture.registry,
      get: async (sessionId: string) =>
        sessionId === ephemeral.sessionId ? ephemeral : await fixture.registry.get(sessionId),
    } satisfies DaemonSessionRegistry;
    const before = await fixture.store.list();

    await expect(
      createManagedChildSession({
        db: fixture.db,
        registry: ephemeralRegistry,
        sparkHome: fixture.sparkHome,
        supervisorSessionId: ephemeral.sessionId,
        roleRef: "role:builtin-executor",
        seed: "fresh",
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(await fixture.store.list()).toEqual(before);
  });
});

async function seedParentTranscript(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const parent = fixture.store.createCanonicalSession({ id: fixture.administrator.sessionId });
  fixture.store.appendMessage(parent, { role: "user", content: "stable question" });
  fixture.store.appendMessage(parent, {
    role: "assistant",
    content: "stable answer",
    stopReason: "stop",
  });
  fixture.store.appendMessage(parent, { role: "user", content: "unstable follow-up" });
  fixture.store.appendMessage(parent, {
    role: "assistant",
    content: "tool call",
    stopReason: "tooluse",
  });
  fixture.store.appendMessage(parent, { role: "toolResult", content: "unfinished result" });
  await fixture.store.save(parent);
  await fixture.registry.bindTranscriptPath({
    sessionId: fixture.administrator.sessionId,
    sessionPath: parent.path,
  });
  return parent;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-managed-child-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const cwd = await realpath(workspacePath);
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
  databases.push(db);
  const workspace = registerWorkspace(db, { localPath: cwd });
  const registry = createDaemonSessionRegistry(join(root, "registry"), {
    resolveWorkspaceCwd: (workspaceId) => (workspaceId === workspace.id ? cwd : undefined),
    resolveSessionCwd: async (input) => await resolveSessionCwdForWorkspaceId(db, input),
  });
  const administrator = await registry.ensureWorkspaceAdministrator(workspace.id);
  const sparkHome = paths.sessionRuntimeDir!;
  const store = new SparkSessionStore({ cwd, sparkHome });
  return {
    root,
    cwd,
    db,
    registry,
    workspace,
    administrator,
    sparkHome,
    store,
    invocationCount: () =>
      (db.prepare("SELECT COUNT(*) AS count FROM invocations").get() as { count: number }).count,
  };
}
