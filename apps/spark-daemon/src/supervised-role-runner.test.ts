import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { SessionSupervisor } from "./session-supervisor.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";
import { createSupervisedRoleRunner } from "./supervised-role-runner.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("supervised Role runner", () => {
  it("projects RoleRun compatibility from an owned Session and redacted Invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-supervised-role-"));
    roots.push(root);
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const invocations = new SparkInvocationStore(db);
    const scheduler = new SparkInvocationScheduler({
      store: invocations,
      executeTask: async () => ({
        assistantText: "implemented by child",
        roleOutcome: {
          kind: "completed",
          code: "implementation_complete",
          reason: "focused change verified",
        },
      }),
    });
    const registry = createDaemonSessionRegistry(root, { resolveWorkspaceCwd: () => root });
    const supervisor = new SessionSupervisor({ registry, invocations, scheduler });
    const administrator = await supervisor.ensureWorkspaceAdministrator("ws-test");
    const parent = invocations.submit({
      invocationId: "inv-parent-role",
      sessionId: administrator.sessionId,
      prompt: "delegate",
      task: { type: "session.run", sessionId: administrator.sessionId, prompt: "delegate" },
    });
    invocations.claimNext("parent-worker");
    const run = createSupervisedRoleRunner({
      supervisor,
      workspaceId: "ws-test",
      parentSessionId: administrator.sessionId,
      parentInvocationId: parent.invocationId,
      cwd: root,
    });

    const result = await run({
      usageExecutionKind: "role_run",
      role: {
        ref: "role:builtin-executor",
        id: "executor",
        source: "builtin",
        revision: 3,
        systemPrompt: "Implement the bounded change.",
        capabilities: ["read", "write", "exec"],
        modelType: "implementation",
        instantiation: "owned",
        allowedTools: ["read", "edit"],
      },
      instruction: {
        roleRef: "role:builtin-executor",
        instruction: "Implement one focused change.",
      },
      record: {
        ref: "run:supervised-role",
        roleRef: "role:builtin-executor",
        instruction: "Implement one focused change.",
        status: "running",
      },
      cwd: root,
      timeoutMs: 5_000,
      model: "provider/model",
      requireStructuredOutcome: true,
    });

    expect(result).toMatchObject({
      record: {
        ref: "run:supervised-role",
        status: "succeeded",
        model: "provider/model",
        noSession: false,
        sessionPersistence: "persistent",
      },
      outcome: { kind: "completed", code: "implementation_complete" },
      stdout: "implemented by child",
    });
    const sessions = await registry.list({ includeArchived: true, includeSideThreads: true });
    const child = sessions.find((session) => session.roleRef === "role:builtin-executor");
    expect(child).toMatchObject({
      lifecycle: "closed",
      lifetime: "owned",
      owner: { kind: "role_call", ref: parent.invocationId },
      roleRevision: 3,
      modelType: "implementation",
      retention: "discard_on_close",
    });
    const childInvocation = invocations
      .listPage({ sessionId: child!.sessionId })
      .invocations.at(0)!;
    expect(childInvocation).toMatchObject({
      status: "succeeded",
      claimClass: "structured",
      payloadRedactedAt: expect.any(String),
      retentionSummary: {
        roleRef: "role:builtin-executor",
        roleRevision: 3,
        modelType: "implementation",
        runRef: "run:supervised-role",
        status: "succeeded",
      },
    });
    expect(childInvocation.prompt).toBeUndefined();
    expect(childInvocation.result).toBeUndefined();
    db.close();
  });
});
