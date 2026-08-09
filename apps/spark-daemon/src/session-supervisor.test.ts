import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SparkRoleSpec } from "@zendev-lab/spark-protocol/role-session";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { SparkTokenUsageStore } from "./store/token-usage.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("SessionSupervisor", () => {
  it("keeps one persistent Administrator root and instantiates owner-bound Role Sessions", async () => {
    const harness = await createHarness();
    const first = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const second = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    expect(second.sessionId).toBe(first.sessionId);
    expect(first).toMatchObject({
      lifetime: "persistent",
      lifecycle: "open",
      owner: { kind: "session", ref: first.sessionId },
      roleRef: "role:builtin-administrator",
      modelType: "coordination",
      purpose: "workspace_administrator",
    });

    const owners = [
      { kind: "session", ref: first.sessionId },
      { kind: "role_call", ref: "inv-role" },
      { kind: "task_run", ref: "run:task" },
      { kind: "task_revision", ref: "task:revision:2" },
      { kind: "workflow_run", ref: "workflow:run" },
      { kind: "driver", ref: "driver:loop" },
      { kind: "driver_tick", ref: "driver:tick:1" },
    ] as const;
    for (const [index, owner] of owners.entries()) {
      const session = await harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: executorRole,
        parentSessionId: first.sessionId,
        owner,
        sessionId: `owned-${index}`,
        purpose: owner.kind,
      });
      expect(session).toMatchObject({
        lifetime: "owned",
        lifecycle: "open",
        owner,
        retention: "discard_on_close",
        visibility: "internal",
        roleRef: executorRole.ref,
      });
    }

    await expect(
      harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: administratorRole,
        parentSessionId: first.sessionId,
        owner: { kind: "driver", ref: "driver:invalid" },
        purpose: "invalid persistent owner",
      }),
    ).rejects.toMatchObject({ code: "session_owner_invalid" });
    harness.close();
  });

  it("closes children before owners and removes transcript and Invocation content", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const transcript = join(harness.root, "owned.jsonl");
    await writeFile(transcript, '{"type":"message","content":"secret transcript"}\n', "utf8");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:owned" },
      sessionId: "owned-close",
      purpose: "task_run",
      transcriptRef: transcript,
    });
    const invocation = harness.invocations.submit({
      sessionId: owned.sessionId,
      prompt: "secret prompt",
      task: { type: "session.run", sessionId: owned.sessionId, prompt: "secret prompt" },
      sourceKind: "role.call",
    });
    const usage = new SparkTokenUsageStore(harness.db);
    usage.registerExecution({
      invocationId: invocation.invocationId,
      scope: { kind: "repro", reproId: "repro-retained" },
      kind: "role_run",
      persistence: "anonymous",
      sessionId: owned.sessionId,
    });
    harness.invocations.claimNext("test-worker");
    harness.invocations.appendEvent(invocation.invocationId, "secret", { text: "secret event" });
    harness.invocations.complete(invocation.invocationId, {
      status: "succeeded",
      result: { text: "secret result" },
    });

    const closed = await harness.supervisor.close({
      sessionId: owned.sessionId,
      summary: { outcome: "implemented", evidenceRefs: ["evidence:kept"] },
    });
    expect(closed).toMatchObject({
      sessionId: owned.sessionId,
      lifecycle: "closed",
      status: "archived",
    });
    expect(closed.sessionPath).toBeUndefined();
    expect(closed.transcriptRef).toBeUndefined();
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    const retained = harness.invocations.require(invocation.invocationId);
    expect(retained.prompt).toBeUndefined();
    expect(retained.task).toBeUndefined();
    expect(retained.result).toBeUndefined();
    expect(retained.payloadRedactedAt).toBeTruthy();
    expect(retained.executionProfile).toMatchObject({ status: "succeeded", claimClass: "root" });
    expect(retained.retentionSummary).toEqual({
      outcome: "implemented",
      evidenceRefs: ["evidence:kept"],
    });
    expect(harness.invocations.getSummary(invocation.invocationId)).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
    });
    expect(harness.invocations.eventPage(invocation.invocationId).events).toEqual([]);
    expect(usage.execution(invocation.invocationId)).toMatchObject({
      executionId: invocation.invocationId,
      kind: "role_run",
      persistence: "anonymous",
    });
    harness.close();
  });

  it("restores only retained public persistent records as a new incarnation", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: administratorRole,
      parentSessionId: root.sessionId,
      sessionId: "interactive-admin",
      purpose: "interactive",
      visibility: "public",
      retention: "retain",
    });
    const child = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "restore-child",
      purpose: "role_call",
    });
    expect((await harness.supervisor.close({ sessionId: parent.sessionId })).lifecycle).toBe(
      "closed",
    );
    expect((await harness.registry.get(child.sessionId))?.lifecycle).toBe("closed");
    const restored = await harness.supervisor.restore(parent.sessionId);
    expect(restored.sessionId).toBe(parent.sessionId);
    expect(restored.incarnation).toBe(2);
    expect(restored.lifecycle).toBe("open");
    expect((await harness.registry.get(child.sessionId))?.lifecycle).toBe("closed");
    await expect(harness.supervisor.restore(child.sessionId)).rejects.toMatchObject({
      code: "session_restore_forbidden",
    });
    harness.close();
  });

  it("reconciles orphaned owned Sessions idempotently", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parentInvocation = harness.invocations.submit({
      invocationId: "inv-orphan-owner",
      sessionId: root.sessionId,
      prompt: "parent",
      task: { type: "session.run", sessionId: root.sessionId, prompt: "parent" },
    });
    harness.invocations.claimNext("parent-worker");
    const orphan = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "role_call", ref: parentInvocation.invocationId },
      sessionId: "orphan-role",
      purpose: "role_call",
    });
    harness.invocations.complete(parentInvocation.invocationId, { status: "succeeded" });
    const first = await harness.supervisor.reconcile({ workspaceIds: ["ws-test"] });
    expect(first.closedSessionIds).toContain(orphan.sessionId);
    const second = await harness.supervisor.reconcile({ workspaceIds: ["ws-test"] });
    expect(second.closedSessionIds).toContain(orphan.sessionId);
    expect((await harness.registry.get(orphan.sessionId))?.archiveHistory).toHaveLength(1);
    harness.close();
  });

  it("finishes an interrupted close during startup reconcile", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const interrupted = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:interrupted" },
      sessionId: "interrupted-close",
      purpose: "task_run",
    });
    await harness.registry.markClosing({
      sessionId: interrupted.sessionId,
      expectedLifecycle: "open",
    });

    const restarted = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
    });
    const first = await restarted.reconcile({ workspaceIds: ["ws-test"] });
    expect(first.closedSessionIds).toContain(interrupted.sessionId);
    expect(await harness.registry.get(interrupted.sessionId)).toMatchObject({
      lifecycle: "closed",
      status: "archived",
    });
    await restarted.reconcile({ workspaceIds: ["ws-test"] });
    expect((await harness.registry.get(interrupted.sessionId))?.archiveHistory).toHaveLength(1);
    harness.close();
  });

  it("runs structured children while the single root worker is saturated", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-supervisor-structured-"));
    roots.push(root);
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const scheduler = new SparkInvocationScheduler({
      store: invocations,
      concurrency: 1,
      executeTask: async (task) => {
        if (task.type === "session.run" && task.prompt === "hold parent") await parentGate;
        return { answer: task.type === "session.run" ? task.prompt : task.type };
      },
    });
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => root,
    });
    const supervisor = new SessionSupervisor({ registry, invocations, scheduler });
    const administrator = await supervisor.ensureWorkspaceAdministrator("ws-test");
    const child = await supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: administrator.sessionId,
      owner: { kind: "role_call", ref: "inv-parent" },
      sessionId: "structured-child",
      purpose: "role_call",
    });
    const parent = invocations.submit({
      invocationId: "inv-parent",
      sessionId: administrator.sessionId,
      prompt: "hold parent",
      task: {
        type: "session.run",
        sessionId: administrator.sessionId,
        prompt: "hold parent",
        cwd: root,
      },
    });
    expect(scheduler.processBatch()).toBe(true);
    await eventually(() => invocations.require(parent.invocationId).status === "running");
    const result = await supervisor.invoke({
      sessionId: child.sessionId,
      prompt: "execute child",
      parentInvocationId: parent.invocationId,
      structured: true,
    });
    expect(result).toMatchObject({ status: "succeeded", claimClass: "structured" });
    expect(invocations.require(parent.invocationId).status).toBe("running");
    releaseParent();
    await scheduler.wait({ timeoutMs: 1_000 });
    db.close();
  });
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "spark-session-supervisor-"));
  roots.push(root);
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  const registry = createDaemonSessionRegistry(root, { resolveWorkspaceCwd: () => root });
  const supervisor = new SessionSupervisor({
    registry,
    invocations,
    ownerExists: async () => true,
  });
  return {
    root,
    db,
    invocations,
    registry,
    supervisor,
    close: () => db.close(),
  };
}

const administratorRole = role({
  ref: "role:builtin-administrator",
  id: "administrator",
  modelType: "coordination",
  instantiation: "persistent",
  capabilities: ["read", "write", "exec", "net", "interact", "spawn"],
});

const executorRole = role({
  ref: "role:builtin-executor",
  id: "executor",
  modelType: "implementation",
  instantiation: "owned",
  capabilities: ["read", "write", "exec", "net"],
});

function role(
  input: Pick<SparkRoleSpec, "ref" | "id" | "modelType" | "instantiation" | "capabilities">,
): SparkRoleSpec {
  return {
    ...input,
    source: "builtin",
    revision: 1,
    description: `${input.id} role`,
    systemPrompt: `You are ${input.id}.`,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}
