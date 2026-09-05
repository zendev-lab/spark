import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { afterEach, describe, expect, it } from "vitest";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import { createDaemonSessionRegistry } from "./session-registry.ts";
import { createSparkDaemonSubagentHost } from "./spark-subagent-plugin.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

describe("daemon subagent host", () => {
  it("freezes official AgentOptions and returns the durable Invocation terminal", async () => {
    const fixture = await createFixture();
    const invocations = new SparkInvocationStore(fixture.db);
    const idle: string[] = [];
    const modelControl = {
      resolveSubagentOptions: async () => ({
        model: { providerName: "test", modelId: "child" },
        thinkingLevel: "high" as const,
        maxOutputTokens: 1024,
        enabledModels: [
          { provider: "test", model: "child" },
          { provider: "test", model: "reviewer" },
        ],
      }),
    } as unknown as SparkDaemonModelControl;
    const host = createSparkDaemonSubagentHost({
      db: fixture.db,
      registry: fixture.registry,
      modelControl,
      sparkHome: fixture.sparkHome,
      send: async (request) => {
        const invocation = invocations.submit({
          sessionId: request.sessionId,
          prompt: request.body,
        });
        invocations.claimNext("test-worker");
        invocations.complete(invocation.invocationId, {
          status: "succeeded",
          result: { assistantText: "review complete", stopReason: "stop" },
        });
        return { sessionId: request.sessionId, invocationId: invocation.invocationId };
      },
      cancel: () => undefined,
      waitForSessionIdle: async (sessionId) => {
        idle.push(sessionId);
      },
    });

    const started = await host.start({
      parentSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-executor",
      mode: "spawn",
      name: "Implementation",
      prompt: [{ type: "text", text: "Review the diff." }],
      agentOptions: {
        provider: "test",
        model: "child",
        reasoningEffort: "high" as never,
        maxTokens: 2048,
      },
      delegationDepth: 1,
      descriptor: { version: 3, mode: "one-shot", provider: "spawn" },
      signal: new AbortController().signal,
    });

    expect(await started.result).toEqual({
      output: [{ type: "text", text: "review complete" }],
      stopReason: "completed",
    });
    const child = await fixture.registry.get(started.sessionId);
    expect(child).toMatchObject({
      name: "Implementation",
      model: { providerName: "test", modelId: "child" },
      thinkingLevel: "high",
      maxOutputTokens: 1024,
      roleBinding: { kind: "explicit", roleRef: "role:builtin-executor" },
      lineage: {
        kind: "child",
        parentSessionId: fixture.administrator.sessionId,
        origin: { kind: "session" },
      },
    });
    const transcript = await readFile(child!.sessionPath!, "utf8");
    expect(transcript).toContain('"type":"subagent/descriptor"');
    expect(transcript).toContain('"provider":"spawn"');
    expect(transcript).toContain('"type":"subagent/model-selection-policy"');
    expect(transcript).toContain('"delegationDepth":1');
    await started.waitForIdle();
    expect(idle).toEqual([started.sessionId]);
  });

  it.each([
    { terminal: "length", expected: "max-tokens" },
    { terminal: "refusal", expected: "refusal" },
    { terminal: "failed", expected: "error" },
    { terminal: "cancelled", expected: "aborted" },
  ] as const)("maps durable $terminal Invocations to $expected", async ({ terminal, expected }) => {
    const fixture = await createFixture();
    const invocations = new SparkInvocationStore(fixture.db);
    const host = createSparkDaemonSubagentHost({
      db: fixture.db,
      registry: fixture.registry,
      modelControl: {
        resolveSubagentOptions: async () => ({
          model: { providerName: "test", modelId: "child" },
          thinkingLevel: "off" as const,
          maxOutputTokens: 256,
          enabledModels: [{ provider: "test", model: "child" }],
        }),
      } as unknown as SparkDaemonModelControl,
      sparkHome: fixture.sparkHome,
      send: async (request) => {
        const invocation = invocations.submit({
          sessionId: request.sessionId,
          prompt: request.body,
        });
        if (terminal === "cancelled") {
          invocations.requestCancellation(invocation.invocationId, "cancelled by test");
        } else {
          invocations.claimNext("test-worker");
          if (terminal === "failed") {
            invocations.complete(invocation.invocationId, {
              status: "failed",
              errorCode: "subagent_test_failure",
              errorMessage: "failed by test",
            });
          } else {
            invocations.complete(invocation.invocationId, {
              status: "succeeded",
              result: { assistantText: "terminal output", stopReason: terminal },
            });
          }
        }
        return { sessionId: request.sessionId, invocationId: invocation.invocationId };
      },
      cancel: (invocationId, reason) => {
        invocations.requestCancellation(invocationId, reason);
      },
      waitForSessionIdle: async () => undefined,
    });

    const run = await host.start({
      parentSessionId: fixture.administrator.sessionId,
      roleRef: "role:builtin-executor",
      mode: "spawn",
      prompt: [{ type: "text", text: "Run terminal mapping." }],
      delegationDepth: 1,
      descriptor: { version: 3, mode: "one-shot", provider: "spawn" },
      signal: new AbortController().signal,
    });

    await expect(run.result).resolves.toMatchObject({ stopReason: expected });
  });

  it("runs concurrent daemon-backed subagents to independent durable terminals", async () => {
    const fixture = await createFixture();
    const invocations = new SparkInvocationStore(fixture.db);
    const host = createSparkDaemonSubagentHost({
      db: fixture.db,
      registry: fixture.registry,
      modelControl: {
        resolveSubagentOptions: async () => ({
          model: { providerName: "test", modelId: "child" },
          thinkingLevel: "off" as const,
          maxOutputTokens: 256,
          enabledModels: [{ provider: "test", model: "child" }],
        }),
      } as unknown as SparkDaemonModelControl,
      sparkHome: fixture.sparkHome,
      send: async (request) => {
        const invocation = invocations.submit({
          sessionId: request.sessionId,
          prompt: request.body,
        });
        invocations.claimNext(`worker-${request.sessionId}`);
        invocations.complete(invocation.invocationId, {
          status: "succeeded",
          result: { assistantText: request.body, stopReason: "stop" },
        });
        return { sessionId: request.sessionId, invocationId: invocation.invocationId };
      },
      cancel: () => undefined,
      waitForSessionIdle: async () => undefined,
    });
    const signal = new AbortController().signal;

    const [first, second] = await Promise.all([
      host.start({
        parentSessionId: fixture.administrator.sessionId,
        roleRef: "role:builtin-executor",
        mode: "spawn",
        prompt: [{ type: "text", text: "first result" }],
        delegationDepth: 1,
        descriptor: { version: 3, mode: "one-shot", provider: "spawn" },
        signal,
      }),
      host.start({
        parentSessionId: fixture.administrator.sessionId,
        roleRef: "role:builtin-executor",
        mode: "spawn",
        prompt: [{ type: "text", text: "second result" }],
        delegationDepth: 1,
        descriptor: { version: 3, mode: "one-shot", provider: "spawn" },
        signal,
      }),
    ]);

    expect(first.sessionId).not.toBe(second.sessionId);
    await expect(Promise.all([first.result, second.result])).resolves.toEqual([
      { output: [{ type: "text", text: "first result" }], stopReason: "completed" },
      { output: [{ type: "text", text: "second result" }], stopReason: "completed" },
    ]);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "spark-subagent-host-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const cwd = await realpath(workspacePath);
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  const db = openSparkDaemonDatabase(paths);
  databases.push(db);
  const workspace = registerWorkspace(db, { localPath: cwd });
  const registry = createDaemonSessionRegistry(join(root, "registry"), {
    resolveWorkspaceCwd: (workspaceId) => (workspaceId === workspace.id ? cwd : undefined),
    resolveSessionCwd: async (input) => await resolveSessionCwdForWorkspaceId(db, input),
  });
  const administrator = await registry.ensureWorkspaceAdministrator(workspace.id);
  return { db, registry, administrator, sparkHome: paths.sessionRuntimeDir! };
}
