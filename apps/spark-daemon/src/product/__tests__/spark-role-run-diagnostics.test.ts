import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { AssistantMessage } from "@zendev-lab/spark-llm-providers";
import { createSparkDshTurnTestRuntime } from "../host/agent-runtime/testing/dsh-runtime.ts";
import { SparkAgentSession, sessionRecordToPromptItems } from "../host/agent-session.ts";
import { createSparkHeadlessRoleExecutor } from "../headless-role-executor.ts";
import {
  createSparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
} from "../host/index.ts";
import { buildRoleRunFailureDiagnostic } from "@zendev-lab/spark-task-runtime";

test("empty-output Role Invocation failure records a lifecycle-neutral diagnostic", () => {
  const diagnostic = buildRoleRunFailureDiagnostic({
    result: {
      record: {
        ref: "run:empty-output",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "review",
        status: "failed",
        model: "fake/model",
      },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    },
    executorKind: "daemon-native",
    modelSelector: "fake/model",
    exitOrTimeout: "exit 1",
  });

  assert.equal(diagnostic.failureCategory, "empty_output");
  assert.equal(diagnostic.executorKind, "daemon-native");
  assert.equal(diagnostic.modelSelector, "fake/model");
  assert.equal("launch" in diagnostic, false);
  assert.equal(diagnostic.exitOrTimeout, "exit 1");
  assert.match(diagnostic.nextAction, /executor produced no stdout/);
});

test("native model parity diagnostic reports provider mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-model-parity-diagnostic-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: {
        ref: "role:builtin-reviewer",
        id: "reviewer",
        revision: "test-revision",
        systemPrompt: "You are a reviewer.",
      },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "model mismatch" },
      record: {
        ref: "run:model-mismatch",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "model mismatch",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      model: "openai-codex/gpt-5.5",
    });

    assert.equal(result.record.status, "failed");
    const eventText = JSON.stringify(result.jsonEvents);
    assert.match(eventText, /provider_resolution_failed/);
    assert.match(eventText, /openai-codex\/gpt-5\.5/);
    assert.match(eventText, /native Spark provider registry/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role-run diagnostic output redacts secrets", () => {
  const diagnostic = buildRoleRunFailureDiagnostic({
    result: {
      record: {
        ref: "run:secret",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "review",
        status: "failed",
      },
      stdout: "",
      stderr: "",
      jsonEvents: [],
    },
    executorKind: "daemon-native",
    modelSelector: "api_key=sk-test-secret token=tok-secret bearer=Bearer abc123",
    exitOrTimeout: "token=tok-secret",
  });
  const text = JSON.stringify(diagnostic);
  assert.doesNotMatch(text, /sk-test-secret|tok-secret|Bearer abc123/);
  assert.match(text, /<redacted>/);
});

test("anonymous diagnostics do not add persistent session selector entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-anon-diagnostics-selector-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const before = await listSessionFileNames(services.sessionStore.sessionDir);
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    await executeRole({
      role: {
        ref: "role:builtin-reviewer",
        id: "reviewer",
        revision: "test-revision",
        systemPrompt: "You are a reviewer.",
      },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "diagnostic mismatch" },
      record: {
        ref: "run:diagnostic-anonymous",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "diagnostic mismatch",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      model: "openai-codex/gpt-5.5",
    });

    const after = await listSessionFileNames(services.sessionStore.sessionDir);
    assert.deepEqual(after, before);
    assert.deepEqual(await services.sessionStore.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Channel hosts do not create Workspace Memory direct-intent authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-channel-memory-authority-"));
  try {
    const cwd = join(dir, "channel-workspace");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({
      cwd,
      sparkHome,
      sessionSurface: "channel",
      sessionSource: "channel",
      allowedTools: ["session", "ask", "context", "todo"],
    });

    assert.equal(services.memoryDirectIntentAuthority, undefined);
    assert.equal("memoryDirectIntent" in services.runtime.makeContext(), false);
    assert.equal("memoryFeedback" in services.runtime.makeContext(), false);
    await services.disposeLlm?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interrupted turns persist resume guidance as hidden runtime control and preserve user content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-resume-transcript-"));
  try {
    const cwd = join(dir, "repo");
    await mkdir(cwd);
    const services = await makeFakeServices({
      cwd,
      sparkHome: join(dir, "home"),
      allowedTools: [],
    });
    try {
      const session = new SparkAgentSession(services);
      const prompt = [{ type: "text" as const, text: "Resume my work" }];
      const result = await session.run({
        sessionId: "resume-transcript",
        prompt,
        resumeFromInterrupt: true,
      });
      assert.equal(result.outcome?.status, "completed", JSON.stringify(result.outcome));
      const record = await services.sessionStore.findById(result.sessionId);
      assert.ok(record);
      const persisted = sessionRecordToPromptItems(record);
      const user = persisted.filter((item) => item.authority === "user");
      assert.equal(user.length, 1);
      assert.equal(user[0]?.content.kind, "provider_message");
      if (user[0]?.content.kind === "provider_message")
        assert.deepEqual(user[0].content.message.content, prompt);
      const notice = persisted.find((item) => item.customType === "spark-daemon-resume");
      assert.equal(notice?.authority, "runtime_control");
      assert.equal(notice?.visibility, "hidden");
      assert.equal(notice?.trust, "trusted");
      assert.equal(notice?.persistence, "session");
    } finally {
      await services.disposeLlm?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function listSessionFileNames(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function makeFakeServices(options: SparkCliHostServicesOptions) {
  const config: SparkConfig = {
    providers: ["fake-provider"],
  };
  if (options.sparkHome) {
    await mkdir(options.sparkHome, { recursive: true });
    await writeFile(join(options.sparkHome, "config.json"), `${JSON.stringify(config)}\n`, "utf8");
  }
  const dshRuntime = await createSparkDshTurnTestRuntime(4);
  return await createSparkCliHostServices({
    ...options,
    dshContext: dshRuntime.ctx,
    config,
    providers: ["fake-provider"],
    providerImporter: async () => fakeProviderModule(),
  });
}

function fakeProviderModule() {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (_model: unknown, context: { messages?: unknown[] }) => {
          const message = assistant(`count:${context.messages?.length ?? 0}`);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "done", reason: "stop", message };
            },
            result: async () => message,
          };
        },
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 4096,
          },
        ],
      });
    },
  };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
