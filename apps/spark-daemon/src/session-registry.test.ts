import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonSessionRegistry,
  createSerializedDaemonSessionRegistry,
} from "./session-registry.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("daemon Session registry", () => {
  it("serializes concurrent Administrator ensure calls", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-administrator-"));
    roots.push(sparkHome);
    const registry = createDaemonSessionRegistry(sparkHome, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const ensured = await Promise.all(
      Array.from({ length: 12 }, () => registry.ensureWorkspaceAdministrator("ws_demo")),
    );
    expect(new Set(ensured.map((session) => session.sessionId))).toHaveLength(1);
    await expect(registry.list({ includeArchived: true })).resolves.toEqual([
      expect.objectContaining({
        lineage: { kind: "root", workspaceId: "ws_demo" },
      }),
    ]);
  });

  it("serializes mixed mutations behind one daemon writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-serialized-registry-"));
    roots.push(root);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_demo");
    const request = {
      scope: { kind: "workspace" as const, workspaceId: "ws_demo" },
      supervisorSessionId: admin.sessionId,
      roleBinding: { kind: "none" as const },
    };
    const [first, second] = await Promise.all([
      registry.create({ ...request, sessionId: "sess_first" }),
      registry.create({ ...request, sessionId: "sess_second" }),
    ]);
    await Promise.all([
      registry.bind({ sessionId: first.sessionId, externalKey: "feishu:chat:demo" }),
      registry.archive({ sessionId: second.sessionId }),
    ]);
    const persisted = await registry.list({ includeArchived: true });
    expect(persisted.find((session) => session.sessionId === first.sessionId)?.bindings).toEqual([
      expect.objectContaining({ externalKey: "feishu:chat:demo" }),
    ]);
    expect(persisted.find((session) => session.sessionId === second.sessionId)?.placement).toBe(
      "archived",
    );
  });

  it("linearizes Invocation admission with Session closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-admission-fence-"));
    roots.push(root);
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_admission_fence");
    const session = await registry.create({
      sessionId: "sess_admission_fence",
      scope: { kind: "workspace", workspaceId: "ws_admission_fence" },
      supervisorSessionId: admin.sessionId,
    });
    let closing!: Promise<unknown>;

    const admitted = await registry.commitInvocationAdmission(session.sessionId, () => {
      const invocation = invocations.submit({
        invocationId: "inv_admission_first",
        sessionId: session.sessionId,
        prompt: "admission first",
        task: { type: "session.run", sessionId: session.sessionId, prompt: "admission first" },
      });
      closing = registry.markClosing({ sessionId: session.sessionId });
      return invocation;
    });

    expect(admitted).toMatchObject({ invocationId: "inv_admission_first", status: "queued" });
    await expect(closing).resolves.toMatchObject({ lifecycle: "closing" });
    const admitAfterClosing = vi.fn(() => admitted);
    await expect(
      registry.commitInvocationAdmission(session.sessionId, admitAfterClosing),
    ).rejects.toMatchObject({ code: "session_closing" });
    expect(admitAfterClosing).not.toHaveBeenCalled();
    db.close();
  });

  it("linearizes a synchronous open-Session mutation before or after closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-open-mutation-fence-"));
    roots.push(root);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_open_mutation_fence");
    const session = await registry.create({
      sessionId: "sess_open_mutation_fence",
      scope: { kind: "workspace", workspaceId: "ws_open_mutation_fence" },
      supervisorSessionId: admin.sessionId,
    });
    let closing!: Promise<unknown>;

    const committed = await registry.commitOpenSessionMutation(session.sessionId, (observed) => {
      closing = registry.markClosing({ sessionId: session.sessionId });
      return observed;
    });

    expect(committed).toEqual(session);
    await expect(closing).resolves.toMatchObject({ lifecycle: "closing" });
    const commitAfterClosing = vi.fn(() => session);
    await expect(
      registry.commitOpenSessionMutation(session.sessionId, commitAfterClosing),
    ).rejects.toMatchObject({ code: "session_closing" });
    expect(commitAfterClosing).not.toHaveBeenCalled();
  });

  it("prevents transcript replacement when archive wins the Session fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-archive-first-"));
    roots.push(root);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_archive_first");
    const session = await registry.create({
      sessionId: "sess_archive_first",
      scope: { kind: "workspace", workspaceId: "ws_archive_first" },
      supervisorSessionId: admin.sessionId,
    });
    const sessionPath = join(root, "sess_archive_first.jsonl");
    await registry.bindTranscriptPath({ sessionId: session.sessionId, sessionPath });
    await registry.archive(session.sessionId);
    const replace = vi.fn(async () => undefined);

    await expect(
      registry.commitTranscriptReplacement(
        {
          sessionId: session.sessionId,
          sessionPath,
          expectedIncarnation: session.incarnation,
          expectedLifecycle: "open",
        },
        replace,
      ),
    ).rejects.toMatchObject({ code: "session_transcript_cas_failed" });
    expect(replace).not.toHaveBeenCalled();
  });

  it("holds archive behind an accepted transcript replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-compact-first-"));
    roots.push(root);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_compact_first");
    const session = await registry.create({
      sessionId: "sess_compact_first",
      scope: { kind: "workspace", workspaceId: "ws_compact_first" },
      supervisorSessionId: admin.sessionId,
    });
    const sessionPath = join(root, "sess_compact_first.jsonl");
    const bound = await registry.bindTranscriptPath({ sessionId: session.sessionId, sessionPath });
    const replacementStarted = deferred();
    const releaseReplacement = deferred();
    const order: string[] = [];
    const compact = registry.commitTranscriptReplacement(
      {
        sessionId: session.sessionId,
        sessionPath,
        expectedIncarnation: bound.incarnation,
        expectedLifecycle: "open",
      },
      async () => {
        order.push("replacement-started");
        replacementStarted.resolve();
        await releaseReplacement.promise;
        order.push("replacement-finished");
      },
    );
    await replacementStarted.promise;
    let archiveSettled = false;
    const archive = registry.archive(session.sessionId).then((result) => {
      archiveSettled = true;
      order.push("archive-finished");
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(archiveSettled).toBe(false);
    releaseReplacement.resolve();
    await expect(compact).resolves.toMatchObject({ placement: "active" });
    await expect(archive).resolves.toMatchObject({ placement: "archived" });
    expect(order).toEqual(["replacement-started", "replacement-finished", "archive-finished"]);
  });

  it("keeps ordinary reads ordered while invocation visibility bypasses unrelated mutations", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-session-visibility-"));
    roots.push(sparkHome);
    const backing = createDaemonSessionRegistry(sparkHome);
    const administrator = await backing.ensureWorkspaceAdministrator("ws_visibility");
    const createInput = {
      scope: { kind: "workspace" as const, workspaceId: "ws_visibility" },
      supervisorSessionId: administrator.sessionId,
      roleBinding: { kind: "none" as const },
    };
    await backing.create({
      ...createInput,
      sessionId: "visibility_first",
    });
    await backing.create({
      ...createInput,
      sessionId: "visibility_second",
    });

    const startedMutations: string[] = [];
    let releaseYield!: () => void;
    const yieldGate = new Promise<void>((resolve) => {
      releaseYield = resolve;
    });
    let markYieldStarted!: () => void;
    const yieldStarted = new Promise<void>((resolve) => {
      markYieldStarted = resolve;
    });
    let yieldCount = 0;
    const registry = createSerializedDaemonSessionRegistry(
      {
        ...backing,
        recordRun: async (input) => {
          startedMutations.push(input.sessionId);
          return await backing.recordRun(input);
        },
      },
      {
        yieldBetweenMutations: async () => {
          yieldCount += 1;
          markYieldStarted();
          await yieldGate;
          if (yieldCount === 1) throw new Error("injected cooperative yield failure");
        },
      },
    );

    const firstMutation = registry.recordRun({
      sessionId: "visibility_first",
      sessionPath: join(sparkHome, "visibility-first.jsonl"),
    });
    const secondMutation = registry.recordRun({
      sessionId: "visibility_second",
      sessionPath: join(sparkHome, "visibility-second.jsonl"),
    });
    await firstMutation;
    await yieldStarted;
    expect(startedMutations).toEqual(["visibility_first"]);

    let ordinaryReadSettled = false;
    const ordinaryRead = registry.get("visibility_second").then((session) => {
      ordinaryReadSettled = true;
      return session;
    });
    await expect(
      registry.getInvocationVisibilitySnapshot("visibility_second"),
    ).resolves.toMatchObject({
      sessionId: "visibility_second",
      scope: { kind: "workspace", workspaceId: "ws_visibility" },
    });
    await delay(0);
    expect(ordinaryReadSettled).toBe(false);

    releaseYield();
    await secondMutation;
    await expect(ordinaryRead).resolves.toMatchObject({
      sessionId: "visibility_second",
      sessionPath: join(sparkHome, "visibility-second.jsonl"),
    });
    expect(startedMutations).toEqual(["visibility_first", "visibility_second"]);
  });

  it("publishes closed transcript deletion and reference cleanup as one registry mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-daemon-closed-discard-"));
    roots.push(root);
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_closed_discard");
    const transcript = join(root, "closed.jsonl");
    const session = await registry.createSupervised({
      sessionId: "sess_closed_discard",
      scope: admin.scope,
      lineage: { kind: "child", parentSessionId: admin.sessionId, origin: { kind: "session" } },
      visibility: "internal",
      retention: "retain",
      purpose: "task_run",
      sessionPath: transcript,
      transcriptRef: transcript,
    });
    await registry.markClosing({
      sessionId: session.sessionId,
      expectedLifecycle: "open",
    });
    const closed = await registry.archiveOwned({ sessionId: session.sessionId });
    const discardStarted = deferred();
    const releaseDiscard = deferred();
    let readSettled = false;

    const discard = registry.commitClosedTranscriptDiscard(
      {
        sessionId: closed.sessionId,
        expectedIncarnation: closed.incarnation,
        expectedSessionPath: transcript,
        expectedTranscriptRef: transcript,
      },
      async () => {
        discardStarted.resolve();
        await releaseDiscard.promise;
      },
    );
    await discardStarted.promise;
    const read = registry.get(session.sessionId).then((value) => {
      readSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readSettled).toBe(false);
    releaseDiscard.resolve();

    await expect(discard).resolves.not.toHaveProperty("sessionPath");
    await expect(read).resolves.not.toHaveProperty("transcriptRef");
  });
});

describe("daemon session registry cwd ownership", () => {
  it("creates Channel sessions as Administrator-owned children of the workspace root", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-channel-session-"));
    roots.push(sparkHome);
    const registry = createDaemonSessionRegistry(sparkHome, {
      resolveWorkspaceCwd: () => "/Users/demo/workspace/channel",
    });

    const channel = await registry.resolveBinding({
      externalKey: "feishu:chat:oc_operations",
      onUnbound: "create",
      create: {
        scope: { kind: "workspace", workspaceId: "ws_channel" },
        name: "Operations",
      },
    });
    const root = await registry.ensureWorkspaceAdministrator("ws_channel");

    expect(channel).toMatchObject({
      scope: { kind: "workspace", workspaceId: "ws_channel" },
      roleBinding: { kind: "none" },
      lineage: { kind: "child", parentSessionId: root.sessionId, origin: { kind: "session" } },
      visibility: "public",
      retention: "retain",
      purpose: "channel",
    });
  });

  it("ensures one stable workspace main session under concurrent delivery preparation", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-main-session-"));
    roots.push(sparkHome);
    const registry = createDaemonSessionRegistry(sparkHome, {
      resolveWorkspaceCwd: () => "/Users/demo/workspace/main",
    });

    const ensured = await Promise.all(
      Array.from({ length: 12 }, () => registry.ensureWorkspaceAdministrator("ws_main")),
    );

    expect(new Set(ensured.map((session) => session.sessionId)).size).toBe(1);
    expect(ensured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineage: { kind: "root", workspaceId: "ws_main" },
          scope: { kind: "workspace", workspaceId: "ws_main" },
        }),
      ]),
    );
    const sessions = await registry.list({ includeArchived: true });
    expect(
      sessions.filter(
        (session) =>
          session.scope.kind === "workspace" &&
          session.scope.workspaceId === "ws_main" &&
          session.lineage.kind === "root",
      ),
    ).toHaveLength(1);
    await expect(registry.archive(ensured[0]!.sessionId)).rejects.toMatchObject({
      code: "workspace_administrator_session_mutation_forbidden",
    });
  });

  it("freezes validated cwd and rejects Workspace or GitChange widening", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-session-cwd-"));
    roots.push(sparkHome);
    const workspace = join(sparkHome, "workspace");
    const requested = join(workspace, "packages", "demo");
    await mkdir(requested, { recursive: true });
    const registry = createDaemonSessionRegistry(sparkHome, {
      resolveWorkspaceCwd: () => workspace,
      resolveSessionCwd: async ({ cwd, cwdArtifactRef }) => ({
        cwd: cwd ?? workspace,
        ...(cwdArtifactRef ? { cwdArtifactRef } : {}),
      }),
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_demo");
    const scope = { kind: "workspace" as const, workspaceId: "ws_demo" };
    await expect(
      registry.create({
        sessionId: "sess_workspace",
        scope,
        supervisorSessionId: admin.sessionId,
        roleBinding: { kind: "none" },
        cwd: requested,
        cwdArtifactRef: "artifact:change",
      }),
    ).resolves.toMatchObject({ cwd: requested, cwdArtifactRef: "artifact:change" });
  });

  it("derives child and sibling ownership from the supervisor", async () => {
    const sparkHome = await mkdtemp(join(tmpdir(), "spark-daemon-session-placement-"));
    roots.push(sparkHome);
    const registry = createDaemonSessionRegistry(sparkHome, {
      resolveWorkspaceCwd: () => "/repo",
    });
    const admin = await registry.ensureWorkspaceAdministrator("ws_demo");
    const scope = { kind: "workspace" as const, workspaceId: "ws_demo" };
    const parent = await registry.create({
      scope,
      supervisorSessionId: admin.sessionId,
      placement: "child",
    });
    const child = await registry.create({
      scope,
      supervisorSessionId: parent.sessionId,
      placement: "child",
    });
    expect(child.lineage).toEqual({
      kind: "child",
      parentSessionId: parent.sessionId,
      origin: { kind: "session" },
    });
    const sibling = await registry.create({
      scope,
      supervisorSessionId: child.sessionId,
      placement: "sibling",
    });
    expect(sibling.lineage).toEqual({
      kind: "child",
      parentSessionId: parent.sessionId,
      origin: { kind: "session" },
    });
    await expect(
      registry.create({
        scope,
        supervisorSessionId: admin.sessionId,
        placement: "sibling",
      }),
    ).rejects.toMatchObject({ code: "workspace_administrator_session_mutation_forbidden" });
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
