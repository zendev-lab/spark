import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SparkInvocationScheduler } from "./core/invocation-scheduler.ts";
import { ExecutionAttemptStore } from "./execution/state.ts";
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
  it.each(["role_run", "workflow_agent"] as const)(
    "projects %s compatibility from an ephemeral Session and redacted Invocation",
    async (usageExecutionKind) => {
      const root = await mkdtemp(join(tmpdir(), "spark-supervised-role-"));
      roots.push(root);
      const db = new DatabaseSync(":memory:");
      migrateSparkDaemonDatabase(db);
      const invocations = new SparkInvocationStore(db);
      const scheduler = new SparkInvocationScheduler({
        store: invocations,
        executionAttemptStore: new ExecutionAttemptStore(db),
        executionOwnerHandlers: {
          taskClaim: async () => ({}),
          humanInteraction: async () => ({}),
          loopSchedule: async () => ({}),
          loopStop: async () => ({}),
        },
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
        usageExecutionKind,
        role: {
          ref: "role:builtin-executor",
          id: "executor",
          source: "builtin",
          revision: `sha256:${"3".repeat(64)}`,
          systemPrompt: "Implement the bounded change.",
          capabilities: ["read", "write", "exec"],
          modelType: "implementation",
          allowedTools: ["read", "edit"],
        },
        instruction: {
          roleRef: "role:builtin-executor",
          instruction: "Implement one focused change.",
        },
        record: {
          ref: "run:supervised-role",
          roleRef: "role:builtin-executor",
          roleRevision: `sha256:${"3".repeat(64)}`,
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
        },
        outcome: { kind: "completed", code: "implementation_complete" },
        stdout: "implemented by child",
      });
      const sessions = await registry.list({
        includeArchived: true,
        includeClosed: true,
        includeSideThreads: true,
      });
      const child = sessions.find(
        (session) =>
          session.roleBinding.kind === "explicit" &&
          session.roleBinding.roleRef === "role:builtin-executor",
      );
      expect(child).toBeUndefined();
      const childInvocation = invocations
        .listPage({ limit: 100 })
        .invocations.find((invocation) => invocation.sessionId !== administrator.sessionId)!;
      const registryFile = JSON.parse(
        await readFile(join(root, "session-registry", "v1", "registry.json"), "utf8"),
      ) as { sessions: Array<Record<string, unknown>> };
      const tombstone = registryFile.sessions.find(
        (session) => session.sessionId === childInvocation.sessionId,
      );
      expect(tombstone).toMatchObject({
        recordKind: "ephemeral_tombstone",
        lifecycle: "closed",
        placement: "archived",
        owner: { kind: "invocation", supervisorSessionId: administrator.sessionId },
      });
      expect(tombstone).not.toHaveProperty("roleBinding");
      expect(tombstone?.closeReceipts).toEqual([
        expect.objectContaining({
          version: 1,
          source: "structured_outcome",
          quality: "semantic",
          status: "completed",
          code: "implementation_complete",
          summary: "implemented by child",
          incarnation: 1,
        }),
      ]);
      expect(childInvocation).toMatchObject({
        status: "succeeded",
        claimClass: "structured",
        payloadRedactedAt: expect.any(String),
        retentionSummary: {
          status: "succeeded",
          sourceKind: usageExecutionKind === "workflow_agent" ? "workflow_agent" : "role_call",
        },
      });
      expect(
        (tombstone?.closeReceipts as Array<{ sourceInvocationIds: string[] }>)[0]
          ?.sourceInvocationIds,
      ).toEqual([childInvocation.invocationId]);
      expect(childInvocation.prompt).toBeUndefined();
      expect(childInvocation.result).toBeUndefined();
      expect(invocations.invocationReceipt(childInvocation.invocationId)).toMatchObject({
        effectiveRoleRef: "role:builtin-executor",
        authorizationSource: {
          kind: "parent_invocation",
          ref: parent.invocationId,
        },
      });
      db.close();
    },
  );
});
