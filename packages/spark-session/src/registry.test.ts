import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  sparkSessionLifetimeForLineage,
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
      lineage: { kind: "root", workspaceId: "ws_demo" },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      lifecycle: "open",
      placement: "active",
      retention: "audit",
    });
    expect(sparkSessionLifetimeForLineage(first.lineage)).toBe("persistent");
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      name: "Implementation lane",
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      cwd: "/repo/packages/demo",
    });
    expect(child).toMatchObject({
      name: "Implementation lane",
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      cwd: "/repo/packages/demo",
    });
    expect(sparkSessionLifetimeForLineage(child.lineage)).toBe("scoped");
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      cwd: "/repo/.agents/worktrees/change",
      cwdArtifactRef: artifactRef,
    });
    const attachedWorktree = await registry.create({
      sessionId: "sess_attached_worktree",
      scope: admin.scope,
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
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
        lineage: { kind: "child", parentSessionId: child.sessionId, origin: { kind: "session" } },
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
        lineage: {
          kind: "child",
          parentSessionId: otherAdmin.sessionId,
          origin: { kind: "session" },
        },
      }),
    ).rejects.toMatchObject({ code: "session_owner_scope_mismatch" });
    await expect(
      registry.create({
        scope: admin.scope,
        lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      sessionPath: "/workspace/.spark/sessions/sess_parent.jsonl",
      transcriptRef: "/workspace/.spark/sessions/sess_parent.jsonl",
    });
    const child = await registry.create({
      sessionId: "sess_descendant",
      scope: admin.scope,
      lineage: { kind: "child", parentSessionId: parent.sessionId, origin: { kind: "session" } },
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      name: "Channel",
    });
    const bound = await registry.bind({
      sessionId: session.sessionId,
      externalKey: "feishu:chat:oc_demo",
    });
    expect(bound.lineage).toEqual(session.lineage);
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
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      visibility: "internal",
      retention: "retain",
      purpose: "fleet_worker",
      fleetWorker,
    });

    expect(session).toMatchObject({
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      fleetWorker,
    });
    expect(sparkSessionLifetimeForLineage(session.lineage)).toBe("scoped");
    expect(session).not.toHaveProperty("relation");
    expect(session).not.toHaveProperty("roleRef");
  });
});

describe("SparkSessionRegistry v7 migration", () => {
  it("backs up, journals, validates, and idempotently migrates only v6", async () => {
    const registry = await tempRegistry();
    const timestamp = "2026-08-01T00:00:00.000Z";
    await writeFile(
      registry.filePath,
      `${JSON.stringify(
        {
          version: 6,
          revision: 9,
          sessions: [
            {
              sessionId: "sess_admin_v6",
              scope: { kind: "workspace", workspaceId: "ws_v6" },
              name: "Administrator",
              lifecycle: "open",
              placement: "active",
              roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
              owner: { kind: "workspace", workspaceId: "ws_v6" },
              incarnation: 1,
              stateBinding: { kind: "session", ref: "sess_admin_v6" },
              visibility: "public",
              retention: "audit",
              purpose: "workspace_administrator",
              bindings: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            {
              sessionId: "sess_driver_v6",
              scope: { kind: "workspace", workspaceId: "ws_v6" },
              lifecycle: "closed",
              placement: "archived",
              roleBinding: { kind: "inherit" },
              owner: {
                kind: "driver",
                driverId: "loop:v6",
                generation: 3,
                supervisorSessionId: "sess_admin_v6",
              },
              incarnation: 1,
              stateBinding: { kind: "driver", ref: "loop:v6" },
              visibility: "internal",
              retention: "discard_on_close",
              purpose: "driver_generation",
              bindings: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(registry.get("sess_admin_v6")).resolves.toMatchObject({
      lineage: { kind: "root", workspaceId: "ws_v6" },
    });
    await expect(registry.get("sess_driver_v6")).resolves.toMatchObject({
      lineage: {
        kind: "child",
        parentSessionId: "sess_admin_v6",
        origin: { kind: "driver", driverId: "loop:v6", generation: 3 },
      },
    });

    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      version: number;
      revision: number;
      sessions: unknown[];
    };
    expect(persisted).toMatchObject({ version: 7, revision: 9 });
    expect(JSON.stringify(persisted.sessions)).not.toMatch(/"owner"|"stateBinding"/u);
    const migrationDirs = (await readdir(registry.rootDir)).filter((entry) =>
      entry.startsWith("migration-v6-to-v7-"),
    );
    expect(migrationDirs).toHaveLength(1);
    expect(await readdir(join(registry.rootDir, migrationDirs[0]!))).toEqual(
      expect.arrayContaining(["journal.json", "registry.json.backup"]),
    );

    const replay = await registry.get("sess_driver_v6");
    expect(replay?.lineage).toMatchObject({ kind: "child", parentSessionId: "sess_admin_v6" });
    expect(
      (await readdir(registry.rootDir)).filter((entry) => entry.startsWith("migration-")),
    ).toHaveLength(1);
  });

  it("fails closed for pre-v6 registries with the explicit upgrade path", async () => {
    const registry = await tempRegistry();
    await writeFile(registry.filePath, `${JSON.stringify({ version: 5, sessions: [] })}\n`, "utf8");

    await expect(registry.list()).rejects.toMatchObject({
      code: "invalid_registry",
      message: expect.stringMatching(/only v6 can migrate to v7.*Spark 0\.4\.0/u),
    });
    await expect(readdir(registry.rootDir)).resolves.not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^migration-/u)]),
    );
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
      lineage: { kind: "child", parentSessionId: first.sessionId, origin: { kind: "session" } },
      cwd: "/repo",
    });

    await expect(registry.get(child.sessionId)).resolves.toMatchObject({
      sessionId: child.sessionId,
      lineage: { kind: "child", parentSessionId: first.sessionId, origin: { kind: "session" } },
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
