import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
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
  it("binds supervised invocations to the Hub delivery identity", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("rtwb-test");
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
      resolveWorkspaceBindingId: () => "rtwb_22222222222222222222222222222222",
    });

    const invocation = await supervisor.invoke({
      sessionId: root.sessionId,
      prompt: "route this invocation",
    });

    expect(invocation).toMatchObject({
      workspaceBindingId: "rtwb_22222222222222222222222222222222",
      task: {
        workspaceId: "rtwb-test",
        workspaceBindingId: "rtwb_22222222222222222222222222222222",
      },
    });
    harness.close();
  });

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
    harness.invocations.submit({
      invocationId: "inv-role",
      sessionId: first.sessionId,
      prompt: "own a Role call",
      task: { type: "session.run", sessionId: first.sessionId, prompt: "own a Role call" },
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
    await expect(
      harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: executorRole,
        parentSessionId: first.sessionId,
        owner: { kind: "role_call", ref: "inv-missing" },
        purpose: "invalid role-call owner",
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
      completion: {
        source: "domain_completion",
        status: "completed",
        code: "task_run_completed",
        summary: "Implemented the requested change.",
        evidenceRefs: ["evidence:kept"],
        artifactRefs: ["artifact:git-change"],
        sourceInvocationIds: [invocation.invocationId],
      },
    });
    expect(closed).toMatchObject({
      sessionId: owned.sessionId,
      lifecycle: "closed",
      status: "archived",
    });
    expect(closed.closeReceipts).toEqual([
      expect.objectContaining({
        version: 1,
        source: "domain_completion",
        quality: "semantic",
        status: "completed",
        code: "task_run_completed",
        summary: "Implemented the requested change.",
        incarnation: 1,
        evidenceRefs: ["evidence:kept"],
        artifactRefs: ["artifact:git-change"],
        sourceInvocationIds: [invocation.invocationId],
      }),
    ]);
    expect(closed.sessionPath).toBeUndefined();
    expect(closed.transcriptRef).toBeUndefined();
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    const retained = harness.invocations.require(invocation.invocationId);
    expect(retained.prompt).toBeUndefined();
    expect(retained.task).toBeUndefined();
    expect(retained.result).toBeUndefined();
    expect(retained.payloadRedactedAt).toBeTruthy();
    expect(retained.executionProfile).toMatchObject({ status: "succeeded", claimClass: "root" });
    expect(retained.retentionSummary).toEqual({ status: "succeeded", sourceKind: "role.call" });
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

  it("rejects external owners when no authoritative validator is installed", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const failClosed = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
    });
    await expect(
      failClosed.instantiate({
        workspaceId: "ws-test",
        role: executorRole,
        parentSessionId: root.sessionId,
        owner: { kind: "task_run", ref: "run:missing" },
        purpose: "task_run",
      }),
    ).rejects.toMatchObject({ code: "session_owner_invalid" });
    harness.close();
  });

  it("downgrades an invalid owner completion to a deterministic fallback", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:invalid-completion" },
      sessionId: "invalid-completion",
      purpose: "task_run",
    });
    const foreign = harness.invocations.submit({
      sessionId: root.sessionId,
      prompt: "foreign prompt",
      task: { type: "session.run", sessionId: root.sessionId, prompt: "foreign prompt" },
    });
    harness.invocations.claimNext("foreign-worker");
    harness.invocations.complete(foreign.invocationId, { status: "succeeded" });
    const invocation = harness.invocations.submit({
      sessionId: owned.sessionId,
      prompt: "owned prompt",
      task: { type: "session.run", sessionId: owned.sessionId, prompt: "owned prompt" },
      sourceKind: "task.run",
    });
    harness.invocations.claimNext("owned-worker");
    harness.invocations.complete(invocation.invocationId, {
      status: "failed",
      errorCode: "TASK/FAILED WITH DETAIL",
      errorMessage: "private failure detail",
    });

    const closed = await harness.supervisor.close({
      sessionId: owned.sessionId,
      completion: {
        source: "domain_completion",
        status: "completed",
        code: "task_run_completed",
        summary: "This candidate points at another Session.",
        evidenceRefs: [],
        artifactRefs: [],
        sourceInvocationIds: [foreign.invocationId],
      },
    });
    expect(closed.closeReceipts).toEqual([
      expect.objectContaining({
        source: "deterministic_fallback",
        quality: "fallback",
        status: "failed",
        code: "task_failed_with_detail",
        sourceInvocationIds: [invocation.invocationId],
      }),
    ]);
    expect(JSON.stringify(closed.closeReceipts)).not.toContain("private failure detail");
    harness.close();
  });

  it("does not propagate an owner completion to child Sessions", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:parent" },
      sessionId: "owned-parent",
      purpose: "task_run",
    });
    const child = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "owned-child",
      purpose: "role_call",
    });
    const childInvocation = harness.invocations.submit({
      sessionId: child.sessionId,
      prompt: "child",
      task: { type: "session.run", sessionId: child.sessionId, prompt: "child" },
    });
    harness.invocations.claimNext("child-worker");
    harness.invocations.complete(childInvocation.invocationId, { status: "succeeded" });
    const parentInvocation = harness.invocations.submit({
      sessionId: parent.sessionId,
      prompt: "parent",
      task: { type: "session.run", sessionId: parent.sessionId, prompt: "parent" },
    });
    harness.invocations.claimNext("parent-worker");
    harness.invocations.complete(parentInvocation.invocationId, { status: "succeeded" });

    const closed = await harness.supervisor.close({
      sessionId: parent.sessionId,
      completion: {
        source: "domain_completion",
        status: "completed",
        code: "parent_completed",
        summary: "Parent summary.",
        evidenceRefs: [],
        artifactRefs: [],
        sourceInvocationIds: [parentInvocation.invocationId],
      },
    });
    expect(closed.closeReceipts?.[0]).toMatchObject({
      code: "parent_completed",
      sourceInvocationIds: [parentInvocation.invocationId],
    });
    expect((await harness.registry.get(child.sessionId))?.closeReceipts?.[0]).toMatchObject({
      source: "deterministic_fallback",
      code: "session_invocation_completed",
      sourceInvocationIds: [childInvocation.invocationId],
    });
    harness.close();
  });

  it("leaves content intact when receipt persistence fails", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const transcript = join(harness.root, "persist-failure.jsonl");
    await writeFile(transcript, '{"content":"secret transcript"}\n', "utf8");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:persist-failure" },
      sessionId: "persist-failure",
      purpose: "task_run",
      transcriptRef: transcript,
    });
    const invocation = harness.invocations.submit({
      sessionId: owned.sessionId,
      prompt: "secret prompt",
      task: { type: "session.run", sessionId: owned.sessionId, prompt: "secret prompt" },
    });
    harness.invocations.claimNext("persist-worker");
    harness.invocations.complete(invocation.invocationId, {
      status: "succeeded",
      result: { assistantText: "Semantic close summary." },
    });
    const supervisor = new SessionSupervisor({
      registry: {
        ...harness.registry,
        sealCloseReceipt: async () => {
          throw new Error("receipt persistence failed");
        },
      },
      invocations: harness.invocations,
      ownerExists: async () => true,
    });

    await expect(supervisor.close({ sessionId: owned.sessionId })).rejects.toThrow(
      "receipt persistence failed",
    );
    await expect(harness.registry.get(owned.sessionId)).resolves.toMatchObject({
      lifecycle: "closing",
      closeReceipts: [],
    });
    await expect(access(transcript)).resolves.toBeUndefined();
    const retained = harness.invocations.require(invocation.invocationId);
    expect(retained).toMatchObject({
      prompt: "secret prompt",
      result: { assistantText: "Semantic close summary." },
    });
    expect(retained).not.toHaveProperty("payloadRedactedAt");
    harness.close();
  });

  it("closes a Side Thread through the Supervisor without opening public archive mutation", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: administratorRole,
      parentSessionId: root.sessionId,
      sessionId: "side-parent",
      purpose: "interactive",
      visibility: "public",
      retention: "retain",
    });
    const transcript = join(harness.root, "side-thread.jsonl");
    await writeFile(transcript, '{"content":"private tangent"}\n', "utf8");
    const sideThread = await harness.registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "side-child",
      sessionPath: transcript,
      mode: "tangent",
    });

    const closed = await harness.supervisor.close({ sessionId: sideThread.sessionId });

    expect(closed).toMatchObject({ lifecycle: "closed", status: "archived" });
    expect(closed.transcriptRef).toBeUndefined();
    expect(closed.closeReceipts).toEqual([
      expect.objectContaining({
        source: "deterministic_fallback",
        quality: "fallback",
        incarnation: 1,
      }),
    ]);
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    harness.close();
  });

  it("fully closes a Side Thread before its parent", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: administratorRole,
      parentSessionId: root.sessionId,
      sessionId: "side-parent-owned",
      purpose: "interactive",
      visibility: "public",
      retention: "retain",
    });
    const transcript = join(harness.root, "side-thread-owned.jsonl");
    await writeFile(transcript, '{"content":"private tangent"}\n', "utf8");
    await writeFile(`${transcript}.side-thread-index.json`, '{"exchanges":["private"]}\n', "utf8");
    await writeFile(`${transcript}.snapshot-index.json`, '{"messages":["private"]}\n', "utf8");
    const sideThread = await harness.registry.ensureSideThread({
      parentSessionId: parent.sessionId,
      sessionId: "side-child-owned",
      sessionPath: transcript,
      mode: "tangent",
    });

    const closedParent = await harness.supervisor.close({ sessionId: parent.sessionId });

    expect(closedParent).toMatchObject({ lifecycle: "closed", status: "archived" });
    const closedSideThread = await harness.registry.get(sideThread.sessionId);
    expect(closedSideThread).toMatchObject({
      lifecycle: "closed",
      status: "archived",
      closeReceipts: [
        expect.objectContaining({
          source: "deterministic_fallback",
          quality: "fallback",
          incarnation: 1,
        }),
      ],
    });
    expect(closedSideThread).not.toHaveProperty("transcriptRef");
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${transcript}.side-thread-index.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(`${transcript}.snapshot-index.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    harness.close();
  });

  it("idempotently instantiates driver-owned child Sessions with explicit state binding", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const input = {
      sessionId: "driver-session",
      parentSessionId: root.sessionId,
      owner: { kind: "driver", ref: "loop:test" } as const,
      authority: { kind: "driver", ref: "loop:test" } as const,
      stateBinding: { kind: "session", ref: root.sessionId } as const,
      purpose: "driver",
    };
    const first = await harness.supervisor.instantiateOwnedContext(input);
    const second = await harness.supervisor.instantiateOwnedContext(input);

    expect(second.sessionId).toBe(first.sessionId);
    expect(first).toMatchObject({
      lifetime: "owned",
      owner: input.owner,
      authority: input.authority,
      stateBinding: input.stateBinding,
      visibility: "internal",
      retention: "discard_on_close",
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

  it("reconciles every close crash window idempotently", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const interrupted = [];
    for (const phase of ["before-seal", "after-seal", "after-redaction", "after-transcript"]) {
      const transcript = join(harness.root, `${phase}.jsonl`);
      await writeFile(transcript, '{"content":"temporary"}\n', "utf8");
      const session = await harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: executorRole,
        parentSessionId: root.sessionId,
        owner: { kind: "task_run", ref: `run:${phase}` },
        sessionId: `interrupted-${phase}`,
        purpose: "task_run",
        transcriptRef: transcript,
      });
      const invocation = harness.invocations.submit({
        sessionId: session.sessionId,
        prompt: `secret ${phase}`,
        task: { type: "session.run", sessionId: session.sessionId, prompt: `secret ${phase}` },
      });
      harness.invocations.claimNext(`${phase}-worker`);
      harness.invocations.complete(invocation.invocationId, { status: "succeeded" });
      await harness.registry.markClosing({
        sessionId: session.sessionId,
        expectedLifecycle: "open",
      });
      if (phase !== "before-seal") {
        await harness.registry.sealCloseReceipt({
          sessionId: session.sessionId,
          expectedIncarnation: 1,
          expectedLifecycle: "closing",
          receipt: {
            version: 1,
            source: "domain_completion",
            quality: "semantic",
            status: "completed",
            code: "task_run_completed",
            summary: `Completed ${phase}.`,
            evidenceRefs: [],
            artifactRefs: [],
            sourceInvocationIds: [invocation.invocationId],
            incarnation: 1,
            createdAt: "2026-08-10T00:00:00.000Z",
          },
        });
      }
      if (phase === "after-redaction" || phase === "after-transcript") {
        harness.invocations.redactSessionPayloads(session.sessionId);
      }
      if (phase === "after-transcript") await rm(transcript);
      interrupted.push({ session, invocation, transcript });
    }

    const restarted = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
    });
    const first = await restarted.reconcile({ workspaceIds: ["ws-test"] });
    expect(first.closedSessionIds).toEqual(
      expect.arrayContaining(interrupted.map(({ session }) => session.sessionId)),
    );
    for (const { session, invocation, transcript } of interrupted) {
      expect(await harness.registry.get(session.sessionId)).toMatchObject({
        lifecycle: "closed",
        status: "archived",
        closeReceipts: [expect.objectContaining({ incarnation: 1 })],
      });
      const retained = harness.invocations.require(invocation.invocationId);
      expect(retained).toMatchObject({
        payloadRedactedAt: expect.any(String),
      });
      expect(retained).not.toHaveProperty("prompt");
      expect(retained).not.toHaveProperty("task");
      expect(retained).not.toHaveProperty("result");
      await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await restarted.reconcile({ workspaceIds: ["ws-test"] });
    for (const { session } of interrupted) {
      expect((await harness.registry.get(session.sessionId))?.archiveHistory).toHaveLength(1);
      expect((await harness.registry.get(session.sessionId))?.closeReceipts).toHaveLength(1);
    }
    harness.close();
  });

  it("runs structured children while the single root worker is saturated", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-session-supervisor-structured-"));
    roots.push(root);
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    let structuredTask: unknown;
    let releaseParent!: () => void;
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const scheduler = new SparkInvocationScheduler({
      store: invocations,
      concurrency: 1,
      executeTask: async (task) => {
        if (task.type === "session.run" && task.prompt === "hold parent") await parentGate;
        if (task.type === "session.run" && task.prompt === "execute child") {
          structuredTask = task;
        }
        return { answer: task.type === "session.run" ? task.prompt : task.type };
      },
    });
    const registry = createDaemonSessionRegistry(root, {
      resolveWorkspaceCwd: () => root,
    });
    const supervisor = new SessionSupervisor({ registry, invocations, scheduler });
    const administrator = await supervisor.ensureWorkspaceAdministrator("ws-test");
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
    const child = await supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: administrator.sessionId,
      owner: { kind: "role_call", ref: parent.invocationId },
      sessionId: "structured-child",
      purpose: "role_call",
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
    expect(structuredTask).toMatchObject({
      sessionId: child.sessionId,
      workspaceId: "ws-test",
    });
    expect(invocations.require(parent.invocationId).status).toBe("running");
    releaseParent();
    await scheduler.wait({ timeoutMs: 1_000 });
    db.close();
  });

  it("waits for Invocation delivery before discarding an owned Session", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: { kind: "task_run", ref: "run:delivery" },
      sessionId: "owned-delivery",
      purpose: "task_run",
    });
    const invocation = harness.invocations.submit({
      sessionId: owned.sessionId,
      prompt: "private payload",
      task: {
        type: "session.run",
        sessionId: owned.sessionId,
        workspaceId: "ws-test",
        prompt: "private payload",
      },
    });
    harness.invocations.claimNext("delivery-worker");
    const event = harness.invocations.appendEvent(invocation.invocationId, "result", {
      text: "private result",
    });
    harness.invocations.complete(invocation.invocationId, { status: "succeeded" });
    expect(harness.invocations.pendingDeliveries("hub:test")).toHaveLength(1);
    const acknowledge = delay(20).then(() => {
      harness.invocations.acknowledgeDelivery("hub:test", invocation.invocationId, event.sequence);
    });

    const closed = await harness.supervisor.close({
      sessionId: owned.sessionId,
      settleTimeoutMs: 250,
    });
    await acknowledge;

    expect(closed).toMatchObject({ lifecycle: "closed", status: "archived" });
    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      payloadRedactedAt: expect.any(String),
    });
    harness.close();
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
