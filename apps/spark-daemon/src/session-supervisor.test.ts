import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SparkRoleSpec } from "@zendev-lab/spark-protocol/role-session";
import { defaultSparkSessionRegistryRoot, SparkSessionRegistry } from "@zendev-lab/spark-session";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { ExecutionAttemptStore } from "./execution/state.ts";
import { quiesceLoopsForClosingSession } from "./loop-session-lifecycle.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { SparkLoopStore } from "./store/loops.ts";
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

  it("rejects an Invocation admission that loses to Session closing", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:closing-admission", root.sessionId),
      sessionId: "closing-admission",
      purpose: "task_run",
    });
    const admissionEntered = deferred<void>();
    const releaseAdmission = deferred<void>();
    const closingPersisted = deferred<void>();
    const releaseClose = deferred<void>();
    const supervisor = new SessionSupervisor({
      registry: {
        ...harness.registry,
        commitInvocationAdmission: async (sessionId, admit, now) => {
          admissionEntered.resolve();
          await releaseAdmission.promise;
          return await harness.registry.commitInvocationAdmission(sessionId, admit, now);
        },
        markClosing: async (input) => {
          const closing = await harness.registry.markClosing(input);
          closingPersisted.resolve();
          await releaseClose.promise;
          return closing;
        },
      },
      invocations: harness.invocations,
      ownerExists: async () => true,
    });

    const invoking = supervisor.invoke({
      invocationId: "inv_closing_admission",
      sessionId: owned.sessionId,
      prompt: "must not be admitted",
    });
    await admissionEntered.promise;
    const closing = supervisor.close({ sessionId: owned.sessionId });
    await closingPersisted.promise;
    releaseAdmission.resolve();

    await expect(invoking).rejects.toMatchObject({ code: "session_closing" });
    expect(harness.invocations.getSummary("inv_closing_admission")).toBeUndefined();
    releaseClose.resolve();
    await expect(closing).resolves.toMatchObject({ lifecycle: "closed", placement: "archived" });
    harness.close();
  });

  it("keeps one persistent Administrator root and instantiates owner-bound Role Sessions", async () => {
    const harness = await createHarness();
    const first = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const second = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    expect(second.sessionId).toBe(first.sessionId);
    expect(first).toMatchObject({
      lifecycle: "open",
      owner: { kind: "workspace", workspaceId: "ws-test" },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      purpose: "workspace_administrator",
    });
    harness.invocations.submit({
      invocationId: "inv-role",
      sessionId: first.sessionId,
      prompt: "own a Role call",
      task: { type: "session.run", sessionId: first.sessionId, prompt: "own a Role call" },
    });

    const owners = [
      { kind: "session", supervisorSessionId: first.sessionId },
      { kind: "invocation", invocationId: "inv-role", supervisorSessionId: first.sessionId },
      taskRunOwner("run:task", first.sessionId),
      taskRevisionOwner("task:revision:2", first.sessionId),
      workflowOwner("workflow:run", first.sessionId),
      driverOwner("driver:loop", first.sessionId),
      driverTickOwner("driver:tick:1", first.sessionId),
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
        lifecycle: "open",
        owner,
        retention: "discard_on_close",
        visibility: "internal",
        roleBinding: { kind: "explicit", roleRef: executorRole.ref },
      });
    }

    await expect(
      harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: administratorRole,
        parentSessionId: first.sessionId,
        owner: driverOwner("driver:invalid", first.sessionId),
        purpose: "invalid persistent owner",
      }),
    ).rejects.toMatchObject({ code: "session_owner_invalid" });
    await expect(
      harness.supervisor.instantiate({
        workspaceId: "ws-test",
        role: executorRole,
        parentSessionId: first.sessionId,
        owner: {
          kind: "invocation",
          invocationId: "inv-missing",
          supervisorSessionId: first.sessionId,
        },
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
      owner: taskRunOwner("run:owned", root.sessionId),
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
      placement: "archived",
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

  it("quiesces and redacts a Loop invocation routed to an uninstantiated child", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:loop-owner", root.sessionId),
      sessionId: "loop-owner",
      purpose: "task_run",
    });
    const loops = new SparkLoopStore(harness.db, harness.invocations);
    loops.start({
      loopId: "closing-owner-loop",
      ownerSessionId: owned.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "private Loop payload",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const advanced = await loops.materializeDue("2026-08-13T00:00:00.000Z");
    const invocation = advanced?.invocation;
    expect(invocation?.sessionId).toBeTruthy();
    expect(await harness.registry.get(invocation!.sessionId!)).toBeUndefined();
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
      quiesceOwnedLoops: (session, reason) =>
        quiesceLoopsForClosingSession(loops, harness.invocations, session, reason),
    });

    const closed = await supervisor.close({ sessionId: owned.sessionId });

    expect(closed).toMatchObject({ lifecycle: "closed", placement: "archived" });
    expect(loops.require("closing-owner-loop")).toMatchObject({ status: "stopped" });
    expect(harness.invocations.require(invocation!.invocationId)).toMatchObject({
      status: "cancelled",
      payloadRedactedAt: expect.any(String),
    });
    expect(harness.invocations.require(invocation!.invocationId)).not.toHaveProperty("prompt");
    expect(harness.invocations.require(invocation!.invocationId)).not.toHaveProperty("task");
    harness.close();
  });

  it("redacts a superseded Loop child route after the current pointer is cleared", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:superseded-loop-owner", root.sessionId),
      sessionId: "superseded-loop-owner",
      purpose: "task_run",
    });
    const loops = new SparkLoopStore(harness.db, harness.invocations);
    loops.start({
      loopId: "superseded-loop",
      ownerSessionId: owned.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "private historical payload",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const invocation = (await loops.materializeDue("2026-08-13T00:00:00.000Z"))?.invocation;
    if (!invocation?.sessionId) throw new Error("test Loop invocation has no Session route");
    loops.restart("superseded-loop", "new generation", "2026-08-13T00:00:01.000Z");
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
      quiesceOwnedLoops: (session, reason) =>
        quiesceLoopsForClosingSession(loops, harness.invocations, session, reason),
    });

    await supervisor.close({ sessionId: owned.sessionId });

    const retained = harness.invocations.require(invocation.invocationId);
    expect(retained).toMatchObject({ status: "cancelled", payloadRedactedAt: expect.any(String) });
    expect(retained).not.toHaveProperty("prompt");
    expect(retained).not.toHaveProperty("task");
    harness.close();
  });

  it("repairs Loop payloads left behind by an already closed owner", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const transcript = join(harness.root, "legacy-closed-loop.jsonl");
    await writeFile(transcript, '{"content":"legacy private transcript"}\n', "utf8");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:legacy-closed-loop", root.sessionId),
      sessionId: "legacy-closed-loop",
      purpose: "task_run",
      transcriptRef: transcript,
    });
    const loops = new SparkLoopStore(harness.db, harness.invocations);
    loops.start({
      loopId: "legacy-closed-loop-driver",
      ownerSessionId: owned.sessionId,
      sessionLifetime: "driver_tick",
      cwd: harness.root,
      prompt: "legacy private payload",
      dueAt: "2026-08-13T00:00:00.000Z",
    });
    const invocation = (await loops.materializeDue("2026-08-13T00:00:00.000Z"))?.invocation;
    if (!invocation?.sessionId) throw new Error("test Loop invocation has no Session route");
    await harness.registry.bindTranscriptPath({
      sessionId: owned.sessionId,
      sessionPath: transcript,
    });
    await harness.registry.markClosing({ sessionId: owned.sessionId });
    const legacyRegistry = new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(harness.root),
    });
    await legacyRegistry.finalizeClose(owned.sessionId);
    const restarted = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
      quiesceOwnedLoops: (session, reason) =>
        quiesceLoopsForClosingSession(loops, harness.invocations, session, reason),
    });

    const first = await restarted.reconcile({ workspaceIds: ["ws-test"] });

    expect(loops.require("legacy-closed-loop-driver")).toMatchObject({ status: "stopped" });
    const retained = harness.invocations.require(invocation.invocationId);
    expect(retained).toMatchObject({ status: "cancelled", payloadRedactedAt: expect.any(String) });
    expect(retained).not.toHaveProperty("prompt");
    expect(retained).not.toHaveProperty("task");
    const repaired = await harness.registry.get(owned.sessionId);
    expect(repaired?.closeReceipts).toHaveLength(1);
    expect(repaired).not.toHaveProperty("sessionPath");
    expect(repaired).not.toHaveProperty("transcriptRef");
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    expect(first.closedSessionIds).not.toContain(owned.sessionId);
    await restarted.reconcile({ workspaceIds: ["ws-test"] });
    expect((await harness.registry.get(owned.sessionId))?.closeReceipts).toHaveLength(1);
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
        owner: taskRunOwner("run:missing", root.sessionId),
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
      owner: taskRunOwner("run:invalid-completion", root.sessionId),
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
      owner: taskRunOwner("run:parent", root.sessionId),
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
      owner: taskRunOwner("run:persist-failure", root.sessionId),
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

  it("deletes a transcript bound after close starts and before content discard", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const transcript = join(harness.root, "late-bound.jsonl");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:late-bound", root.sessionId),
      sessionId: "late-bound",
      purpose: "task_run",
      retention: "discard_on_close",
    });
    const supervisor = new SessionSupervisor({
      registry: {
        ...harness.registry,
        markClosing: async (input) => {
          const closing = await harness.registry.markClosing(input);
          await writeFile(transcript, '{"content":"late secret"}\n', "utf8");
          await harness.registry.bindTranscriptPath({
            sessionId: owned.sessionId,
            sessionPath: transcript,
          });
          return closing;
        },
      },
      invocations: harness.invocations,
      ownerExists: async () => true,
    });

    const closed = await supervisor.close({ sessionId: owned.sessionId });

    expect(closed).toMatchObject({
      lifecycle: "closed",
      placement: "archived",
    });
    expect(closed).not.toHaveProperty("sessionPath");
    expect(closed).not.toHaveProperty("transcriptRef");
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    harness.close();
  });

  it("deletes both a legacy transcript ref and its relocated canonical path", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const legacyTranscript = join(harness.root, "legacy-transcript.jsonl");
    const canonicalTranscript = join(harness.root, "canonical-transcript.jsonl");
    await writeFile(legacyTranscript, '{"content":"legacy secret"}\n', "utf8");
    await writeFile(canonicalTranscript, '{"content":"canonical secret"}\n', "utf8");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:relocated-transcript", root.sessionId),
      sessionId: "relocated-transcript",
      purpose: "task_run",
      transcriptRef: legacyTranscript,
    });
    await harness.registry.bindTranscriptPath({
      sessionId: owned.sessionId,
      sessionPath: canonicalTranscript,
    });

    const closed = await harness.supervisor.close({ sessionId: owned.sessionId });

    expect(closed).not.toHaveProperty("sessionPath");
    expect(closed).not.toHaveProperty("transcriptRef");
    await expect(access(legacyTranscript)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(canonicalTranscript)).rejects.toMatchObject({ code: "ENOENT" });
    harness.close();
  });

  it("closes a Side Thread through the Supervisor without opening public archive mutation", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
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

    expect(closed).toMatchObject({ lifecycle: "closed", placement: "archived" });
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
      role: executorRole,
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

    expect(closedParent).toMatchObject({ lifecycle: "closed", placement: "archived" });
    const closedSideThread = await harness.registry.get(sideThread.sessionId);
    expect(closedSideThread).toMatchObject({
      lifecycle: "closed",
      placement: "archived",
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

  it("coalesces a recursive and direct close of one invocation-owned Session", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      sessionId: "concurrent-close-parent",
      purpose: "interactive",
      retention: "retain",
    });
    const transcript = join(harness.root, "concurrent-close-child.jsonl");
    await writeFile(transcript, '{"content":"private child secret"}\n', "utf8");
    const invocationId = "inv_concurrent_close_child";
    const child = await harness.supervisor.instantiateInvocationSession({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "concurrent-close-child",
      invocationId,
      purpose: "role_call",
      retention: "discard_on_close",
      transcriptRef: transcript,
    });
    await harness.supervisor.invoke({
      invocationId,
      sessionId: child.sessionId,
      prompt: "private child prompt",
    });
    harness.invocations.claimNext("concurrent-close-worker");
    harness.invocations.complete(invocationId, {
      status: "succeeded",
      result: { assistantText: "private child result" },
    });

    const childQuiesceEntered = deferred<void>();
    const releaseChildQuiesce = deferred<void>();
    let childArchiveCount = 0;
    let childQuiesceCount = 0;
    let childReceiptCount = 0;
    let childTranscriptDeleteCount = 0;
    const supervisor = new SessionSupervisor({
      registry: {
        ...harness.registry,
        archiveOwned: async (input) => {
          const closed = await harness.registry.archiveOwned(input);
          if (input.sessionId === child.sessionId) {
            childArchiveCount += 1;
          }
          return closed;
        },
        sealCloseReceipt: async (input) => {
          if (input.sessionId === child.sessionId) childReceiptCount += 1;
          return await harness.registry.sealCloseReceipt(input);
        },
      },
      invocations: harness.invocations,
      ownerExists: async () => true,
      quiesceOwnedLoops: async (session) => {
        if (session.sessionId === child.sessionId) {
          childQuiesceCount += 1;
          childQuiesceEntered.resolve();
          await releaseChildQuiesce.promise;
        }
        return { invocationSessionIds: [] };
      },
      deleteTranscript: async (path) => {
        if (path === transcript) childTranscriptDeleteCount += 1;
        await rm(path, { force: true });
      },
    });

    const parentClose = supervisor.close({ sessionId: parent.sessionId });
    await childQuiesceEntered.promise;
    const directChildClose = supervisor.close({
      sessionId: child.sessionId,
      completion: {
        source: "structured_outcome",
        status: "completed",
        code: "role_call_completed",
        summary: "Child completed with durable evidence.",
        evidenceRefs: ["evidence:child-close"],
        artifactRefs: ["artifact:child-output"],
        sourceInvocationIds: [invocationId],
      },
    });
    releaseChildQuiesce.resolve();
    const outcomes = await Promise.allSettled([parentClose, directChildClose]);

    expect(outcomes).toEqual([
      {
        status: "fulfilled",
        value: expect.objectContaining({
          sessionId: parent.sessionId,
          lifecycle: "closed",
          placement: "archived",
        }),
      },
      {
        status: "fulfilled",
        value: expect.objectContaining({
          sessionId: child.sessionId,
          lifecycle: "closed",
          placement: "archived",
        }),
      },
    ]);
    expect({
      childArchiveCount,
      childQuiesceCount,
      childReceiptCount,
      childTranscriptDeleteCount,
    }).toEqual({
      childArchiveCount: 1,
      childQuiesceCount: 1,
      childReceiptCount: 1,
      childTranscriptDeleteCount: 1,
    });
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.invocations.require(invocationId)).toMatchObject({
      payloadRedactedAt: expect.any(String),
    });
    const registryFile = JSON.parse(
      await readFile(join(harness.root, "session-registry", "v1", "registry.json"), "utf8"),
    ) as { sessions: Array<Record<string, unknown>> };
    const childRecords = registryFile.sessions.filter(
      (record) => record.sessionId === child.sessionId,
    );
    expect(childRecords).toEqual([
      expect.objectContaining({
        recordKind: "ephemeral_tombstone",
        lifecycle: "closed",
        placement: "archived",
        closeReceipts: [
          expect.objectContaining({
            incarnation: 1,
            source: "structured_outcome",
            quality: "semantic",
            evidenceRefs: ["evidence:child-close"],
            artifactRefs: ["artifact:child-output"],
            sourceInvocationIds: [invocationId],
          }),
        ],
      }),
    ]);
    await expect(supervisor.close({ sessionId: "never-created" })).rejects.toMatchObject({
      code: "session_not_found",
    });
    harness.close();
  });

  it("idempotently instantiates driver-owned child Sessions with explicit state binding", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const input = {
      sessionId: "driver-session",
      parentSessionId: root.sessionId,
      owner: driverOwner("loop:test", root.sessionId),
      stateBinding: { kind: "session", ref: root.sessionId } as const,
      purpose: "driver",
    };
    const first = await harness.supervisor.instantiateOwnedContext(input);
    const second = await harness.supervisor.instantiateOwnedContext(input);

    expect(second.sessionId).toBe(first.sessionId);
    expect(first).toMatchObject({
      owner: input.owner,
      stateBinding: input.stateBinding,
      visibility: "internal",
      retention: "discard_on_close",
    });
    harness.close();
  });

  it("validates a driver owner against the requested child Session identity", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owner = driverOwner("loop:validated", root.sessionId);
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async (candidateOwner, session) =>
        candidateOwner.kind === owner.kind &&
        candidateOwner.kind === "driver" &&
        candidateOwner.driverId === owner.driverId &&
        session.sessionId === "driver-session-validated" &&
        session.scope.kind === "workspace" &&
        session.scope.workspaceId === "ws-test",
    });

    await expect(
      supervisor.instantiateOwnedContext({
        sessionId: "driver-session-validated",
        parentSessionId: root.sessionId,
        owner,
        stateBinding: { kind: "session", ref: root.sessionId },
        purpose: "driver",
      }),
    ).resolves.toMatchObject({
      sessionId: "driver-session-validated",
      owner,
    });
    harness.close();
  });

  it("restores retained public scoped Sessions without replacing their transcript", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      sessionId: "interactive-admin",
      purpose: "interactive",
      visibility: "public",
      retention: "retain",
      transcriptRef: join(harness.root, "retained-transcript.jsonl"),
    });
    const child = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "restore-child",
      purpose: "role_call",
    });
    await harness.registry.archive(parent.sessionId);
    await harness.supervisor.reconcile();
    expect((await harness.registry.get(child.sessionId))?.lifecycle).toBe("closed");
    const restored = await harness.supervisor.restore(parent.sessionId);
    expect(restored.sessionId).toBe(parent.sessionId);
    expect(restored.incarnation).toBe(1);
    expect(restored.lifecycle).toBe("open");
    expect(restored.transcriptRef).toBe(parent.transcriptRef);
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
      owner: {
        kind: "invocation",
        invocationId: parentInvocation.invocationId,
        supervisorSessionId: root.sessionId,
      },
      sessionId: "orphan-role",
      purpose: "role_call",
    });
    harness.invocations.complete(parentInvocation.invocationId, { status: "succeeded" });
    const first = await harness.supervisor.reconcile({ workspaceIds: ["ws-test"] });
    expect(first.closedSessionIds).toContain(orphan.sessionId);
    const second = await harness.supervisor.reconcile({ workspaceIds: ["ws-test"] });
    expect(second.closedSessionIds).not.toContain(orphan.sessionId);
    expect(await harness.registry.get(orphan.sessionId)).toBeUndefined();
    const registryFile = JSON.parse(
      await readFile(join(harness.root, "session-registry", "v1", "registry.json"), "utf8"),
    ) as { sessions: Array<Record<string, unknown>> };
    expect(
      registryFile.sessions.find((record) => record.sessionId === orphan.sessionId),
    ).toMatchObject({
      recordKind: "ephemeral_tombstone",
      lifecycle: "closed",
      placement: "archived",
      owner: { kind: "invocation", invocationId: parentInvocation.invocationId },
    });
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
        owner: taskRunOwner(`run:${phase}`, root.sessionId),
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
        placement: "archived",
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
      executionAttemptStore: new ExecutionAttemptStore(db),
      executionOwnerHandlers: inertExecutionOwners,
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
      owner: {
        kind: "invocation",
        invocationId: parent.invocationId,
        supervisorSessionId: administrator.sessionId,
      },
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

  it("keeps a closing Session fenced until an abort-ignoring executor settles", async () => {
    const harness = await createHarness();
    const administrator = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: administrator.sessionId,
      owner: taskRunOwner("run:abort-ignore", administrator.sessionId),
      sessionId: "abort-ignore",
      purpose: "task_run",
    });
    const executorStarted = deferred<void>();
    const releaseExecutor = deferred<void>();
    const scheduler = new SparkInvocationScheduler({
      store: harness.invocations,
      executionAttemptStore: new ExecutionAttemptStore(harness.db),
      executionOwnerHandlers: inertExecutionOwners,
      executeTask: async () => {
        executorStarted.resolve();
        await releaseExecutor.promise;
        return { assistantText: "settled after cancellation" };
      },
    });
    const supervisor = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      scheduler,
      ownerExists: async () => true,
    });
    const invocation = await supervisor.invoke({
      sessionId: owned.sessionId,
      prompt: "ignore abort",
    });
    expect(scheduler.processBatch()).toBe(true);
    await executorStarted.promise;

    const firstClose = await supervisor.close({
      sessionId: owned.sessionId,
      completion: {
        source: "domain_completion",
        status: "completed",
        code: "task_run_completed",
        summary: "Task completed with durable evidence before its executor tail settled.",
        evidenceRefs: ["evidence:abort-ignore"],
        artifactRefs: ["artifact:abort-ignore"],
        sourceInvocationIds: [invocation.invocationId],
      },
      settleTimeoutMs: 0,
    });

    expect(harness.invocations.sessionActivity(owned.sessionId).active).toBe(false);
    expect(scheduler.isSessionActive(owned.sessionId)).toBe(true);
    expect(firstClose).toMatchObject({ lifecycle: "closing", placement: "active" });
    releaseExecutor.resolve();
    await scheduler.wait({ timeoutMs: 1_000 });
    await vi.waitFor(async () => {
      expect(await harness.registry.get(owned.sessionId)).toMatchObject({
        lifecycle: "closed",
        placement: "archived",
        closeReceipts: [
          expect.objectContaining({
            source: "domain_completion",
            quality: "semantic",
            evidenceRefs: ["evidence:abort-ignore"],
            artifactRefs: ["artifact:abort-ignore"],
            sourceInvocationIds: [invocation.invocationId],
          }),
        ],
      });
    });
    harness.close();
  });

  it("waits for Invocation delivery before discarding an owned Session", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:delivery", root.sessionId),
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

    expect(closed).toMatchObject({ lifecycle: "closed", placement: "archived" });
    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      payloadRedactedAt: expect.any(String),
    });
    harness.close();
  });

  it("retries legacy closed-content repair after Invocation delivery is acknowledged", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const transcript = join(harness.root, "legacy-delivery-blocked.jsonl");
    await writeFile(transcript, '{"content":"temporary content"}\n', "utf8");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:legacy-delivery-blocked", root.sessionId),
      sessionId: "legacy-delivery-blocked",
      purpose: "task_run",
      transcriptRef: transcript,
    });
    await harness.registry.bindTranscriptPath({
      sessionId: owned.sessionId,
      sessionPath: transcript,
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
    harness.invocations.claimNext("legacy-delivery-worker");
    const event = harness.invocations.appendEvent(invocation.invocationId, "result", {
      text: "private result",
    });
    harness.invocations.complete(invocation.invocationId, { status: "succeeded" });
    expect(harness.invocations.pendingDeliveries("hub:test")).toHaveLength(1);
    await harness.registry.markClosing({ sessionId: owned.sessionId });
    const legacyRegistry = new SparkSessionRegistry({
      rootDir: defaultSparkSessionRegistryRoot(harness.root),
    });
    await legacyRegistry.finalizeClose(owned.sessionId);
    const restarted = new SessionSupervisor({
      registry: harness.registry,
      invocations: harness.invocations,
      ownerExists: async () => true,
    });

    await restarted.reconcile({ workspaceIds: ["ws-test"] });
    expect(harness.invocations.require(invocation.invocationId)).not.toHaveProperty(
      "payloadRedactedAt",
    );
    await expect(access(transcript)).resolves.toBeUndefined();

    harness.invocations.acknowledgeDelivery("hub:test", invocation.invocationId, event.sequence);
    await restarted.repairClosedContentForInvocation(invocation.invocationId);

    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      payloadRedactedAt: expect.any(String),
    });
    expect(await harness.registry.get(owned.sessionId)).not.toHaveProperty("sessionPath");
    await expect(access(transcript)).rejects.toMatchObject({ code: "ENOENT" });
    harness.close();
  });

  it("finishes a delivery-blocked closing Session after the Invocation is acknowledged", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const owned = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      owner: taskRunOwner("run:delivery-blocked-close", root.sessionId),
      sessionId: "delivery-blocked-close",
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
    harness.invocations.claimNext("delivery-blocked-close-worker");
    const event = harness.invocations.appendEvent(invocation.invocationId, "result", {
      text: "private result",
    });
    harness.invocations.complete(invocation.invocationId, { status: "succeeded" });
    expect(harness.invocations.pendingDeliveries("hub:test")).toHaveLength(1);

    const closing = await harness.supervisor.close({
      sessionId: owned.sessionId,
      settleTimeoutMs: 0,
    });
    expect(closing.lifecycle).toBe("closing");

    harness.invocations.acknowledgeDelivery("hub:test", invocation.invocationId, event.sequence);
    await harness.supervisor.repairClosedContentForInvocation(invocation.invocationId);

    await expect(harness.registry.get(owned.sessionId)).resolves.toMatchObject({
      lifecycle: "closed",
      placement: "archived",
    });
    expect(harness.invocations.require(invocation.invocationId)).toMatchObject({
      payloadRedactedAt: expect.any(String),
    });
    harness.close();
  });

  it("resumes a closing parent after its delivery-blocked child closes", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      sessionId: "delivery-parent",
      purpose: "task_run",
      retention: "retain",
    });
    const child = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "delivery-child",
      purpose: "role_call",
    });
    const invocation = harness.invocations.submit({
      sessionId: child.sessionId,
      prompt: "private child payload",
      task: { type: "session.run", sessionId: child.sessionId, prompt: "private child payload" },
    });
    harness.invocations.claimNext("delivery-child-worker");
    const event = harness.invocations.appendEvent(invocation.invocationId, "result", {
      text: "private child result",
    });
    harness.invocations.complete(invocation.invocationId, { status: "succeeded" });
    expect(harness.invocations.pendingDeliveries("hub:test")).toHaveLength(1);

    const closing = await harness.supervisor.close({
      sessionId: parent.sessionId,
      settleTimeoutMs: 0,
    });
    expect(closing.lifecycle).toBe("closing");

    harness.invocations.acknowledgeDelivery("hub:test", invocation.invocationId, event.sequence);
    await harness.supervisor.repairClosedContentForInvocation(invocation.invocationId);

    await vi.waitFor(async () => {
      expect(await harness.registry.get(child.sessionId)).toMatchObject({ lifecycle: "closed" });
      expect(await harness.registry.get(parent.sessionId)).toMatchObject({ lifecycle: "closed" });
    });
    harness.close();
  });

  it("reconciles a closing tree from a stale parent-first startup snapshot", async () => {
    const harness = await createHarness();
    const root = await harness.supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = await harness.supervisor.instantiate({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: root.sessionId,
      sessionId: "startup-closing-parent",
      purpose: "task_run",
      retention: "retain",
    });
    const invocationId = "inv_startup_closing_child";
    const child = await harness.supervisor.instantiateInvocationSession({
      workspaceId: "ws-test",
      role: executorRole,
      parentSessionId: parent.sessionId,
      sessionId: "startup-closing-child",
      invocationId,
      purpose: "role_call",
    });
    await harness.supervisor.invoke({
      invocationId,
      sessionId: child.sessionId,
      prompt: "startup repair payload",
    });
    harness.invocations.claimNext("startup-closing-worker");
    harness.invocations.complete(invocationId, { status: "succeeded" });
    const closingAt = new Date("2026-08-13T02:00:00.000Z");
    await harness.registry.markClosing({ sessionId: child.sessionId, now: closingAt });
    await harness.registry.markClosing({ sessionId: parent.sessionId, now: closingAt });

    await expect(harness.supervisor.reconcile()).resolves.toMatchObject({
      closingSessionIds: [],
    });
    await expect(harness.supervisor.reconcile()).resolves.toBeDefined();
    expect(await harness.registry.get(parent.sessionId)).toMatchObject({ lifecycle: "closed" });
    expect(await harness.registry.get(child.sessionId)).toBeUndefined();
    harness.close();
  });
});

const inertExecutionOwners = {
  taskClaim: async () => ({}),
  humanInteraction: async () => ({}),
  loopSchedule: async () => ({}),
  loopStop: async () => ({}),
};

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function taskRunOwner(runRef: string, supervisorSessionId: string) {
  return {
    kind: "task_run" as const,
    supervisorSessionId,
    projectRef: "proj:test",
    taskRef: `task:${runRef}`,
    runRef,
    sessionGoalId: `goal:${runRef}`,
    roleRef: "role:builtin-executor",
    jobId: `job:${runRef}`,
    attempt: 1,
  };
}

function taskRevisionOwner(revisionRef: string, supervisorSessionId: string) {
  return {
    kind: "task_revision" as const,
    supervisorSessionId,
    projectRef: "proj:test",
    taskRef: `task:${revisionRef}`,
    revisionRef,
    originatingRunRef: `run:${revisionRef}`,
    sessionGoalId: `goal:${revisionRef}`,
    roleRef: "role:builtin-executor",
    jobId: `job:${revisionRef}`,
    attempt: 1,
  };
}

function workflowOwner(runRef: string, supervisorSessionId: string) {
  return {
    kind: "workflow_run" as const,
    workflowRef: "workflow:test",
    runRef,
    generation: 1,
    supervisorSessionId,
  };
}

function driverOwner(driverId: string, supervisorSessionId: string) {
  return { kind: "driver" as const, driverId, generation: 1, supervisorSessionId };
}

function driverTickOwner(tickInvocationId: string, supervisorSessionId: string) {
  return {
    kind: "driver_tick" as const,
    driverId: "driver:test",
    generation: 1,
    tickInvocationId,
    supervisorSessionId,
  };
}

const administratorRole = role({
  ref: "role:builtin-administrator",
  id: "administrator",
  modelType: "coordination",
  capabilities: ["read", "interact", "manage"],
});

const executorRole = role({
  ref: "role:builtin-executor",
  id: "executor",
  modelType: "implementation",
  capabilities: ["read", "write", "exec", "net"],
});

function role(
  input: Pick<SparkRoleSpec, "ref" | "id" | "modelType" | "capabilities">,
): SparkRoleSpec {
  return {
    ...input,
    source: "builtin",
    revision: `sha256:${"a".repeat(64)}`,
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
