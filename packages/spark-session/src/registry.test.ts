import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkSessionCloseReceipt } from "@zendev-lab/spark-protocol/session-assignment";
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

function closeReceipt(
  input: Pick<SparkSessionCloseReceipt, "incarnation" | "code" | "summary" | "createdAt">,
): SparkSessionCloseReceipt {
  return {
    version: 1,
    source: "domain_completion",
    quality: "semantic",
    status: "completed",
    evidenceRefs: [],
    artifactRefs: [],
    sourceInvocationIds: ["invocation:receipt"],
    ...input,
  };
}

describe("SparkSessionRegistry", () => {
  it("requires every registry error code to be registered in spark-protocol", () => {
    const registered = new SparkSessionRegistryError("session_not_found", "missing");
    // @ts-expect-error Unregistered session domain codes must fail package typecheck.
    const unregistered = new SparkSessionRegistryError("unregistered_session_error", "internal");

    expect(registered.code).toBe("session_not_found");
    expect(unregistered.code).toBe("unregistered_session_error");
  });

  it("reads v1 workspace records as canonical workspace ownership", async () => {
    const registry = await tempRegistry();
    await writeFile(
      registry.filePath,
      `${JSON.stringify({
        version: 1,
        sessions: [
          {
            sessionId: "sess_legacy",
            workspaceId: "legacy-workspace",
            status: "ready",
            bindings: [],
            createdAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        ],
      })}\n`,
      "utf8",
    );

    await expect(registry.get("sess_legacy")).resolves.toMatchObject({
      scope: { kind: "workspace", workspaceId: "legacy-workspace" },
      workspaceId: "legacy-workspace",
      closeReceipts: [],
    });

    await registry.create({ workspaceId: "ws_new" });
    expect(JSON.parse(await readFile(registry.filePath, "utf8"))).toMatchObject({
      version: 5,
      revision: 1,
      sessions: [
        { sessionId: "sess_legacy", scope: { kind: "workspace" } },
        { scope: { kind: "workspace", workspaceId: "ws_new" } },
      ],
    });
  });

  it("persists a monotonic v5 revision and rejects malformed v5 state", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_revision",
      workspaceId: "ws_revision",
    });
    expect(JSON.parse(await readFile(registry.filePath, "utf8"))).toMatchObject({
      version: 5,
      revision: 1,
    });

    await registry.bind({
      sessionId: created.sessionId,
      externalKey: "infoflow:user:revision",
    });
    expect(JSON.parse(await readFile(registry.filePath, "utf8"))).toMatchObject({
      version: 5,
      revision: 2,
    });

    await writeFile(registry.filePath, `${JSON.stringify({ version: 5, sessions: [] })}\n`, "utf8");
    await expect(registry.list()).rejects.toMatchObject({
      code: "invalid_registry",
      message: "registry v5 revision must be a non-negative integer",
    });
  });

  it("seals the first close receipt for an incarnation and replays it idempotently", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_receipt",
      workspaceId: "ws_receipt",
      lifetime: "owned",
      owner: { kind: "task_run", ref: "run:receipt" },
      retention: "discard_on_close",
    });
    await registry.markClosing({
      sessionId: created.sessionId,
      expectedLifecycle: "open",
      now: new Date("2026-08-10T00:00:01.000Z"),
    });
    const firstReceipt = closeReceipt({
      incarnation: 1,
      code: "task_completed",
      summary: "The task completed.",
      createdAt: "2026-08-10T00:00:02.000Z",
    });
    const sealed = await registry.sealCloseReceipt({
      sessionId: created.sessionId,
      expectedIncarnation: 1,
      expectedLifecycle: "closing",
      receipt: firstReceipt,
    });
    expect(sealed.closeReceipts).toEqual([firstReceipt]);

    const replay = await registry.sealCloseReceipt({
      sessionId: created.sessionId,
      expectedIncarnation: 1,
      expectedLifecycle: "closing",
      receipt: closeReceipt({
        incarnation: 1,
        code: "different_result",
        summary: "This retry must not replace the first receipt.",
        createdAt: "2026-08-10T00:00:03.000Z",
      }),
    });
    expect(replay.closeReceipts).toEqual([firstReceipt]);
    await expect(registry.get(created.sessionId)).resolves.toMatchObject({
      closeReceipts: [firstReceipt],
    });

    const open = await registry.create({
      sessionId: "sess_open_receipt",
      workspaceId: "ws_receipt",
      lifetime: "owned",
      owner: { kind: "task_run", ref: "run:open" },
    });
    await expect(
      registry.sealCloseReceipt({
        sessionId: open.sessionId,
        expectedIncarnation: 1,
        expectedLifecycle: "closing",
        receipt: firstReceipt,
      }),
    ).rejects.toMatchObject({ code: "session_registry_conflict" });
  });

  it("retains only the latest sixteen incarnation receipts", async () => {
    const registry = await tempRegistry();
    await registry.create({
      sessionId: "sess_receipt_history",
      workspaceId: "ws_receipt_history",
      lifetime: "owned",
      owner: { kind: "task_revision", ref: "task:history" },
      retention: "discard_on_close",
    });
    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      version: 5;
      revision: number;
      sessions: Array<Record<string, unknown>>;
    };
    const session = persisted.sessions[0]!;
    session.incarnation = 17;
    session.lifecycle = "closing";
    session.closeReceipts = Array.from({ length: 16 }, (_, index) =>
      closeReceipt({
        incarnation: index + 1,
        code: `incarnation_${index + 1}_completed`,
        summary: `Completed incarnation ${index + 1}.`,
        createdAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    await writeFile(registry.filePath, `${JSON.stringify(persisted)}\n`, "utf8");

    const sealed = await registry.sealCloseReceipt({
      sessionId: "sess_receipt_history",
      expectedIncarnation: 17,
      expectedLifecycle: "closing",
      receipt: closeReceipt({
        incarnation: 17,
        code: "incarnation_17_completed",
        summary: "Completed incarnation 17.",
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
    });
    expect(sealed.closeReceipts).toHaveLength(16);
    expect(sealed.closeReceipts?.map((receipt) => receipt.incarnation)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 2),
    );
  });

  it("ensures one stable protected main session and advances generation after corruption", async () => {
    const registry = await tempRegistry();
    const first = await registry.ensureWorkspaceMain({ workspaceId: "ws_main", cwd: "/repo" });
    const replay = await registry.ensureWorkspaceMain({ workspaceId: "ws_main", cwd: "/repo" });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      scope: { kind: "workspace", workspaceId: "ws_main" },
      relation: { kind: "workspace_main", generation: 1 },
      role: "Administrator",
      roleRef: "role:builtin-administrator",
      modelType: "coordination",
    });
    await expect(registry.archive(first.sessionId)).rejects.toMatchObject({
      code: "workspace_main_session_mutation_forbidden",
    });

    const persisted = JSON.parse(await readFile(registry.filePath, "utf8")) as {
      sessions: Array<{ sessionId: string; status: string }>;
    };
    persisted.sessions.find((session) => session.sessionId === first.sessionId)!.status =
      "archived";
    await writeFile(registry.filePath, `${JSON.stringify(persisted)}\n`, "utf8");
    const recovered = await registry.ensureWorkspaceMain({ workspaceId: "ws_main", cwd: "/repo" });
    expect(recovered.sessionId).not.toBe(first.sessionId);
    expect(recovered.relation).toEqual({ kind: "workspace_main", generation: 2 });
  });

  it("reads legacy daemon-global sessions but rejects new top-level creation", async () => {
    const registry = await tempRegistry();
    const global = {
      sessionId: "sess_global",
      scope: { kind: "daemon", daemonId: "install-test" },
      cwd: "/daemon/base",
      status: "archived",
      bindings: [],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    await writeFile(
      registry.filePath,
      `${JSON.stringify({ version: 3, sessions: [global] })}\n`,
      "utf8",
    );

    await expect(
      registry.list({
        includeArchived: true,
        scope: { kind: "daemon", daemonId: "install-test" },
      }),
    ).resolves.toEqual([expect.objectContaining(global)]);
    await expect(
      registry.create({
        sessionId: "sess_new_global",
        scope: { kind: "daemon", daemonId: "install-test" },
        cwd: "/daemon/base",
      }),
    ).rejects.toMatchObject({
      code: "invalid_scope",
      message: "New top-level sessions must belong to a workspace.",
    });
  });

  it("creates, binds, lists, and archives sessions after channel unbind", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      workspaceId: "ws_demo",
      title: "Ops",
      role: "coordinator",
    });
    expect(created).toMatchObject({
      status: "ready",
      role: "coordinator",
      title: "coordinator",
    });
    expect(created.sessionId).toMatch(/^sess_/);

    const bound = await registry.bind({
      sessionId: created.sessionId,
      externalKey: "feishu:chat:oc_demo",
    });
    expect(bound.bindings).toHaveLength(1);
    expect(bound.bindings[0]?.externalKey).toBe("feishu:chat:oc_demo");
    expect(bound.bindings[0]?.adapter).toBe("feishu");

    const listed = await registry.list({ workspaceId: "ws_demo" });
    expect(listed.map((session) => session.sessionId)).toEqual([created.sessionId]);

    const resolved = await registry.resolveBinding({
      externalKey: "feishu:chat:oc_demo",
    });
    expect(resolved.sessionId).toBe(created.sessionId);

    await expect(registry.archive(created.sessionId)).rejects.toMatchObject({
      code: "session_channel_bound",
    } satisfies Partial<SparkSessionRegistryError>);
    await expect(registry.get(created.sessionId)).resolves.toMatchObject({
      status: "ready",
      bindings: [{ kind: "channel", externalKey: "feishu:chat:oc_demo" }],
    });

    const unbound = await registry.unbind(created.sessionId, "feishu:chat:oc_demo");
    expect(unbound.bindings).toEqual([]);

    const archived = await registry.archive(created.sessionId);
    expect(archived.status).toBe("archived");
    expect(await registry.list()).toEqual([]);
    expect(await registry.list({ includeArchived: true })).toHaveLength(1);
  });

  it("keeps one active reusable Session per workspace role", async () => {
    const registry = await tempRegistry();
    const first = await registry.create({ workspaceId: "ws_roles", role: "质量验证" });

    await expect(
      registry.create({ workspaceId: "ws_roles", role: " 质量验证 " }),
    ).rejects.toMatchObject({
      code: "session_role_conflict",
      message: expect.stringContaining(first.sessionId),
    } satisfies Partial<SparkSessionRegistryError>);

    const unassigned = await registry.create({ workspaceId: "ws_roles" });
    await expect(registry.setRoleIfMissing(unassigned.sessionId, "质量验证")).rejects.toMatchObject(
      {
        code: "session_role_conflict",
        message: expect.stringContaining(first.sessionId),
      } satisfies Partial<SparkSessionRegistryError>,
    );

    await expect(
      registry.create({ workspaceId: "ws_other", role: "质量验证" }),
    ).resolves.toMatchObject({ scope: { kind: "workspace", workspaceId: "ws_other" } });

    await registry.archive(first.sessionId);
    await expect(
      registry.create({ workspaceId: "ws_roles", role: "质量验证" }),
    ).resolves.toMatchObject({ role: "质量验证" });
  });

  it("keeps task execution RoleRefs out of the user-facing title", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_task_worker",
      workspaceId: "ws_demo",
      role: "role:builtin-worker",
      relation: {
        kind: "task_execution",
        ownerSessionId: "sess_owner",
        projectRef: "proj:demo",
        taskRef: "task:demo",
        runRef: "run:demo",
        sessionGoalId: "goal-demo",
        roleRef: "role:builtin-worker",
        jobId: "job-demo",
        attempt: 1,
      },
    });

    expect(created.role).toBe("role:builtin-worker");
    expect(created).not.toHaveProperty("title");
  });

  it("persists Fleet worker lane identity without a user-facing title", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_fleet_worker",
      workspaceId: "ws_demo",
      role: "role:executor",
      relation: {
        kind: "fleet_worker",
        ownerSessionId: "sess_owner",
        projectRef: "proj:demo",
        roleRef: "role:executor",
        laneKey: "fleet:lane",
        primaryArtifactRef: "artifact:repo",
        writableArtifactRefs: ["artifact:repo"],
      },
    });

    expect(created).toMatchObject({
      role: "role:executor",
      relation: { kind: "fleet_worker", laneKey: "fleet:lane" },
    });
    expect(created).not.toHaveProperty("title");

    const persisted = await registry.get("sess_fleet_worker");
    expect(persisted).toMatchObject({
      role: "role:executor",
      lifetime: "persistent",
      owner: { kind: "session", ref: "sess_owner" },
      authority: { kind: "role", ref: "role:executor" },
      stateBinding: { kind: "session", ref: "sess_fleet_worker" },
      visibility: "internal",
      retention: "retain",
      purpose: "fleet_worker",
      relation: { kind: "fleet_worker", laneKey: "fleet:lane" },
    });
  });

  it("persists searchable archive tags and preserves them after restore", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      workspaceId: "ws_history",
      role: "Quality Verification",
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    const archived = await registry.archive({
      sessionId: created.sessionId,
      source: "retention",
      reason: "inactive unassigned session exceeded 30 days",
      tags: ["policy:inactive-unassigned-30d", "cohort:2026-q3"],
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(archived).toMatchObject({
      status: "archived",
      tags: expect.arrayContaining([
        "archive-source:retention",
        "archived:2026-08",
        "workspace:ws_history",
        "role:Quality%20Verification",
        "policy:inactive-unassigned-30d",
      ]),
      archiveHistory: [
        expect.objectContaining({
          archivedAt: "2026-08-15T00:00:00.000Z",
          source: "retention",
          reason: "inactive unassigned session exceeded 30 days",
        }),
      ],
    });
    await expect(
      registry.list({ includeArchived: true, tags: ["policy:inactive-unassigned-30d"] }),
    ).resolves.toEqual([archived]);
    await expect(
      registry.list({ includeArchived: true, query: "quality archive-source:retention" }),
    ).resolves.toEqual([archived]);

    const restored = await registry.restore(
      created.sessionId,
      new Date("2026-08-16T00:00:00.000Z"),
    );
    expect(restored.status).toBe("ready");
    expect(restored.tags).toEqual(expect.arrayContaining(["lifecycle:restored", "cohort:2026-q3"]));
    expect(restored.archiveHistory).toEqual(archived.archiveHistory);
  });

  it("rejects binding conflicts and unbound resolve by default", async () => {
    const registry = await tempRegistry();
    const first = await registry.create({ workspaceId: "ws_a", title: "A" });
    const second = await registry.create({ workspaceId: "ws_a", title: "B" });
    await registry.bind({
      sessionId: first.sessionId,
      externalKey: "infoflow:user:u1",
    });

    await expect(
      registry.bind({
        sessionId: second.sessionId,
        externalKey: "infoflow:user:u1",
      }),
    ).rejects.toMatchObject({
      code: "binding_conflict",
    } satisfies Partial<SparkSessionRegistryError>);

    await expect(
      registry.resolveBinding({ externalKey: "feishu:chat:missing" }),
    ).rejects.toMatchObject({
      code: "binding_unbound",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("can create+bind on unbound when policy is create", async () => {
    const registry = await tempRegistry();
    const resolved = await registry.resolveBinding({
      externalKey: "conv:feishu:oc_auto",
      onUnbound: "create",
      create: { workspaceId: "ws_auto", title: "Auto" },
    });
    expect(resolved.bindings[0]?.externalKey).toBe("conv:feishu:oc_auto");
    expect(resolved.title).toBe("Auto");
  });

  it("upgrades a legacy binding and follows one provider account across an adapter rename", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_adapter", title: "Adapter" });
    await registry.bind({
      sessionId: created.sessionId,
      externalKey: "infoflow:user:u1",
    });

    const upgraded = await registry.resolveBinding({
      externalKey: "infoflow:user:u1",
      adapterId: "info-main",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      allowLegacyAccountClaim: true,
    });
    expect(upgraded.bindings).toEqual([
      expect.objectContaining({
        adapter: "infoflow",
        adapterId: "info-main",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ]);

    const renamed = await registry.resolveBinding({
      externalKey: "infoflow:user:u1",
      adapterId: "info-renamed",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
    });
    expect(renamed.bindings).toEqual([
      expect.objectContaining({
        adapterId: "info-renamed",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ]);
  });

  it("separates one external key across provider accounts", async () => {
    const registry = await tempRegistry();
    const first = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-main",
      adapterAccountIdentity: "channel-account:infoflow:account-a",
      onUnbound: "create",
      create: { workspaceId: "ws_accounts", title: "Account A" },
    });
    const second = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-backup",
      adapterAccountIdentity: "channel-account:infoflow:account-b",
      onUnbound: "create",
      create: { workspaceId: "ws_accounts", title: "Account B" },
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(
      registry.resolveBinding({
        externalKey: "infoflow:user:shared-user",
        adapterAccountIdentity: "channel-account:infoflow:account-a",
      }),
    ).resolves.toMatchObject({ sessionId: first.sessionId });
    await expect(
      registry.resolveBinding({
        externalKey: "infoflow:user:shared-user",
        adapterAccountIdentity: "channel-account:infoflow:account-b",
      }),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
    await expect(
      registry.resolveBinding({ externalKey: "infoflow:user:shared-user" }),
    ).rejects.toMatchObject({ code: "binding_ambiguous" });
  });

  it("does not guess which configured account owns an unscoped legacy binding", async () => {
    const registry = await tempRegistry();
    const legacy = await registry.create({ workspaceId: "ws_legacy", title: "Legacy" });
    await registry.bind({
      sessionId: legacy.sessionId,
      externalKey: "infoflow:user:shared-user",
    });

    const modern = await registry.resolveBinding({
      externalKey: "infoflow:user:shared-user",
      adapterId: "info-secondary",
      adapterAccountIdentity: "channel-account:infoflow:secondary",
      onUnbound: "create",
      create: { workspaceId: "ws_legacy", title: "Secondary account" },
    });

    expect(modern.sessionId).not.toBe(legacy.sessionId);
    const unchangedLegacy = await registry.get(legacy.sessionId);
    expect(unchangedLegacy?.bindings).toEqual([
      expect.objectContaining({ externalKey: "infoflow:user:shared-user" }),
    ]);
    expect(unchangedLegacy?.bindings[0]).not.toHaveProperty("adapterId");
    expect(unchangedLegacy?.bindings[0]).not.toHaveProperty("adapterAccountIdentity");
  });

  it("unbinds an exact provider account and refuses an ambiguous legacy unbind", async () => {
    const registry = await tempRegistry();
    const session = await registry.create({ workspaceId: "ws_unbind_accounts" });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "qqbot:c2c:shared-user",
      adapterId: "qq-main",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
    });
    await registry.bind({
      sessionId: session.sessionId,
      externalKey: "qqbot:c2c:shared-user",
      adapterId: "qq-backup",
      adapterAccountIdentity: "channel-account:qqbot:account-b",
    });

    await expect(registry.unbind(session.sessionId, "qqbot:c2c:shared-user")).rejects.toMatchObject(
      { code: "binding_ambiguous" },
    );
    const updated = await registry.unbind(
      session.sessionId,
      "qqbot:c2c:shared-user",
      "channel-account:qqbot:account-a",
    );
    expect(updated.bindings).toEqual([
      expect.objectContaining({
        adapterId: "qq-backup",
        adapterAccountIdentity: "channel-account:qqbot:account-b",
      }),
    ]);
  });

  it("persists a session-owned model selection", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_model", title: "Model" });
    const now = new Date("2026-07-10T06:00:00.000Z");

    const updated = await registry.setModel(
      created.sessionId,
      {
        providerName: "openai",
        modelId: "gpt-5-codex",
        providerLabel: "OpenAI",
        modelLabel: "GPT-5 Codex",
      },
      now,
    );

    expect(updated.model).toEqual({
      providerName: "openai",
      modelId: "gpt-5-codex",
      providerLabel: "OpenAI",
      modelLabel: "GPT-5 Codex",
    });
    expect(updated.updatedAt).toBe(now.toISOString());
    await expect(registry.get(created.sessionId)).resolves.toMatchObject({ model: updated.model });
  });

  it("rejects model changes for unknown and archived sessions", async () => {
    const registry = await tempRegistry();
    const model = { providerName: "openai", modelId: "gpt-5-codex" };

    await expect(registry.setModel("sess_missing", model)).rejects.toMatchObject({
      code: "session_not_found",
    } satisfies Partial<SparkSessionRegistryError>);

    const created = await registry.create({ workspaceId: "ws_model" });
    await registry.archive(created.sessionId);
    await expect(registry.setModel(created.sessionId, model)).rejects.toMatchObject({
      code: "session_archived",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("sets a generated role once and mirrors it to the compatibility title", async () => {
    const registry = await tempRegistry();
    const untitled = await registry.create({
      sessionId: "sess_untitled",
      workspaceId: "ws_title",
      now: new Date("2026-07-10T07:00:00.000Z"),
    });

    const titled = await registry.setRoleIfMissing(
      untitled.sessionId,
      "  Runtime Operations  ",
      new Date("2026-07-10T07:01:00.000Z"),
    );
    expect(titled).toMatchObject({
      role: "Runtime Operations",
      title: "Runtime Operations",
      updatedAt: "2026-07-10T07:01:00.000Z",
    });
    await expect(
      registry.setRoleIfMissing(
        untitled.sessionId,
        "Do not replace the first role",
        new Date("2026-07-10T07:02:00.000Z"),
      ),
    ).resolves.toEqual(titled);

    const channel = await registry.create({
      sessionId: "sess_channel_title",
      workspaceId: "ws_title",
    });
    const bound = await registry.bind({
      sessionId: channel.sessionId,
      externalKey: "infoflow:user:alice",
    });
    await expect(
      registry.setRoleIfMissing(channel.sessionId, "Do not name channels"),
    ).resolves.toEqual(bound);

    const archived = await registry.create({
      sessionId: "sess_archived_title",
      workspaceId: "ws_title",
    });
    const archivedRecord = await registry.archive(archived.sessionId);
    await expect(
      registry.setRoleIfMissing(archived.sessionId, "Do not name archives"),
    ).resolves.toEqual(archivedRecord);
  });

  it("keeps an explicit legacy or platform title outside role ownership", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({ workspaceId: "ws_legacy_title", title: "Verifier" });

    expect(created).toMatchObject({ title: "Verifier" });
    expect(created.role).toBeUndefined();
  });

  it("records a completed native transcript idempotently without moving updatedAt backwards", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_recorded",
      workspaceId: "ws_recorded",
      now: new Date("2026-07-10T08:00:00.000Z"),
    });
    const first = await registry.recordRun({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_recorded.jsonl",
      now: new Date("2026-07-10T08:05:00.000Z"),
    });
    const replayed = await registry.recordRun({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_recorded.jsonl",
      now: new Date("2026-07-10T08:04:00.000Z"),
    });

    expect(first.sessionPath).toBe("/tmp/sessions/sess_recorded.jsonl");
    expect(first.status).toBe("ready");
    expect(replayed.updatedAt).toBe("2026-07-10T08:05:00.000Z");
    await expect(registry.get(created.sessionId)).resolves.toEqual(replayed);
  });

  it("binds a transcript without settling the turn and rejects implicit relocation", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_bound",
      workspaceId: "ws_bound",
      status: "running",
    });
    const bound = await registry.bindTranscriptPath({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/sess_bound.jsonl",
    });

    expect(bound).toMatchObject({
      status: "running",
      sessionPath: "/tmp/sessions/sess_bound.jsonl",
    });
    await expect(
      registry.recordRun({
        sessionId: created.sessionId,
        sessionPath: "/tmp/sessions/another.jsonl",
      }),
    ).rejects.toMatchObject({
      code: "session_transcript_conflict",
    } satisfies Partial<SparkSessionRegistryError>);
  });

  it("relocates an ordinary transcript only through an explicit path CAS", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_relocated",
      workspaceId: "ws_relocated",
    });
    await registry.bindTranscriptPath({
      sessionId: created.sessionId,
      sessionPath: "/tmp/sessions/before.jsonl",
    });

    await expect(
      registry.relocateTranscriptPath({
        sessionId: created.sessionId,
        expectedSessionPath: "/tmp/sessions/stale.jsonl",
        sessionPath: "/tmp/sessions/after.jsonl",
      }),
    ).rejects.toMatchObject({
      code: "session_transcript_cas_failed",
    } satisfies Partial<SparkSessionRegistryError>);
    await expect(
      registry.relocateTranscriptPath({
        sessionId: created.sessionId,
        expectedSessionPath: "/tmp/sessions/before.jsonl",
        sessionPath: "/tmp/sessions/after.jsonl",
      }),
    ).resolves.toMatchObject({
      sessionPath: "/tmp/sessions/after.jsonl",
    });
  });

  it("tracks queued and settled turns for rail ordering", async () => {
    const registry = await tempRegistry();
    const created = await registry.create({
      sessionId: "sess_turn",
      workspaceId: "ws_turn",
      now: new Date("2026-07-10T08:00:00.000Z"),
    });
    const running = await registry.recordTurnQueued(
      created.sessionId,
      new Date("2026-07-10T08:01:00.000Z"),
    );
    expect(running).toMatchObject({
      status: "running",
      updatedAt: "2026-07-10T08:01:00.000Z",
    });
    const ready = await registry.recordTurnSettled(
      created.sessionId,
      new Date("2026-07-10T08:02:00.000Z"),
    );
    expect(ready).toMatchObject({ status: "ready", updatedAt: "2026-07-10T08:02:00.000Z" });
  });

  it("hides side threads by default, fences generations, and archives them with their parent", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({
      sessionId: "parent",
      workspaceId: "ws_side",
      cwd: "/work",
    });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "child",
      mode: "contextual",
      sessionPath: "/tmp/child-1.jsonl",
    });
    expect(await registry.list()).toEqual([parent]);
    expect(await registry.list({ includeSideThreads: true })).toHaveLength(2);
    await expect(
      registry.resetSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 2,
        sessionPath: "/tmp/child-2.jsonl",
      }),
    ).rejects.toMatchObject({ code: "side_thread_generation_conflict" });
    const reset = await registry.resetSideThread({
      sessionId: child.sessionId,
      expectedGeneration: 1,
      sessionPath: "/tmp/child-2.jsonl",
    });
    expect(reset.relation).toMatchObject({ generation: 2 });
    expect(reset.incarnation).toBe(2);
    await registry.archive(parent.sessionId);
    await expect(registry.get(child.sessionId)).resolves.toMatchObject({ status: "archived" });
  });

  it("inherits parent scope and refuses nested side-thread relations", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({ sessionId: "parent", workspaceId: "ws_a" });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      mode: "tangent",
    });
    expect(child.scope).toEqual(parent.scope);
    await expect(
      registry.ensureSideThread({ parentSessionId: child.sessionId, mode: "tangent" }),
    ).rejects.toMatchObject({ code: "side_thread_nesting_forbidden" });
  });

  it("keeps child configuration behind the Side Thread surface", async () => {
    const registry = await tempRegistry();
    const parent = await registry.create({ sessionId: "parent", workspaceId: "ws_side" });
    const child = await registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "child",
      mode: "contextual",
    });

    await expect(
      registry.setModel(child.sessionId, { providerName: "provider", modelId: "model" }),
    ).rejects.toMatchObject({ code: "side_thread_mutation_forbidden" });
    await expect(registry.setThinkingLevel(child.sessionId, "high")).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });
    await expect(registry.archive(child.sessionId)).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });
    await expect(registry.unbind(child.sessionId, "qqbot:c2c:user")).rejects.toMatchObject({
      code: "side_thread_mutation_forbidden",
    });

    const configured = await registry.configureSideThread({
      sessionId: child.sessionId,
      expectedGeneration: 1,
      model: { providerName: "provider", modelId: "model" },
      thinkingLevel: "high",
    });
    expect(configured).toMatchObject({
      model: { providerName: "provider", modelId: "model" },
      thinkingLevel: "high",
    });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 2,
        model: null,
      }),
    ).rejects.toMatchObject({ code: "side_thread_generation_conflict" });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "side_thread_config_empty" });
    await expect(
      registry.configureSideThread({
        sessionId: child.sessionId,
        expectedGeneration: 1,
        model: null,
        thinkingLevel: null,
      }),
    ).resolves.not.toHaveProperty("model");
  });
});
