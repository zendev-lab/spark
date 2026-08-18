import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  sparkSessionLifetimeForOwner,
  type SparkSessionCloseReceipt,
} from "@zendev-lab/spark-protocol/session-assignment";
import { SparkSessionRegistry, SparkSessionRegistryError } from "./registry.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRegistry(): Promise<SparkSessionRegistry> {
  const root = await mkdtemp(join(tmpdir(), "spark-session-registry-"));
  roots.push(root);
  return new SparkSessionRegistry({ rootDir: root });
}

async function administrator(
  registry: SparkSessionRegistry,
  workspaceId = "ws_demo",
  cwd = "/repo",
) {
  return await registry.ensureWorkspaceAdministrator({ workspaceId, cwd });
}

describe("SparkSessionRegistry v6 ownership", () => {
  it("keeps registry error codes protocol-registered", () => {
    const registered = new SparkSessionRegistryError("session_not_found", "missing");
    type RegistryErrorCode = ConstructorParameters<typeof SparkSessionRegistryError>[0];

    expect(registered.code).toBe("session_not_found");
    expectTypeOf<"session_not_found">().toMatchTypeOf<RegistryErrorCode>();
    expectTypeOf<"unregistered_session_error">().not.toMatchTypeOf<RegistryErrorCode>();
  });

  it("ensures one permanent Administrator and rejects every lifecycle mutation", async () => {
    const registry = await tempRegistry();
    const first = await administrator(registry);
    const replay = await administrator(registry);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      name: "Administrator",
      scope: { kind: "workspace", workspaceId: "ws_demo" },
      owner: { kind: "workspace", workspaceId: "ws_demo" },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      lifecycle: "open",
      placement: "active",
      retention: "audit",
    });
    expect(sparkSessionLifetimeForOwner(first.owner)).toBe("persistent");
    await expect(registry.archive(first.sessionId)).rejects.toMatchObject({
      code: "workspace_administrator_session_mutation_forbidden",
    });
    await expect(registry.restore(first.sessionId)).rejects.toMatchObject({
      code: "workspace_administrator_session_mutation_forbidden",
    });
    await expect(registry.close({ sessionId: first.sessionId })).rejects.toMatchObject({
      code: "workspace_administrator_session_mutation_forbidden",
    });
  });

  it("derives scoped ownership and keeps Role binding independent from name", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const child = await registry.create({
      sessionId: "sess_child",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      name: "Implementation lane",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      cwd: "/repo/packages/demo",
    });
    expect(child).toMatchObject({
      name: "Implementation lane",
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      cwd: "/repo/packages/demo",
    });
    expect(sparkSessionLifetimeForOwner(child.owner)).toBe("scoped");
    expect(child).not.toHaveProperty("role");
    expect(child).not.toHaveProperty("status");
    expect(child).not.toHaveProperty("relation");
    expect(child).not.toHaveProperty("workspaceId");
  });

  it("allows an administrator child to establish a GitChange boundary", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry, "ws_a", "/repo");
    const artifactRef = "artifact:git-change";
    const child = await registry.create({
      sessionId: "sess_git_change",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      cwd: "/repo/.agents/worktrees/change",
      cwdArtifactRef: artifactRef,
    });
    const attachedWorktree = await registry.create({
      sessionId: "sess_attached_worktree",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      cwd: "/Users/agent/.agents/worktrees/change",
      cwdArtifactRef: "artifact:attached-worktree",
    });

    await expect(registry.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: child.sessionId,
          cwdArtifactRef: artifactRef,
        }),
        expect.objectContaining({
          sessionId: attachedWorktree.sessionId,
          cwdArtifactRef: "artifact:attached-worktree",
        }),
      ]),
    );
    await expect(
      registry.create({
        scope: admin.scope,
        owner: { kind: "session", supervisorSessionId: child.sessionId },
        cwd: "/repo/.agents/worktrees/change/nested",
        cwdArtifactRef: "artifact:other-change",
      }),
    ).rejects.toMatchObject({ code: "session_owner_scope_mismatch" });
  });

  it("rejects owner scope and cwd widening", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry, "ws_a", "/repo");
    const otherAdmin = await administrator(registry, "ws_b", "/other");
    await expect(
      registry.create({
        scope: admin.scope,
        owner: { kind: "session", supervisorSessionId: otherAdmin.sessionId },
      }),
    ).rejects.toMatchObject({ code: "session_owner_scope_mismatch" });
    await expect(
      registry.create({
        scope: admin.scope,
        owner: { kind: "session", supervisorSessionId: admin.sessionId },
        cwd: "/outside",
      }),
    ).rejects.toMatchObject({ code: "session_owner_scope_mismatch" });
  });

  it("archives placement, closes scoped descendants, and never revives them on restore", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const parent = await registry.create({
      sessionId: "sess_parent",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      sessionPath: "/workspace/.spark/sessions/sess_parent.jsonl",
      transcriptRef: "/workspace/.spark/sessions/sess_parent.jsonl",
    });
    const child = await registry.create({
      sessionId: "sess_descendant",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: parent.sessionId },
    });

    const archived = await registry.archive(parent.sessionId);
    expect(archived.placement).toBe("archived");
    await expect(registry.get(child.sessionId)).resolves.toMatchObject({ lifecycle: "closing" });
    await registry.finalizeClose(child.sessionId);
    await registry.restore(parent.sessionId);
    await expect(registry.get(parent.sessionId)).resolves.toMatchObject({
      placement: "active",
      incarnation: 1,
      sessionPath: parent.sessionPath,
      transcriptRef: parent.transcriptRef,
    });
    await expect(registry.get(child.sessionId)).resolves.toMatchObject({ lifecycle: "closed" });
  });

  it("uses an idempotent closing then closed transition", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const session = await registry.create({
      sessionId: "sess_close",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
    });
    await expect(registry.close({ sessionId: session.sessionId })).resolves.toMatchObject({
      lifecycle: "closing",
    });
    await expect(registry.close({ sessionId: session.sessionId })).resolves.toMatchObject({
      lifecycle: "closing",
    });
    await expect(registry.finalizeClose(session.sessionId)).resolves.toMatchObject({
      lifecycle: "closed",
      bindings: [],
    });
    await expect(registry.finalizeClose(session.sessionId)).resolves.toMatchObject({
      lifecycle: "closed",
    });
    await expect(registry.recordTurnQueued(session.sessionId)).rejects.toMatchObject({
      code: "session_closed",
    });
  });

  it("idempotently clears transcript references from a legacy finalized Session", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const session = await registry.create({
      sessionId: "sess_legacy_closed_content",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      retention: "discard_on_close",
      sessionPath: "/tmp/sessions/legacy-closed.jsonl",
      transcriptRef: "/tmp/sessions/legacy-closed.jsonl",
    });
    await registry.markClosing({
      sessionId: session.sessionId,
      expectedLifecycle: "open",
    });
    const closed = await registry.finalizeClose(session.sessionId);

    const repaired = await registry.archiveOwned({
      sessionId: session.sessionId,
      discardTranscript: true,
    });
    const replay = await registry.archiveOwned({
      sessionId: session.sessionId,
      discardTranscript: true,
    });

    expect(repaired).toMatchObject({ lifecycle: "closed", placement: "archived" });
    expect(repaired).not.toHaveProperty("sessionPath");
    expect(repaired).not.toHaveProperty("transcriptRef");
    expect(repaired.archiveHistory).toEqual(closed.archiveHistory);
    expect(replay).toEqual(repaired);
  });

  it("fences transcript mutation to the admitted open and active incarnation", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const session = await registry.create({
      sessionId: "sess_transcript_fence",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
    });

    await registry.archive(session.sessionId);
    await expect(
      registry.bindTranscriptPath({
        sessionId: session.sessionId,
        sessionPath: "/tmp/sessions/stale-archived.jsonl",
        expectedIncarnation: session.incarnation,
        expectedLifecycle: "open",
      }),
    ).rejects.toMatchObject({ code: "session_transcript_cas_failed" });

    const restored = await registry.restore(session.sessionId);
    expect(restored).toMatchObject({
      lifecycle: "open",
      placement: "active",
      incarnation: session.incarnation,
    });
    await expect(
      registry.recordRun({
        sessionId: session.sessionId,
        sessionPath: "/tmp/sessions/stale-incarnation.jsonl",
        expectedIncarnation: session.incarnation + 1,
        expectedLifecycle: "open",
      }),
    ).rejects.toMatchObject({ code: "session_transcript_cas_failed" });
    await expect(
      registry.recordRun({
        sessionId: session.sessionId,
        sessionPath: "/tmp/sessions/current-incarnation.jsonl",
        expectedIncarnation: session.incarnation,
        expectedLifecycle: "open",
      }),
    ).resolves.toMatchObject({
      sessionPath: "/tmp/sessions/current-incarnation.jsonl",
      incarnation: session.incarnation,
    });
  });

  it("keeps channel bindings as routing aliases rather than owners", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const session = await registry.create({
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      name: "Channel",
    });
    const bound = await registry.bind({
      sessionId: session.sessionId,
      externalKey: "feishu:chat:oc_demo",
    });
    expect(bound.owner).toEqual(session.owner);
    expect(bound.bindings[0]).toMatchObject({ externalKey: "feishu:chat:oc_demo" });
    await expect(registry.archive(session.sessionId)).rejects.toMatchObject({
      code: "session_channel_bound",
    });
  });

  it("keeps Fleet lane metadata separate from scoped Session ownership", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const fleetWorker = {
      ownerSessionId: admin.sessionId,
      projectRef: "proj:fleet",
      roleRef: "role:builtin-executor",
      laneKey: "fleet:lane",
      primaryArtifactRef: "artifact:repo",
      writableArtifactRefs: ["artifact:repo"],
    };
    const session = await registry.create({
      sessionId: "sess_fleet_worker",
      scope: admin.scope,
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      visibility: "internal",
      retention: "retain",
      purpose: "fleet_worker",
      fleetWorker,
    });

    expect(session).toMatchObject({
      owner: { kind: "session", supervisorSessionId: admin.sessionId },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      fleetWorker,
    });
    expect(sparkSessionLifetimeForOwner(session.owner)).toBe("scoped");
    expect(session).not.toHaveProperty("relation");
    expect(session).not.toHaveProperty("roleRef");
  });
});

describe("SparkSessionRegistry v6 migration", () => {
  it("rejects derived and retired fields injected into canonical v6 storage", async () => {
    const registry = await tempRegistry();
    await administrator(registry);
    const stored = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    Object.assign(stored.sessions[0]!, {
      activity: "running",
      lifetime: "persistent",
      authority: "administrator",
    });
    await writeFile(registry.filePath, `${JSON.stringify(stored)}\n`, "utf8");

    const reloaded = new SparkSessionRegistry({ rootDir: registry.rootDir });
    await expect(reloaded.list()).rejects.toThrow();
  });

  it("backs up, journals, validates, and hard-maps legacy structured roles", async () => {
    const registry = await tempRegistry();
    await writeFile(
      registry.filePath,
      `${JSON.stringify({
        version: 4,
        sessions: [
          {
            sessionId: "sess_main",
            scope: { kind: "workspace", workspaceId: "ws_legacy" },
            role: "Workspace Coordinator",
            status: "ready",
            relation: { kind: "workspace_main", generation: 7 },
            bindings: [],
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
          {
            sessionId: "sess_worker",
            scope: { kind: "workspace", workspaceId: "ws_legacy" },
            role: "role:builtin-worker",
            title: "role:builtin-worker",
            status: "archived",
            bindings: [],
            createdAt: "2026-07-02T00:00:00.000Z",
            updatedAt: "2026-07-02T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    const migrated = await registry.get("sess_worker");
    expect(migrated).toMatchObject({
      placement: "archived",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      owner: { kind: "session", supervisorSessionId: "sess_main" },
    });
    expect(migrated).not.toHaveProperty("role");
    expect(await registry.get("sess_main")).toMatchObject({
      owner: { kind: "workspace", workspaceId: "ws_legacy" },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
    });

    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      version: number;
    };
    expect(persisted.version).toBe(6);
    const migrationDirs = (await readdir(registry.rootDir)).filter((entry) =>
      entry.startsWith("migration-v4-to-v6-"),
    );
    expect(migrationDirs).toHaveLength(1);
    const migrationFiles = await readdir(join(registry.rootDir, migrationDirs[0]!));
    expect(migrationFiles).toEqual(
      expect.arrayContaining(["journal.json", "registry.json.backup"]),
    );

    const replay = await registry.get("sess_worker");
    expect(replay).toEqual(migrated);
    expect(
      (await readdir(registry.rootDir)).filter((entry) => entry.startsWith("migration-")),
    ).toHaveLength(1);
  });

  it("preserves canonical v5 owners while enriching records for v6", async () => {
    const registry = await tempRegistry();
    await writeFile(
      registry.filePath,
      `${JSON.stringify({
        version: 5,
        sessions: [
          {
            sessionId: "sess_admin_v5",
            scope: { kind: "workspace", workspaceId: "ws_v5" },
            name: "Administrator",
            lifecycle: "open",
            placement: "active",
            roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
            owner: { kind: "workspace", workspaceId: "ws_v5" },
            bindings: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          {
            sessionId: "sess_driver_v5",
            scope: { kind: "workspace", workspaceId: "ws_v5" },
            lifecycle: "closed",
            placement: "archived",
            roleBinding: { kind: "explicit", roleRef: "role:builtin-worker" },
            owner: {
              kind: "driver_generation",
              driverId: "loop:v5",
              generation: 3,
              supervisorSessionId: "sess_admin_v5",
            },
            bindings: [],
            createdAt: "2026-08-02T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(registry.get("sess_admin_v5")).resolves.toMatchObject({
      owner: { kind: "workspace", workspaceId: "ws_v5" },
      retention: "audit",
    });
    await expect(registry.get("sess_driver_v5")).resolves.toMatchObject({
      lifecycle: "closed",
      placement: "archived",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      owner: { kind: "driver", driverId: "loop:v5", generation: 3 },
      retention: "discard_on_close",
    });
    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      version: number;
      sessions: unknown[];
    };
    expect(persisted.version).toBe(6);
    expect(persisted.sessions).toHaveLength(2);
    expect(JSON.stringify(persisted.sessions)).not.toMatch(/"authority"|"activity"|"lifetime"/u);
  });
});

describe("SparkSessionRegistry file cache", () => {
  it("reuses one on-disk parse across repeated reads", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    await chmod(registry.filePath, 0);

    try {
      await expect(registry.get(admin.sessionId)).resolves.toMatchObject({
        sessionId: admin.sessionId,
        name: "Administrator",
      });
      await expect(registry.list()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ sessionId: admin.sessionId })]),
      );
    } finally {
      await chmod(registry.filePath, 0o600);
    }
  });

  it("exposes the persisted revision after a save", async () => {
    const registry = await tempRegistry();
    const first = await administrator(registry);
    const child = await registry.create({
      sessionId: "sess_cached_child",
      scope: first.scope,
      owner: { kind: "session", supervisorSessionId: first.sessionId },
      cwd: "/repo",
    });

    await expect(registry.get(child.sessionId)).resolves.toMatchObject({
      sessionId: child.sessionId,
      owner: { kind: "session", supervisorSessionId: first.sessionId },
    });
    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      revision: number;
    };
    expect(persisted.revision).toBeGreaterThan(0);
  });

  it("reloads when another writer changes the registry file", async () => {
    const registry = await tempRegistry();
    const admin = await administrator(registry);
    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      version: number;
      revision: number;
      sessions: Array<Record<string, unknown>>;
    };
    persisted.sessions = persisted.sessions.map((session) =>
      session.sessionId === admin.sessionId
        ? { ...session, name: "Reloaded Administrator" }
        : session,
    );
    await writeFile(registry.filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    await expect(registry.get(admin.sessionId)).resolves.toMatchObject({
      sessionId: admin.sessionId,
      name: "Reloaded Administrator",
    });
  });
});
