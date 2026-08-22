import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkSessionStore } from "@zendev-lab/spark-session/transcript";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { ensureDaemonSessionTranscript } from "./session-transcript-control.ts";
import { unifyDaemonSessionTranscripts } from "./session-transcript-unification.ts";
import { createDaemonWorkspaceSession } from "../../../test/support/session-fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon session transcript ownership", () => {
  it("preallocates and binds one stable transcript before execution", async () => {
    const harness = await createHarness("preallocate");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_stable",
      workspaceId: "workspace",
    });

    const path = await ensureDaemonSessionTranscript({
      session,
      sparkHome: harness.transcriptSparkHome,
      registry: harness.registry,
    });

    expect(path).toBe(harness.store.canonicalSessionPath(session.sessionId));
    await expect(harness.store.load(path)).resolves.toMatchObject({
      header: { id: session.sessionId, cwd: harness.cwd },
      entries: [],
    });
    await expect(harness.registry.get(session.sessionId)).resolves.toMatchObject({
      sessionPath: path,
      lifecycle: "open",
    });
  });

  it("fails closed when an unbound session already has multiple fragments", async () => {
    const harness = await createHarness("fragment-conflict");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_fragmented",
      workspaceId: "workspace",
    });
    await harness.store.save(
      harness.store.createSession({
        id: session.sessionId,
        timestamp: "2026-07-20T00:00:00.000Z",
      }),
    );
    await harness.store.save(
      harness.store.createSession({
        id: session.sessionId,
        timestamp: "2026-07-21T00:00:00.000Z",
      }),
    );

    await expect(
      ensureDaemonSessionTranscript({
        session,
        sparkHome: harness.transcriptSparkHome,
        registry: harness.registry,
      }),
    ).rejects.toThrow("2 transcript fragments");
  });

  it("backs up and chains fragments before relocating the registry path", async () => {
    const harness = await createHarness("unify");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_unify",
      workspaceId: "workspace",
    });
    const first = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    harness.store.appendMessage(first, { role: "user", content: "first" });
    await harness.store.save(first);
    const second = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-21T00:00:00.000Z",
    });
    harness.store.appendMessage(second, { role: "assistant", content: "second" });
    await harness.store.save(second);
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: second.path,
    });

    const backupRoot = join(harness.root, "backups");
    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });

    const targetPath = harness.store.canonicalSessionPath(session.sessionId);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        sourcePaths: [first.path, second.path],
        targetPath,
        entryCount: 2,
        changed: true,
      }),
    ]);
    const unified = await harness.store.load(targetPath);
    expect(unified.entries).toHaveLength(2);
    expect(unified.entries[1]?.parentId).toBe(unified.entries[0]?.id);
    await expect(harness.registry.get(session.sessionId)).resolves.toMatchObject({
      sessionPath: targetPath,
    });
    await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(second.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(backupRoot, session.sessionId))).toEqual(
      expect.arrayContaining([
        first.path.split("/").at(-1),
        second.path.split("/").at(-1),
        "journal.json",
      ]),
    );

    const repeated = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot: join(harness.root, "unused-backup"),
      apply: true,
    });
    expect(repeated.sessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, changed: false }),
    ]);
  });

  it("backs up and hard-cuts a canonical Pi v3 transcript to native DSH v4", async () => {
    const harness = await createHarness("v3-hard-cut");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_v3_hard_cut",
      workspaceId: "workspace",
    });
    const legacy = harness.store.createCanonicalSession({
      id: session.sessionId,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    const legacySource = `${[
      {
        type: "session",
        version: 3,
        id: session.sessionId,
        timestamp: "2026-07-20T00:00:00.000Z",
        cwd: harness.cwd,
      },
      {
        type: "message",
        id: "legacy-user",
        parentId: null,
        timestamp: "2026-07-20T00:00:01.000Z",
        message: { role: "user", content: "legacy question" },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`;
    await mkdir(harness.store.sessionDir, { recursive: true });
    await writeFile(legacy.path, legacySource, "utf8");
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: legacy.path,
    });
    const backupRoot = join(harness.root, "v3-backups");

    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, changed: true, entryCount: 1 }),
    ]);
    await expect(harness.store.load(legacy.path)).resolves.toMatchObject({
      header: { version: 4 },
      entries: [expect.objectContaining({ id: "legacy-user" })],
    });
    const migrated = await readFile(legacy.path, "utf8");
    expect(migrated).toContain('"type":"user/message"');
    expect(
      await readFile(join(backupRoot, session.sessionId, legacy.path.split("/").at(-1)!), "utf8"),
    ).toBe(legacySource);
  });

  it("relocates a retained Channel transcript after its registry cwd moves to daemon storage", async () => {
    const harness = await createHarness("channel-relocation");
    const relocated = await createRelocatedChannelTranscript(harness, "sess_channel_relocated");
    const backupRoot = join(harness.root, "channel-relocation-backups");

    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });

    const targetStore = new SparkSessionStore({
      cwd: relocated.session.cwd!,
      sparkHome: harness.transcriptSparkHome,
    });
    const targetPath = targetStore.canonicalSessionPath(relocated.session.sessionId);
    expect(result.sessions).toEqual([
      expect.objectContaining({
        sessionId: relocated.session.sessionId,
        sourcePaths: [relocated.source.path],
        targetPath,
        entryCount: 1,
        changed: true,
      }),
    ]);
    await expect(targetStore.load(targetPath)).resolves.toMatchObject({
      header: { id: relocated.session.sessionId, cwd: relocated.session.cwd, version: 4 },
      entries: [expect.objectContaining({ id: relocated.source.entries[0]?.id })],
    });
    await expect(harness.registry.get(relocated.session.sessionId)).resolves.toMatchObject({
      sessionPath: targetPath,
    });
    await expect(access(relocated.source.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(
        join(backupRoot, relocated.session.sessionId, relocated.source.path.split("/").at(-1)!),
      ),
    ).resolves.toBeUndefined();
  });

  it("keeps rejecting an ordinary Session transcript from another workspace store", async () => {
    const harness = await createHarness("foreign-workspace");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_foreign_workspace",
      workspaceId: "workspace",
    });
    const foreignStore = new SparkSessionStore({
      cwd: join(harness.root, "foreign-workspace"),
      sparkHome: harness.transcriptSparkHome,
    });
    const foreign = foreignStore.createCanonicalSession({
      id: session.sessionId,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    foreignStore.appendMessage(foreign, { role: "user", content: "foreign" });
    await foreignStore.save(foreign);
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: foreign.path,
    });

    await expect(
      unifyDaemonSessionTranscripts({
        registry: harness.registry,
        transcriptSparkHome: harness.transcriptSparkHome,
        backupRoot: join(harness.root, "foreign-backups"),
        apply: true,
      }),
    ).rejects.toThrow("outside its daemon workspace store");
  });

  it("restores backups after a pre-CAS interruption and retries idempotently", async () => {
    const harness = await createHarness("recover-pre-cas");
    const session = await createDaemonWorkspaceSession(harness.registry, {
      sessionId: "sess_recover_pre_cas",
      workspaceId: "workspace",
    });
    const first = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
    harness.store.appendMessage(first, { role: "user", content: "first" });
    await harness.store.save(first);
    const second = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-21T00:00:00.000Z",
    });
    harness.store.appendMessage(second, { role: "assistant", content: "second" });
    await harness.store.save(second);
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: second.path,
    });
    const backupRoot = join(harness.root, "recovery-backups");

    await expect(
      unifyDaemonSessionTranscripts({
        registry: {
          list: (input) => harness.registry.list(input),
          relocateTranscriptPath: async () => {
            throw new Error("simulated registry CAS interruption");
          },
        },
        transcriptSparkHome: harness.transcriptSparkHome,
        backupRoot,
        apply: true,
      }),
    ).rejects.toThrow("simulated registry CAS interruption");
    await expect(access(join(backupRoot, "active.json"))).resolves.toBeUndefined();
    await expect(access(first.path)).resolves.toBeUndefined();
    await expect(access(second.path)).resolves.toBeUndefined();

    const recovered = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });
    expect(recovered.sessions).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, entryCount: 2, changed: true }),
    ]);
    await expect(access(join(backupRoot, "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const target = harness.store.canonicalSessionPath(session.sessionId);
    await expect(harness.store.load(target)).resolves.toMatchObject({
      header: { version: 4 },
      entries: [
        expect.objectContaining({ id: first.entries[0]?.id }),
        expect.objectContaining({ id: second.entries[0]?.id }),
      ],
    });
  });

  it("recovers a relocated Channel transcript after a pre-CAS interruption", async () => {
    const harness = await createHarness("recover-channel-relocation");
    const relocated = await createRelocatedChannelTranscript(
      harness,
      "sess_recover_channel_relocation",
    );
    const backupRoot = join(harness.root, "recover-channel-relocation-backups");

    await expect(
      unifyDaemonSessionTranscripts({
        registry: {
          list: (input) => harness.registry.list(input),
          relocateTranscriptPath: async () => {
            throw new Error("simulated relocated registry CAS interruption");
          },
        },
        transcriptSparkHome: harness.transcriptSparkHome,
        backupRoot,
        apply: true,
      }),
    ).rejects.toThrow("simulated relocated registry CAS interruption");
    await expect(access(join(backupRoot, "active.json"))).resolves.toBeUndefined();
    await expect(access(relocated.source.path)).resolves.toBeUndefined();

    const recovered = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });
    expect(recovered.sessions).toEqual([
      expect.objectContaining({
        sessionId: relocated.session.sessionId,
        sourcePaths: [relocated.source.path],
        entryCount: 1,
        changed: true,
      }),
    ]);
    await expect(access(join(backupRoot, "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const targetStore = new SparkSessionStore({
      cwd: relocated.session.cwd!,
      sparkHome: harness.transcriptSparkHome,
    });
    const targetPath = targetStore.canonicalSessionPath(relocated.session.sessionId);
    await expect(targetStore.load(targetPath)).resolves.toMatchObject({
      header: { cwd: relocated.session.cwd, version: 4 },
      entries: [expect.objectContaining({ id: relocated.source.entries[0]?.id })],
    });
    await expect(harness.registry.get(relocated.session.sessionId)).resolves.toMatchObject({
      sessionPath: targetPath,
    });
  });

  it("fails closed while another transcript migration holds the stable migration lock", async () => {
    const harness = await createHarness("migration-lock");
    const backupRoot = join(harness.root, "stable-migration-root");
    let enterList!: () => void;
    const listEntered = new Promise<void>((resolve) => {
      enterList = resolve;
    });
    let releaseList!: () => void;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const first = unifyDaemonSessionTranscripts({
      registry: {
        list: async () => {
          enterList();
          await listReleased;
          return [];
        },
        relocateTranscriptPath: (input) => harness.registry.relocateTranscriptPath(input),
      },
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });
    await listEntered;

    await expect(
      unifyDaemonSessionTranscripts({
        registry: harness.registry,
        transcriptSparkHome: harness.transcriptSparkHome,
        backupRoot,
        apply: true,
      }),
    ).rejects.toThrow("another transcript migration is active");

    releaseList();
    await expect(first).resolves.toEqual({ backupRoot, sessions: [] });
    await expect(access(`${backupRoot}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not back up a closing discard-on-close transcript", async () => {
    const harness = await createHarness("closing-discard");
    const administrator = await harness.registry.ensureWorkspaceAdministrator("workspace");
    const session = await harness.registry.createSupervised({
      sessionId: "sess_closing_discard",
      scope: administrator.scope,
      lineage: {
        kind: "child",
        parentSessionId: administrator.sessionId,
        origin: { kind: "session" },
      },
      visibility: "internal",
      retention: "discard_on_close",
      purpose: "task_run",
      cwd: harness.cwd,
    });
    const record = harness.store.createSession({
      id: session.sessionId,
      timestamp: "2026-07-21T00:00:00.000Z",
    });
    harness.store.appendMessage(record, { role: "user", content: "temporary content" });
    await harness.store.save(record);
    await harness.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: record.path,
    });
    await harness.registry.markClosing({
      sessionId: session.sessionId,
      expectedLifecycle: "open",
    });
    const backupRoot = join(harness.root, "closing-backups");

    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot,
      apply: true,
    });

    expect(result.sessions).toEqual([]);
    await expect(access(record.path)).resolves.toBeUndefined();
    await expect(access(backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(harness.registry.get(session.sessionId)).resolves.toMatchObject({
      lifecycle: "closing",
      sessionPath: record.path,
    });
  });

  it("indexes each workspace transcript directory once for many sessions", async () => {
    const harness = await createHarness("index-once");
    const sessionIds = ["sess_index_a", "sess_index_b", "sess_index_c"];
    for (const sessionId of sessionIds) {
      const session = await createDaemonWorkspaceSession(harness.registry, {
        sessionId,
        workspaceId: "workspace",
      });
      const record = harness.store.createCanonicalSession({
        id: session.sessionId,
        timestamp: "2026-07-21T00:00:00.000Z",
      });
      harness.store.appendMessage(record, { role: "user", content: sessionId });
      await harness.store.save(record);
      await harness.registry.bindTranscriptPath({
        sessionId: session.sessionId,
        sessionPath: harness.store.canonicalSessionPath(session.sessionId),
      });
    }

    let directoryScans = 0;
    class CountingStore extends SparkSessionStore {
      override async indexSessionPathsById(): Promise<ReadonlyMap<string, readonly string[]>> {
        directoryScans += 1;
        return await super.indexSessionPathsById();
      }
    }

    const result = await unifyDaemonSessionTranscripts({
      registry: harness.registry,
      transcriptSparkHome: harness.transcriptSparkHome,
      backupRoot: join(harness.root, "unused-index-backup"),
      apply: true,
      createStore: (cwd) => new CountingStore({ cwd, sparkHome: harness.transcriptSparkHome }),
    });

    expect(directoryScans).toBe(1);
    expect(
      result.sessions.filter((session) => sessionIds.includes(session.sessionId)),
    ).toHaveLength(3);
  });
});

async function createHarness(label: string) {
  const root = await mkdtemp(join(tmpdir(), `spark-transcript-${label}-`));
  roots.push(root);
  const cwd = join(root, "workspace");
  const transcriptSparkHome = join(root, "pi-agent");
  const registry = createDaemonSessionRegistry(join(root, "registry"), {
    daemonId: "installation-test",
    resolveWorkspaceCwd: (workspaceId) => (workspaceId === "workspace" ? cwd : undefined),
    resolveChannelSessionCwd: async (sessionId) => join(root, "channels", sessionId, "workspace"),
  });
  return {
    root,
    cwd,
    transcriptSparkHome,
    registry,
    store: new SparkSessionStore({ cwd, sparkHome: transcriptSparkHome }),
  };
}

async function createRelocatedChannelTranscript(
  harness: Awaited<ReturnType<typeof createHarness>>,
  label: string,
) {
  const session = await harness.registry.resolveChannelSession({
    adapterId: "qqbot",
    adapterAccountIdentity: `channel-account:${label}`,
    externalKey: `qqbot:c2c:${label}`,
    onUnbound: "create",
    name: `channel ${label}`,
  });
  const legacyStore = new SparkSessionStore({
    cwd: join(harness.root, "legacy-workspace"),
    sparkHome: harness.transcriptSparkHome,
  });
  const source = legacyStore.createCanonicalSession({
    id: session.sessionId,
    timestamp: "2026-07-20T00:00:00.000Z",
  });
  await mkdir(legacyStore.sessionDir, { recursive: true });
  await writeFile(
    source.path,
    `${[
      {
        type: "session",
        version: 3,
        id: session.sessionId,
        timestamp: "2026-07-20T00:00:00.000Z",
        cwd: legacyStore.cwd,
      },
      {
        type: "message",
        id: `message-${label}`,
        parentId: null,
        timestamp: "2026-07-20T00:00:01.000Z",
        message: { role: "user", content: "retained channel history" },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
    "utf8",
  );
  const persistedSource = await legacyStore.load(source.path);
  await harness.registry.bindTranscriptPath({
    sessionId: session.sessionId,
    sessionPath: source.path,
  });
  return { session: (await harness.registry.get(session.sessionId))!, source: persistedSource };
}
