import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

import {
  SparkAgentSession,
  SparkSkillResolver,
  createSparkCliHostServices,
  sessionEntriesToAgentMessages,
  sessionEntriesToPromptItems,
  type SparkCliHostServices,
  type SparkCliHostServicesOptions,
  type SparkConfig,
} from "../host/index.ts";
import { createSparkMemoryDirectIntentTurnAuthority } from "@zendev-lab/spark-host/memory-direct-intent";
import { MODEL_EMPTY_RESPONSE_ERROR_CODE } from "@zendev-lab/spark-ai";
import type { SparkViewModelEvent } from "@zendev-lab/spark-protocol";
import {
  SPARK_PROMPT_ITEM_METADATA_KEY,
  SparkTurnRestartYieldError,
  isSparkTurnResumeCheckpointPersistable,
  type SparkTurnResumeCheckpoint,
} from "@zendev-lab/spark-turn";
import { assistantMessageToFinalAnswerText } from "../host/agent-session.ts";
import { sparkProviderRequestFitsContextWindow } from "../host/bootstrap.ts";
import { createSparkHeadlessRoleExecutor } from "../headless-role-executor.ts";
import {
  SparkNativeSession,
  SparkNativeTuiApp,
  createSparkNativeUiTransport,
} from "../native-tui.ts";
import type { TUI } from "@zendev-lab/spark-tui-adapter/pi-tui";

type FakeStreamSimple = (
  context: {
    messages?: unknown[];
  },
  options?: { maxTokens?: number },
) => AssistantMessage | Promise<AssistantMessage>;
type FakeProviderOptions = {
  streamSimple?: FakeStreamSimple;
  contextWindow?: number;
  maxTokens?: number;
};
type AssistantMessage = {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason: "stop";
  timestamp: number;
};

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function testContentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDoneStreamEvent(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "stream_event") return false;
  return isRecord(value.event) && value.event.type === "done";
}

type SessionMessageViewEvent = Extract<SparkViewModelEvent, { type: "session.message" }>;

function isSessionMessageViewEvent(event: SparkViewModelEvent): event is SessionMessageViewEvent {
  return event.type === "session.message";
}

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 120 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
}

test("provider request preflight includes the requested output budget", () => {
  assert.equal(sparkProviderRequestFitsContextWindow(4_000, 4_000, 8_000), true);
  assert.equal(sparkProviderRequestFitsContextWindow(4_001, 4_000, 8_000), false);
  assert.equal(sparkProviderRequestFitsContextWindow(7_999, 1, 8_000), true);
  assert.equal(sparkProviderRequestFitsContextWindow(8_000, 1, 8_000), false);
});

test("channel-facing assistant text excludes thinking, tool arguments, and commentary", () => {
  assert.equal(
    assistantMessageToFinalAnswerText({
      content: [
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "text",
          text: "先检查目录",
          textSignature: JSON.stringify({ phase: "commentary" }),
        },
        { type: "toolCall", name: "cue_exec", arguments: { command: "private" } },
        {
          type: "text",
          text: "检查完成",
          textSignature: JSON.stringify({ phase: "final_answer" }),
        },
      ],
    }),
    "检查完成",
  );
});

test("channel-facing assistant text does not turn a tool-use preamble into a reply", () => {
  assert.equal(
    assistantMessageToFinalAnswerText({
      stopReason: "toolUse",
      content: [
        { type: "text", text: "我先检查目录" },
        { type: "toolCall", name: "cue_exec", arguments: { command: "private" } },
      ],
    }),
    "",
  );
});

test("session replay retains runtime authority without promoting legacy custom data", () => {
  const entries = [
    {
      type: "custom_message" as const,
      id: "runtime-control",
      parentId: null,
      timestamp: "2026-07-15T00:00:00.000Z",
      customType: "runtime-policy",
      content: "policy <bounded>",
      display: false,
      details: {
        [SPARK_PROMPT_ITEM_METADATA_KEY]: {
          authority: "runtime_control",
          trust: "trusted",
          visibility: "hidden",
          persistence: "session",
        },
      },
    },
    {
      type: "custom_message" as const,
      id: "legacy-data",
      parentId: "runtime-control",
      timestamp: "2026-07-15T00:00:01.000Z",
      customType: "legacy-extension-data",
      content: "legacy payload",
      display: true,
    },
  ];

  const items = sessionEntriesToPromptItems(entries);
  assert.deepEqual(
    items.map(({ authority, trust, visibility, persistence }) => ({
      authority,
      trust,
      visibility,
      persistence,
    })),
    [
      {
        authority: "runtime_control",
        trust: "trusted",
        visibility: "hidden",
        persistence: "session",
      },
      {
        authority: "runtime_data",
        trust: "untrusted",
        visibility: "visible",
        persistence: "session",
      },
    ],
  );
  const lowered = sessionEntriesToAgentMessages(entries);
  assert.match(testContentText(lowered[0]?.content), /<spark_runtime_control trust="trusted"/u);
  assert.match(testContentText(lowered[0]?.content), /policy &lt;bounded&gt;/u);
  assert.match(testContentText(lowered[1]?.content), /<spark_runtime_data trust="untrusted"/u);
});

test("SparkAgentSession persists and resumes JSONL sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const viewEvents: SparkViewModelEvent[] = [];
    const services = await makeFakeServices({
      cwd,
      sparkHome,
      ui: { publishView: (event) => viewEvents.push(event) },
    });
    const session = new SparkAgentSession(services);

    const first = await session.run({
      sessionId: "session-a",
      prompt: "first",
      messageMetadata: {
        channel: { adapter: "infoflow", senderId: "platform-user" },
      },
    });
    assert.equal(first.sessionId, "session-a");
    assert.equal(first.newMessageCount, 2);
    assert.equal(first.assistantText, "count:1");

    const second = await session.run({ sessionId: "session-a", prompt: "second" });
    assert.equal(second.sessionPath, first.sessionPath);
    assert.equal(second.newMessageCount, 2);
    assert.equal(second.assistantText, "count:3");

    const record = await services.sessionStore.load(first.sessionPath);
    const messages = record.entries.filter((entry) => entry.type === "message");
    assert.equal(messages.length, 4);
    assert.deepEqual(
      messages.map((entry) => entry.message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.deepEqual(messages[0]?.message.metadata, {
      channel: { adapter: "infoflow", senderId: "platform-user" },
    });
    assert.equal(messages[1]?.message.metadata, undefined);
    assert.equal(messages[2]?.message.metadata, undefined);
    assert.equal(messages[3]?.message.metadata, undefined);
    assert.equal(
      viewEvents.some(
        (event) =>
          event.type === "session.message" &&
          event.sessionId === "session-a" &&
          event.message.role === "assistant",
      ),
      true,
    );
    assert.equal(
      viewEvents.some((event) => event.type === "run.update" && event.run.status === "succeeded"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession manual compact mutates the canonical record idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-manual-compact-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {},
      { compactKeepRecentTokens: 100 },
    );
    const record = services.sessionStore.createSession({ id: "manual-compact-session" });
    for (let index = 0; index < 8; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"canonical history ".repeat(100)}`,
      });
    }
    await services.sessionStore.save(record);
    const session = new SparkAgentSession(services);
    const filesBefore = await listSessionFileNames(services.sessionStore.sessionDir);

    const first = await session.compact({
      sessionId: record.header.id,
      sessionPath: record.path,
      operationId: "compact-operation-1",
      customInstructions: "preserve canonical decisions",
    });
    const replay = await session.compact({
      sessionId: record.header.id,
      sessionPath: record.path,
      operationId: "compact-operation-1",
      customInstructions: "preserve canonical decisions",
    });

    assert.equal(first.succeeded, true);
    assert.equal(first.replayed, false);
    assert.equal(replay.succeeded, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.compactionEntry?.id, first.compactionEntry?.id);
    const saved = await services.sessionStore.load(record.path);
    const compactions = saved.entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0]?.metadata?.operationId, "compact-operation-1");
    assert.match(compactions[0]?.summary ?? "", /preserve canonical decisions/u);
    assert.deepEqual(await listSessionFileNames(services.sessionStore.sessionDir), filesBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession auto compaction fires before the provider when reported usage undercounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-underreport-ambiguous-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    // Small window (8192) and modest output budget (512) so a handful of
    // oversized tool results push the char-based estimate past the window
    // while the provider-reported usage stays far below it. Two distinct user
    // turns keep the compaction cut summarizable: with a single turn there is
    // no history prefix before the last turn to summarize.
    const services = await makeFakeServices(
      { cwd, sparkHome },
      { contextWindow: 8_192, maxTokens: 512 },
      { compactKeepRecentTokens: 100 },
    );
    const compactEvents: Array<{ reason?: unknown }> = [];
    services.runtime.on("session_compact", (event) => {
      if (event && typeof event === "object") compactEvents.push(event as { reason?: unknown });
    });

    const record = services.sessionStore.createSession({ id: "preflight-underreport" });
    services.sessionStore.appendMessage(record, { role: "user", content: "start" });
    // The only provider report in the transcript is far below the char/4
    // estimate of the whole replay (three 20k-char tool results below).
    services.sessionStore.appendMessage(record, {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1_000, output: 50, cacheRead: 1_000, cacheWrite: 0 },
    });
    for (const toolCallId of ["read-call-0", "read-call-1"]) {
      services.sessionStore.appendMessage(record, {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(20_000) }],
      });
    }
    // A second user turn makes the full-compaction cut have summarizable
    // history before it; a lone single-turn transcript cannot be compacted
    // by the branch-cut algorithm.
    services.sessionStore.appendMessage(record, { role: "user", content: "mid" });
    services.sessionStore.appendMessage(record, {
      role: "toolResult",
      toolCallId: "read-call-2",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(20_000) }],
    });
    services.sessionStore.appendMessage(record, {
      role: "assistant",
      content: [{ type: "text", text: "next" }],
    });
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue",
    });

    // The run succeeds without hitting the hard provider preflight guard…
    assert.ok(result.outcome, "run must produce an outcome");
    assert.equal(result.outcome.status, "completed");
    // …because auto compaction fired BEFORE the provider request (reason "auto"
    // as the first session_compact event), never a failure-driven
    // "context_overflow" pass.
    assert.equal(compactEvents[0]?.reason, "auto");
    assert.equal(
      compactEvents.some((event) => event.reason === "context_overflow"),
      false,
      "auto compaction must trigger before the hard preflight rejects",
    );

    const saved = await services.sessionStore.load(record.path);
    assert.ok(
      saved.entries.some((entry) => entry.type === "compaction"),
      "preflight compaction must leave a durable compaction entry",
    );
    assert.equal(
      saved.entries.some(
        (entry) => entry.type === "custom_message" && entry.customType === "spark-runtime-failure",
      ),
      false,
      "no provider runtime failure may be persisted when auto compaction covers the turn",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("SparkAgentSession discards a measured low-yield repeated compact with a Memory checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-low-yield-compact-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let modelCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {},
      {
        compactKeepRecentTokens: 100,
        runCompactionModel: async () => {
          modelCalls += 1;
          return {
            version: 1,
            objective: "low yield summary ".repeat(5_000),
            completed: [],
            inProgress: [],
            decisions: [],
            changedFiles: [],
            commands: [],
            failures: [],
            preservedFacts: [],
            unresolved: [],
            memoryRefs: [],
          };
        },
      },
    );
    services.config.compact!.minUsefulReduction = 0.99;
    const lifecycle: Array<{ succeeded?: boolean }> = [];
    services.runtime.on("session_before_compact", () => ({
      message: {
        customType: "spark-memory-checkpoint",
        content: "Memory checkpoint appended after preparation.",
        display: false,
      },
    }));
    services.runtime.on("session_compact", (event) => {
      if (event && typeof event === "object") {
        lifecycle.push(event as { succeeded?: boolean });
      }
    });
    const record = services.sessionStore.createSession({ id: "low-yield-compact-session" });
    const firstKeptEntryId = services.sessionStore.appendMessage(record, {
      role: "user",
      content: "canonical history ".repeat(4_000),
    });
    services.sessionStore.appendMessage(record, {
      role: "assistant",
      content: "canonical answer ".repeat(4_000),
    });
    record.entries.push({
      type: "compaction",
      id: "existing-compaction",
      parentId: record.entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      summary: "existing compacted facts ".repeat(200),
      firstKeptEntryId,
      tokensBefore: 40_000,
    });
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).compact({
      sessionId: record.header.id,
      sessionPath: record.path,
      operationId: "low-yield-operation",
    });

    assert.equal(modelCalls, 1);
    assert.equal(result.succeeded, false);
    assert.equal(result.compactionEntry, undefined);
    assert.deepEqual(
      lifecycle.map((event) => event.succeeded),
      [false],
    );
    const saved = await services.sessionStore.load(record.path);
    assert.deepEqual(
      saved.entries.filter((entry) => entry.type === "compaction").map((entry) => entry.id),
      ["existing-compaction"],
    );
    assert.equal(
      saved.entries.some(
        (entry) =>
          entry.type === "custom_message" && entry.customType === "spark-memory-checkpoint",
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["stale-message", "cross-turn", "proposal-drift", "ambiguous", "replayed"] as const)(
  "SparkAgentSession rejects local feedback case %s before trusted telemetry",
  async (name) => {
    const dir = await mkdtemp(join(tmpdir(), `spark-agent-feedback-${name}-`));
    try {
      const cwd = join(dir, "repo");
      const sparkHome = join(dir, ".spark");
      await mkdir(cwd, { recursive: true });
      const services = await makeFakeServices({ cwd, sparkHome });
      const authority = createSparkMemoryDirectIntentTurnAuthority();
      const writer = vi.fn();
      services.memoryDirectIntentAuthority = {
        ...authority,
        clear() {},
        async issueFeedback(input) {
          if (name === "ambiguous") return undefined;
          const receipt = await authority.issueFeedback(input);
          if (!receipt) return undefined;
          if (name === "replayed") await authority.verifyCurrentFeedback(receipt);
          if (name === "stale-message") return { ...receipt, messageId: "message:stale" };
          if (name === "cross-turn") return { ...receipt, turnId: "turn:other" };
          if (name === "proposal-drift") return { ...receipt, memoryRef: "memory:drift" };
          return receipt;
        },
      };
      const result = await new SparkAgentSession(services).run({
        sessionId: `session-feedback-${name}`,
        prompt: "memory feedback positive memory:ranked",
      });
      const session = await services.sessionStore.load(result.sessionPath);
      const user = session.entries.find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
      const receipt =
        user?.type === "message"
          ? (user.message.metadata as Record<string, unknown> | undefined)?.memoryFeedback
          : undefined;
      const verified = await authority.verifyCurrentFeedback(receipt);
      if (verified.ok) writer();
      assert.deepEqual(verified, {
        ok: false,
        code:
          name === "stale-message"
            ? "MEMORY_FEEDBACK_STALE_MESSAGE"
            : name === "cross-turn"
              ? "MEMORY_FEEDBACK_CROSS_TURN"
              : name === "proposal-drift"
                ? "MEMORY_FEEDBACK_PROPOSAL_DRIFT"
                : name === "replayed"
                  ? "MEMORY_FEEDBACK_REPLAYED"
                  : "MEMORY_FEEDBACK_AMBIGUOUS",
      });
      assert.equal(writer.mock.calls.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("SparkAgentSession signs and persists one exact local direct-memory turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-direct-intent-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const result = await new SparkAgentSession(services).run({
      sessionId: "session-direct-intent",
      prompt: "remember: keep this exact local intent",
    });

    const record = await services.sessionStore.load(result.sessionPath);
    const user = record.entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    assert.equal(user?.type, "message");
    const receipt =
      user?.type === "message"
        ? (user.message.metadata as Record<string, unknown> | undefined)?.memoryDirectIntent
        : undefined;
    const receiptRecord = receipt as Record<string, unknown>;
    assert.equal(receiptRecord.surface, "tui");
    assert.equal(receiptRecord.workspaceId, cwd);
    assert.equal(receiptRecord.sessionId, "session-direct-intent");
    assert.equal(receiptRecord.operation, "remember");
    assert.match(String(receiptRecord.keyId), /^[a-f0-9]{64}$/u);
    assert.equal(typeof receiptRecord.signature, "string");
    assert.equal(JSON.stringify(receipt).includes("keep this exact local intent"), false);
    assert.equal(services.runtime.makeContext().memoryDirectIntent, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession restores a restart checkpoint without replaying its prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-restart-checkpoint-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let toolExecutions = 0;
    const fake = {
      streamSimple: () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            ...assistant(""),
            content: [
              {
                type: "toolCall",
                id: "restart-tool-call",
                name: "restart_probe",
                arguments: { value: "checkpoint" },
              },
            ],
            stopReason: "toolUse",
          } as unknown as AssistantMessage;
        }
        return assistant("continued after restart");
      },
    };
    const registerTool = (services: SparkCliHostServices) => {
      services.runtime.registerTool({
        name: "restart_probe",
        description: "restart checkpoint probe",
        parameters: { type: "object" },
        async execute(_id, parameters) {
          toolExecutions += 1;
          return {
            content: [
              {
                type: "text",
                text: `executed:${(parameters as { value?: string }).value ?? ""}`,
              },
            ],
          };
        },
      });
      services.runtime.setActiveTools([
        ...new Set([...services.runtime.getActiveTools(), "restart_probe"]),
      ]);
    };

    const predecessorServices = await makeFakeServices({ cwd, sparkHome }, fake);
    registerTool(predecessorServices);
    predecessorServices.runtime.on("before_agent_start", () => ({
      message: {
        customType: "restart-regenerated-context",
        content: "regenerate this transient context after restart",
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
    }));
    let checkpoint: SparkTurnResumeCheckpoint | undefined;
    await assert.rejects(
      new SparkAgentSession(predecessorServices).run({
        sessionId: "restart-checkpoint-session",
        prompt: "run once",
        messageMetadata: { request: "restart-checkpoint" },
        yieldForRestartIfRequested: (candidate) => {
          checkpoint = candidate;
          throw new SparkTurnRestartYieldError();
        },
      }),
      (error: unknown) => error instanceof SparkTurnRestartYieldError,
    );
    assert.ok(checkpoint);
    assert.equal(isSparkTurnResumeCheckpointPersistable(checkpoint), true);
    assert.equal(
      checkpoint.promptItems.every((item) => item.persistence === "session"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(checkpoint), /restart-regenerated-context/u);
    assert.equal(toolExecutions, 0);
    assert.equal(providerCalls, 1);

    const successorServices = await makeFakeServices({ cwd, sparkHome }, fake);
    registerTool(successorServices);
    const result = await new SparkAgentSession(successorServices).run({
      sessionId: "restart-checkpoint-session",
      prompt: "run once",
      resumeFromInterrupt: true,
      restartCheckpoint: checkpoint,
      messageMetadata: { request: "restart-checkpoint" },
    });

    assert.equal(result.outcome?.status, "completed");
    assert.equal(result.assistantText, "continued after restart");
    assert.equal(providerCalls, 2);
    assert.equal(toolExecutions, 1);
    const record = await successorServices.sessionStore.load(result.sessionPath);
    const messages = record.entries.filter((entry) => entry.type === "message");
    assert.deepEqual(
      messages.map((entry) => entry.message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.equal(
      messages.filter(
        (entry) => entry.message.role === "user" && entry.message.content === "run once",
      ).length,
      1,
    );
    assert.deepEqual(messages[0]?.message.metadata, { request: "restart-checkpoint" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession keeps daemon Loop transcripts out of public history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-driver-hidden-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const result = await new SparkAgentSession(services).run({
      sessionId: "driver_loop-hidden_1",
      prompt: "hidden tick",
      reset: true,
      sessionVisibility: "internal",
      sessionPurpose: "loop_tick",
    });

    const record = await services.sessionStore.load(result.sessionPath);
    assert.equal(record.header.visibility, "internal");
    assert.equal(record.header.purpose, "loop_tick");
    assert.deepEqual(await services.sessionStore.list(), []);
    assert.equal(await services.sessionStore.findById("driver_loop-hidden_1"), undefined);
    await assert.rejects(
      services.sessionStore.loadByRef(result.sessionPath),
      /Spark session not found/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession follows the authoritative transcript path across same-id generations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-generation-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerReplay = "";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        streamSimple: (context) => {
          providerReplay = JSON.stringify(context.messages);
          return assistant("generation two answer");
        },
      },
    );
    const sessionId = "same-id-side-thread";
    const reset = services.sessionStore.createSession({
      id: sessionId,
      timestamp: "2026-07-22T04:00:00.000Z",
    });
    services.sessionStore.appendMessage(reset, {
      role: "user",
      content: "fresh contextual seed",
      timestamp: Date.parse("2026-07-22T00:00:00.000Z"),
    });
    reset.entries.at(-1)!.timestamp = "2026-07-22T00:00:00.000Z";
    await services.sessionStore.save(reset);

    const stale = services.sessionStore.createSession({
      id: sessionId,
      timestamp: "2026-07-22T01:00:00.000Z",
    });
    services.sessionStore.appendMessage(stale, {
      role: "user",
      content: "stale generation exchange",
      timestamp: Date.parse("2026-07-22T03:00:00.000Z"),
    });
    stale.entries.at(-1)!.timestamp = "2026-07-22T03:00:00.000Z";
    await services.sessionStore.save(stale);

    assert.equal((await services.sessionStore.findById(sessionId))?.path, reset.path);
    const result = await new SparkAgentSession(services).run({
      sessionId,
      sessionPath: reset.path,
      prompt: "generation two prompt",
    });

    assert.equal(result.sessionPath, reset.path);
    assert.match(providerReplay, /fresh contextual seed/u);
    assert.doesNotMatch(providerReplay, /stale generation exchange/u);
    assert.doesNotMatch(
      JSON.stringify((await services.sessionStore.load(stale.path)).entries),
      /generation two prompt/u,
    );
    assert.match(
      JSON.stringify((await services.sessionStore.load(reset.path)).entries),
      /generation two prompt/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession continues from a persisted tool receipt after a terminal-less provider failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-terminal-less-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let toolExecutions = 0;
    const viewEvents: SparkViewModelEvent[] = [];
    const services = await makeFakeServices(
      { cwd, sparkHome, ui: { publishView: (event) => viewEvents.push(event) } },
      {
        streamSimple: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              ...assistant(""),
              content: [{ type: "toolCall", id: "once", name: "write_once", arguments: {} }],
              stopReason: "toolUse",
            } as unknown as AssistantMessage;
          }
          if (providerCalls === 2) {
            return {
              ...assistant(""),
              content: [],
              stopReason: "stop",
            } as unknown as AssistantMessage;
          }
          if (providerCalls === 3) {
            return {
              ...assistant(""),
              content: [],
              stopReason: "error",
              errorMessage: "opaque provider stream failure",
              code: "PROVIDER_STREAM_TERMINAL_LESS",
            } as unknown as AssistantMessage;
          }
          return assistant("continued from checkpoint");
        },
      },
    );
    services.runtime.registerTool({
      name: "write_once",
      description: "side effect probe",
      parameters: { type: "object" },
      async execute() {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "receipt:once" }] };
      },
    });
    services.runtime.setActiveTools([
      ...new Set([...services.runtime.getActiveTools(), "write_once"]),
    ]);

    const result = await new SparkAgentSession(services).run({
      sessionId: "terminal-less-session",
      prompt: "perform once",
    });
    assert.equal(result.outcome?.status, "completed");
    assert.equal(result.assistantText, "continued from checkpoint");
    assert.equal(providerCalls, 4);
    assert.equal(toolExecutions, 1);
    const record = await services.sessionStore.load(result.sessionPath);
    assert.deepEqual(
      record.entries.filter((entry) => entry.type === "message").map((entry) => entry.message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.equal(
      record.entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "spark-runtime-failure",
      ).length,
      2,
    );
    assert.equal(
      record.entries.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "spark-runtime-failure" &&
          (entry.details as { code?: unknown } | undefined)?.code ===
            "PROVIDER_STREAM_TERMINAL_LESS",
      ),
      true,
    );
    assert.equal(
      record.entries.some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "spark-runtime-failure" &&
          (entry.details as { code?: unknown } | undefined)?.code ===
            MODEL_EMPTY_RESPONSE_ERROR_CODE,
      ),
      true,
    );
    const assistantViews = viewEvents
      .filter(isSessionMessageViewEvent)
      .filter((event) => event.message.role === "assistant")
      .map((event) => event.message);
    assert.equal(
      assistantViews.some(
        (message) =>
          message.status === "error" &&
          String(message.text).includes("opaque provider stream failure"),
      ),
      true,
    );
    assert.equal(
      assistantViews.some(
        (message) =>
          message.status === "done" && String(message.text).includes("continued from checkpoint"),
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession automatically retries an empty model response with a bounded continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-empty-response-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        streamSimple: () => {
          providerCalls += 1;
          return providerCalls === 1
            ? ({ ...assistant(""), content: [], stopReason: "stop" } as AssistantMessage)
            : assistant("recovered from empty response");
        },
      },
    );

    const result = await new SparkAgentSession(services).run({
      sessionId: "empty-response-session",
      prompt: "return a visible answer",
    });
    assert.equal(result.outcome?.status, "completed");
    assert.equal(result.assistantText, "recovered from empty response");
    assert.equal(providerCalls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession exhausts empty-response continuation after three retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-empty-response-exhausted-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        streamSimple: () => {
          providerCalls += 1;
          return { ...assistant(""), content: [], stopReason: "stop" } as AssistantMessage;
        },
      },
    );

    const result = await new SparkAgentSession(services).run({
      sessionId: "empty-response-exhausted-session",
      prompt: "keep returning an empty response",
    });

    assert.equal(providerCalls, 4);
    assert.equal(result.outcome?.status, "failed");
    assert.equal(
      result.outcome?.status === "failed" ? result.outcome.errorCode : undefined,
      MODEL_EMPTY_RESPONSE_ERROR_CODE,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("SparkAgentSession retries an overloaded provider error instead of surfacing it immediately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-overload-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const overloaded =
      "server_error: Our servers are currently overloaded. Please try again later.";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        streamSimple: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              ...assistant("partial response"),
              content: [{ type: "text", text: "partial response" }],
              stopReason: "error",
              errorMessage: overloaded,
            } as unknown as AssistantMessage;
          }
          return assistant("recovered after overload");
        },
      },
    );

    const result = await new SparkAgentSession(services).run({
      sessionId: "overload-session",
      prompt: "continue despite overload",
    });

    assert.equal(result.outcome?.status, "completed");
    assert.equal(result.assistantText, "recovered after overload");
    assert.equal(providerCalls, 2);
    const saved = await services.sessionStore.load(result.sessionPath);
    assert.equal(JSON.stringify(saved.entries).includes(overloaded), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession compacts persisted history and retries context overflow with backoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 1_000_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            throw new Error(
              "Your input exceeds the context window of this model. Please adjust your input and try again.",
            );
          }
          return assistant(`recovered:${messages?.length ?? 0}`);
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "overflow-session" });
    for (let index = 0; index < 8; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"history ".repeat(100)}`,
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue after overflow",
    });

    assert.equal(providerCalls, 2);
    assert.equal(result.outcome?.status, "completed");
    assert.match(result.assistantText, /^recovered:/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 1);
    const persistedMessages = saved.entries.filter((entry) => entry.type === "message");
    assert.equal(
      persistedMessages.filter(
        (entry) =>
          entry.message.role === "user" && entry.message.content === "continue after overflow",
      ).length,
      1,
    );
    assert.equal(
      persistedMessages.some((entry) =>
        JSON.stringify(entry.message).includes("exceeds the context window"),
      ),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession checkpoints transient tool output before overflow recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-transient-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let toolExecutions = 0;
    const overflow =
      "Your input exceeds the context window of this model. Please adjust your input and try again.";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 258_000,
        maxTokens: 32_768,
        streamSimple: () => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              ...assistant(""),
              content: [
                {
                  type: "toolCall",
                  id: "large-tool-call",
                  name: "large_read",
                  arguments: {},
                },
              ],
              stopReason: "toolUse",
            } as unknown as AssistantMessage;
          }
          if (providerCalls === 2) throw new Error(overflow);
          return assistant("continued without replaying the tool");
        },
      },
      { compactKeepRecentTokens: 100 },
    );
    services.runtime.registerTool({
      name: "large_read",
      description: "return a large read-only result",
      parameters: { type: "object" },
      async execute() {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "large result ".repeat(80_000) }] };
      },
    });
    services.runtime.setActiveTools([
      ...new Set([...services.runtime.getActiveTools(), "large_read"]),
    ]);

    const result = await new SparkAgentSession(services).run({
      sessionId: "transient-overflow-session",
      prompt: "inspect once and continue",
    });

    assert.equal(providerCalls, 3);
    assert.equal(toolExecutions, 1);
    assert.equal(result.outcome?.status, "completed");
    assert.equal(result.assistantText, "continued without replaying the tool");
    const saved = await services.sessionStore.load(result.sessionPath);
    // Overflow recovery compacts the durable tool checkpoint; the assembled
    // system/tool envelope then proves that leaf still needs one more pass.
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 2);
    assert.equal(JSON.stringify(saved.entries).includes(overflow), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession repeats canonical compact without replaying tool side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-exact-repeated-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let toolExecutions = 0;
    const exactOverflow =
      'OpenAI API error (400): {"message":"invalid-argument: This model\'s maximum prompt length is 500000 but the request contains 500522 tokens. (request id: 2000010100000000000000000000000)","type":"api_error","param":"","code":null}';
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 1_000_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              ...assistant(""),
              content: [
                {
                  type: "toolCall",
                  id: "once-only-tool-call",
                  name: "once_only_read",
                  arguments: {},
                },
              ],
              stopReason: "toolUse",
            } as unknown as AssistantMessage;
          }
          if (providerCalls === 2 || providerCalls === 3) throw new Error(exactOverflow);
          const finalContext = JSON.stringify(messages);
          assert.match(finalContext, /authoritative tool receipt/u);
          assert.match(finalContext, /execute the read once and continue/u);
          assert.match(finalContext, /Memory checkpoint retained after repeated compaction/u);
          return assistant("recovered after two exact overflows");
        },
      },
      { compactKeepRecentTokens: 100 },
    );
    services.runtime.registerTool({
      name: "once_only_read",
      description: "read one receipt",
      parameters: { type: "object" },
      async execute() {
        toolExecutions += 1;
        return { content: [{ type: "text", text: "authoritative tool receipt" }] };
      },
    });
    services.runtime.setActiveTools([
      ...new Set([...services.runtime.getActiveTools(), "once_only_read"]),
    ]);
    services.runtime.on("session_before_compact", () => ({
      message: {
        customType: "spark-memory-checkpoint",
        content: "Memory checkpoint retained after repeated compaction.",
        display: false,
      },
    }));
    const record = services.sessionStore.createSession({ id: "exact-repeated-overflow-session" });
    for (let index = 0; index < 16; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"older canonical history ".repeat(120)}`,
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "execute the read once and continue",
    });

    assert.equal(result.outcome?.status, "completed");
    assert.equal(providerCalls, 4);
    assert.equal(toolExecutions, 1);
    const saved = await services.sessionStore.load(record.path);
    const compactions = saved.entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 2);
    assert.equal((compactions.at(-1)?.summary.length ?? Number.POSITIVE_INFINITY) < 2_000, true);
    assert.equal(
      saved.entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "execute the read once and continue",
      ).length,
      1,
    );
    assert.equal(JSON.stringify(saved.entries).includes(exactOverflow), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession resubmits one prompt across repeated overflow compactions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-repeated-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const overflow = "Your input exceeds the context window of this model.";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 1_000_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          if (providerCalls <= 2) throw new Error(overflow);
          return assistant(`recovered-twice:${messages?.length ?? 0}`);
        },
      },
      { compactKeepRecentTokens: 20_000 },
    );
    const record = services.sessionStore.createSession({ id: "repeated-overflow-session" });
    for (let index = 0; index < 16; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"history ".repeat(160)}`,
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue after repeated overflow",
    });

    assert.equal(providerCalls, 3);
    assert.equal(result.outcome?.status, "completed");
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 2);
    const persistedMessages = saved.entries.filter((entry) => entry.type === "message");
    assert.equal(
      persistedMessages.filter(
        (entry) =>
          entry.message.role === "user" &&
          entry.message.content === "continue after repeated overflow",
      ).length,
      1,
    );
    assert.equal(
      persistedMessages.some((entry) => JSON.stringify(entry.message).includes(overflow)),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession stops repeated overflow retry when compaction has no useful yield", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-no-yield-overflow-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 1_000_000,
        maxTokens: 4_096,
        streamSimple: () => {
          providerCalls += 1;
          throw new Error("Your input exceeds the context window of this model.");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "no-yield-overflow-session" });
    const firstMessage = services.sessionStore.appendMessage(record, {
      role: "user",
      content: "old context",
    });
    record.entries.push({
      type: "compaction",
      id: "short-summary",
      parentId: record.entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      summary: "already compacted",
      firstKeptEntryId: firstMessage,
      tokensBefore: 10,
    });
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "still too large",
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.outcome?.status, "failed");
    const saved = await services.sessionStore.load(record.path);
    assert.deepEqual(
      saved.entries.filter((entry) => entry.type === "compaction").map((entry) => entry.id),
      ["short-summary"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restricted SparkAgentSession runs declared reads but skips unclassified lifecycle writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-preflight-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome, allowedToolEffects: ["read"] },
      {
        contextWindow: 40_000,
        maxTokens: 4_096,
        streamSimple: () => {
          providerCalls += 1;
          return assistant("continued after preflight compaction");
        },
      },
    );
    let readLifecycleHooks = 0;
    services.runtime.on(
      "session_compact",
      () => {
        readLifecycleHooks += 1;
      },
      { effects: ["read"] },
    );
    services.runtime.on("session_compact", async () => {
      await writeFile(join(cwd, "forbidden-lifecycle-write"), "must not run", "utf8");
    });
    const record = services.sessionStore.createSession({ id: "preflight-session" });
    for (let index = 0; index < 80; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"history ".repeat(400)}`,
        ...(index === 79
          ? {
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
              },
            }
          : {}),
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue near the context limit",
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.outcome?.status, "completed");
    assert.equal(readLifecycleHooks, 1);
    assert.equal((await readdir(cwd)).includes("forbidden-lifecycle-write"), false);
    const saved = await services.sessionStore.load(record.path);
    const compactions = saved.entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0]?.metadata?.tokenSource, "estimated");
    assert.equal((compactions[0]?.metadata?.measuredReductionRatio ?? 0) > 0, true);
    assert.equal(
      saved.entries.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "continue near the context limit",
      ).length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession preflights the final system and tool request envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-final-envelope-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    const services = await makeFakeServices(
      { cwd, sparkHome, systemPrompt: "request scoped system ".repeat(1_800) },
      {
        contextWindow: 20_000,
        maxTokens: 1,
        streamSimple: () => {
          providerCalls += 1;
          return assistant("provider saw the compacted final envelope");
        },
      },
      { compactKeepRecentTokens: 1_000 },
    );
    services.runtime.registerTool({
      name: "final_envelope_probe",
      description: "provider-visible schema ".repeat(200),
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "unused" }] };
      },
    });
    services.runtime.setActiveTools([
      ...new Set([...services.runtime.getActiveTools(), "final_envelope_probe"]),
    ]);
    const record = services.sessionStore.createSession({ id: "final-envelope-session" });
    for (let index = 0; index < 12; index += 1) {
      services.sessionStore.appendMessage(record, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"persisted replay ".repeat(180)}`,
      });
    }
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue with final envelope accounting",
    });

    assert.equal(result.outcome?.status, "completed");
    // The first oversized attempt is rejected by Spark before streamSimple.
    assert.equal(providerCalls, 1);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(
      saved.entries.some((entry) => entry.type === "compaction"),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession explicitly clamps the provider output budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-output-clamp-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerMaxTokens: number | undefined;
    const services = await makeFakeServices(
      { cwd, sparkHome, systemPrompt: "s".repeat(18_000) },
      {
        contextWindow: 8_000,
        maxTokens: 4_000,
        streamSimple: (_context, options) => {
          providerMaxTokens = options?.maxTokens;
          return assistant("Spark clamped the output budget");
        },
      },
    );

    const result = await new SparkAgentSession(services).run({
      sessionId: "output-clamp-session",
      prompt: "continue",
    });

    assert.equal(result.outcome?.status, "completed");
    assert.notEqual(providerMaxTokens, undefined);
    assert.ok(providerMaxTokens! > 0);
    assert.ok(providerMaxTokens! < 4_000);
    const saved = await services.sessionStore.load(result.sessionPath);
    assert.equal(
      saved.entries.some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession persists and consumes a micro pass without forcing full compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-micro-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerReplay = "";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 22_000,
        maxTokens: 1,
        streamSimple: ({ messages }) => {
          providerReplay = JSON.stringify(messages);
          return assistant("continued after micro compaction");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "micro-session" });
    services.sessionStore.appendMessage(record, { role: "user", content: "inspect the log" });
    services.sessionStore.appendMessage(record, {
      role: "toolResult",
      toolName: "cue_exec",
      toolCallId: "micro-call",
      content: [{ type: "text", text: "same log line\n".repeat(5_000) }],
    });
    services.sessionStore.appendMessage(record, { role: "assistant", content: "log inspected" });
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue after the micro threshold",
    });

    assert.equal(result.outcome?.status, "completed");
    assert.doesNotMatch(providerReplay, /same log line\\nsame log line/u);
    assert.match(providerReplay, /previous line repeated 4999/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 0);
    const persistedTool = saved.entries.find(
      (entry) => entry.type === "message" && entry.message.toolCallId === "micro-call",
    );
    assert.match(
      JSON.stringify(persistedTool?.type === "message" ? persistedTool.message.content : ""),
      /previous line repeated 4999/u,
    );
    const telemetry = saved.entries.find(
      (entry) => entry.type === "custom" && entry.customType === "spark-compaction-micro",
    );
    const telemetryData =
      telemetry?.type === "custom"
        ? (telemetry.data as {
            type?: string;
            metadata?: { measuredReductionRatio?: number };
          })
        : undefined;
    assert.equal(telemetry?.type, "custom");
    assert.equal(telemetryData?.type, "micro");
    assert.equal((telemetryData?.metadata?.measuredReductionRatio ?? 0) > 0.4, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession full escalation summarizes the persisted micro replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-micro-full-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerReplay = "";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 25_000,
        maxTokens: 1,
        streamSimple: ({ messages }) => {
          providerReplay = JSON.stringify(messages);
          return assistant("continued after full escalation");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "micro-full-session" });
    services.sessionStore.appendMessage(record, {
      role: "user",
      content: `older durable request ${"o".repeat(30_000)}`,
    });
    services.sessionStore.appendMessage(record, {
      role: "assistant",
      content: `older durable answer ${"a".repeat(16_000)}`,
    });
    services.sessionStore.appendMessage(record, {
      role: "user",
      content: `recent durable request ${"u".repeat(48_000)}`,
    });
    services.sessionStore.appendMessage(record, {
      role: "toolResult",
      toolName: "cue_exec",
      toolCallId: "micro-full-call",
      content: [{ type: "text", text: "same log line\n".repeat(5_000) }],
    });
    services.sessionStore.appendMessage(record, { role: "assistant", content: "log inspected" });
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "continue after both passes",
    });

    assert.equal(result.outcome?.status, "completed");
    assert.doesNotMatch(providerReplay, /same log line\\nsame log line/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(
      saved.entries.filter(
        (entry) => entry.type === "custom" && entry.customType === "spark-compaction-micro",
      ).length,
      1,
    );
    const full = saved.entries.find((entry) => entry.type === "compaction");
    assert.ok(full);
    assert.doesNotMatch(
      full?.type === "compaction" ? full.summary : "",
      /same log line\nsame log line/u,
    );
    assert.equal(
      full?.type === "compaction" ? full.metadata?.fallbackReason : undefined,
      "model_unavailable",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentSession meters only the compacted replay on the active branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-replay-meter-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    let providerCalls = 0;
    let providerReplay = "";
    const services = await makeFakeServices(
      { cwd, sparkHome },
      {
        contextWindow: 50_000,
        maxTokens: 4_096,
        streamSimple: ({ messages }) => {
          providerCalls += 1;
          providerReplay = JSON.stringify(messages);
          return assistant("continued without redundant compaction");
        },
      },
    );
    const record = services.sessionStore.createSession({ id: "metered-replay-session" });
    record.entries.push(
      {
        type: "message",
        id: "root",
        parentId: null,
        timestamp: "2026-07-17T00:00:00.000Z",
        message: { role: "user", content: "root request" },
      },
      {
        type: "message",
        id: "inactive-branch",
        parentId: "root",
        timestamp: "2026-07-17T00:00:01.000Z",
        message: {
          role: "assistant",
          content: `inactive branch ${"x".repeat(200_000)}`,
          usage: { input: 45_000, cacheRead: 0, cacheWrite: 0 },
        },
      },
      {
        type: "message",
        id: "compacted-history",
        parentId: "root",
        timestamp: "2026-07-17T00:00:02.000Z",
        message: { role: "user", content: `already compacted ${"y".repeat(200_000)}` },
      },
    );
    let parentId = "compacted-history";
    for (let index = 0; index < 50; index += 1) {
      const id = `kept-${index}`;
      record.entries.push({
        type: "message",
        id,
        parentId,
        timestamp: `2026-07-17T00:01:${String(index).padStart(2, "0")}.000Z`,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `kept context ${index} ${"k".repeat(2_000)}`,
        },
      });
      parentId = id;
    }
    record.entries.push(
      {
        type: "compaction",
        id: "existing-compaction",
        parentId,
        timestamp: "2026-07-17T00:02:00.000Z",
        summary: "The earlier active history was already summarized.",
        firstKeptEntryId: "kept-0",
        tokensBefore: 75_000,
      },
      {
        type: "message",
        id: "post-compaction",
        parentId: "existing-compaction",
        timestamp: "2026-07-17T00:02:01.000Z",
        message: { role: "user", content: "continue from the compacted replay" },
      },
    );
    await services.sessionStore.save(record);

    const result = await new SparkAgentSession(services).run({
      sessionId: record.header.id,
      prompt: "one more turn",
    });

    assert.equal(providerCalls, 1);
    assert.equal(result.outcome?.status, "completed");
    assert.doesNotMatch(providerReplay, /inactive branch|already compacted/u);
    assert.match(providerReplay, /earlier active history was already summarized/u);
    const saved = await services.sessionStore.load(record.path);
    assert.equal(saved.entries.filter((entry) => entry.type === "compaction").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session replay strips stale usage before a compaction but retains later usage", () => {
  const usage = (totalTokens: number) => ({
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  const items = sessionEntriesToPromptItems([
    {
      type: "message",
      id: "kept-user",
      parentId: null,
      timestamp: "2026-07-17T00:00:00.000Z",
      message: { role: "user", content: "protected request" },
    },
    {
      type: "message",
      id: "kept-assistant",
      parentId: "kept-user",
      timestamp: "2026-07-17T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "protected answer" }],
        usage: usage(500_000),
      },
    },
    {
      type: "compaction",
      id: "compaction-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-17T00:00:02.000Z",
      summary: "compacted prefix",
      firstKeptEntryId: "kept-user",
      tokensBefore: 500_000,
    },
    {
      type: "message",
      id: "later-assistant",
      parentId: "compaction-boundary",
      timestamp: "2026-07-17T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "later answer" }],
        usage: usage(321),
      },
    },
  ]);
  const assistantMessages = items.flatMap((item) =>
    item.content.kind === "provider_message" && item.authority === "assistant"
      ? [item.content.message]
      : [],
  );

  assert.equal(assistantMessages.length, 2);
  assert.equal(assistantMessages[0]?.usage, undefined);
  assert.deepEqual(assistantMessages[1]?.usage, usage(321));
});

test("SparkAgentSession projects loop view events into native TUI transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-session-native-ui-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const nativeSession = new SparkNativeSession();
    const app = new SparkNativeTuiApp(fakeTui(), nativeSession, () => undefined);
    const services = await makeFakeServices({
      cwd,
      sparkHome,
      ui: createSparkNativeUiTransport(app, nativeSession),
    });

    const session = new SparkAgentSession(services);
    const result = await session.run({ sessionId: "native-ui-session", prompt: "hello" });

    assert.equal(result.sessionId, "native-ui-session");
    assert.match(stripAnsi(app.render(120).join("\n")), /count:1/);
    assert.equal((await services.sessionStore.findMostRecent())?.id, "native-ui-session");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark headless role executor supports forked session runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-fork-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const services = await makeFakeServices({ cwd, sparkHome });
    const parent = services.sessionStore.createSession({
      id: "parent-session",
      timestamp: "2026-06-03T08:00:00.000Z",
    });
    services.sessionStore.appendMessage(parent, { role: "user", content: "parent prompt" });
    services.sessionStore.appendMessage(parent, { role: "assistant", content: "parent answer" });
    await services.sessionStore.save(parent);

    let roleApprovalMethod: SparkCliHostServicesOptions["approvalMethod"];
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => {
        roleApprovalMethod = options.approvalMethod;
        return await makeFakeServices(options);
      },
    });
    const result = await executeRole({
      role: {
        ref: "role:test",
        id: "test",
        revision: "test-revision",
        systemPrompt: "You are a test role.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "continue from parent",
      },
      record: {
        ref: "run:forked",
        roleRef: "role:test",
        roleRevision: "test-revision",
        instruction: "continue from parent",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      launch: "forked",
      forkFromSession: "parent-session",
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal("launch" in result.record, false);
    assert.equal("forkFromSession" in result.record, false);
    assert.equal(roleApprovalMethod, "auto");
    assert.equal(result.stdout, "count:3");

    const child = await services.sessionStore.findById("spark-daemon-run:forked");
    assert.equal(child?.header.parentSession, parent.path);
    assert.equal(child?.entries.length, 4);
    assert.deepEqual(
      child?.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message.content),
      [
        "parent prompt",
        "parent answer",
        "continue from parent",
        [{ type: "text", text: "count:3" }],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark headless role executor forwards live events through onEvent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-events-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const streamed: unknown[] = [];
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });

    const result = await executeRole({
      role: {
        ref: "role:test",
        id: "test",
        revision: "test-revision",
        systemPrompt: "You are a streaming test role.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "emit events",
      },
      record: {
        ref: "run:events",
        roleRef: "role:test",
        roleRevision: "test-revision",
        instruction: "emit events",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      onEvent: (event) => {
        streamed.push(event);
      },
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal(streamed.length, result.jsonEvents.length);
    assert.equal(streamed.some(isDoneStreamEvent), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Spark headless role executor routes input control into a follow-up turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-input-control-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const firstStreamStarted = deferred<void>();
    const releaseFirstStream = deferred<void>();
    let streamCalls = 0;
    let controller: { send(text: string): void | Promise<void> } | undefined;
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) =>
        await makeFakeServices(options, {
          streamSimple: async (context) => {
            streamCalls += 1;
            if (streamCalls === 1) {
              firstStreamStarted.resolve();
              await releaseFirstStream.promise;
            }
            return assistant(`count:${context.messages?.length ?? 0}`);
          },
        }),
    });

    const resultPromise = executeRole({
      role: {
        ref: "role:test",
        id: "test",
        revision: "test-revision",
        systemPrompt: "You are a role with follow-up input.",
      },
      instruction: {
        roleRef: "role:test",
        instruction: "start work",
      },
      record: {
        ref: "run:input-control",
        roleRef: "role:test",
        roleRevision: "test-revision",
        instruction: "start work",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
      inputControl: {
        register(inputController) {
          controller = inputController;
          return () => {
            if (controller === inputController) controller = undefined;
          };
        },
      },
    });

    await firstStreamStarted.promise;
    assert.ok(controller);
    await controller.send("continue with follow-up context");
    releaseFirstStream.resolve();

    const result = await resultPromise;
    assert.equal(result.record.status, "succeeded");
    assert.equal(result.stdout, "count:3");
    assert.equal(streamCalls, 2);
    assert.equal(controller, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless adapter persists a transcript until Supervisor retention closes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-anon-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
    const executeRole = createSparkHeadlessRoleExecutor({
      sparkHome,
      createServices: async (options = {}) => await makeFakeServices(options),
    });
    const services = await makeFakeServices({ cwd, sparkHome });
    const before = await listSessionFileNames(services.sessionStore.sessionDir);

    const result = await executeRole({
      role: {
        ref: "role:builtin-reviewer",
        id: "reviewer",
        revision: "test-revision",
        systemPrompt: "You are a reviewer.",
      },
      instruction: { roleRef: "role:builtin-reviewer", instruction: "review anonymously" },
      record: {
        ref: "run:anonymous-reviewer",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "review anonymously",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    const after = await listSessionFileNames(services.sessionStore.sessionDir);
    assert.equal(after.length, before.length + 1);
    assert.equal(result.record.status, "succeeded");
    assert.equal("sessionLifetime" in result.record, false);
    assert.equal("sessionDir" in result.record, false);
    assert.ok(await services.sessionStore.findById("spark-daemon-run:anonymous-reviewer"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless Role adapter does not leak its transcript path into the receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-persistent-"));
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
        ref: "role:builtin-executor",
        id: "worker",
        revision: "test-revision",
        systemPrompt: "You are a worker.",
      },
      instruction: { roleRef: "role:builtin-executor", instruction: "persist role session" },
      record: {
        ref: "run:persistent-worker",
        roleRef: "role:builtin-executor",
        roleRevision: "test-revision",
        instruction: "persist role session",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    const services = await makeFakeServices({ cwd, sparkHome });
    const persisted = await services.sessionStore.findById("spark-daemon-run:persistent-worker");
    assert.equal(result.record.status, "succeeded");
    assert.equal("sessionLifetime" in result.record, false);
    assert.equal("sessionDir" in result.record, false);
    assert.equal(persisted?.header.cwd, cwd);
    assert.equal(persisted?.entries.filter((entry) => entry.type === "message").length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless adapter does not infer Session visibility from the Role id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-selector-"));
  try {
    const cwd = join(dir, "repo");
    const sparkHome = join(dir, ".spark");
    await mkdir(cwd, { recursive: true });
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
      instruction: { roleRef: "role:builtin-reviewer", instruction: "anonymous selector" },
      record: {
        ref: "run:selector-anonymous",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "anonymous selector",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });
    await executeRole({
      role: {
        ref: "role:builtin-executor",
        id: "worker",
        revision: "test-revision",
        systemPrompt: "You are a worker.",
      },
      instruction: { roleRef: "role:builtin-executor", instruction: "persistent selector" },
      record: {
        ref: "run:selector-persistent",
        roleRef: "role:builtin-executor",
        roleRevision: "test-revision",
        instruction: "persistent selector",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    const services = await makeFakeServices({ cwd, sparkHome });
    const selectorIds = (await services.sessionStore.list()).map((session) => session.id);
    assert.deepEqual(selectorIds, [
      "spark-daemon-run:selector-persistent",
      "spark-daemon-run:selector-anonymous",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ephemeral role run artifact records its lifetime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-headless-role-artifact-"));
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
      instruction: { roleRef: "role:builtin-reviewer", instruction: "record persistence" },
      record: {
        ref: "run:artifact-anonymous",
        roleRef: "role:builtin-reviewer",
        roleRevision: "test-revision",
        instruction: "record persistence",
        status: "queued",
      },
      cwd,
      timeoutMs: 1_000,
    });

    assert.equal(result.record.status, "succeeded");
    assert.equal("sessionLifetime" in result.record, false);
    assert.equal("sessionPath" in result.record, false);
    assert.equal("sessionDir" in result.record, false);
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

async function makeFakeServices(
  options: SparkCliHostServicesOptions,
  fake: FakeProviderOptions = {},
  testOptions: {
    compactKeepRecentTokens?: number;
    runCompactionModel?: SparkCliHostServices["runCompactionModel"];
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const isolatedSkillRoot = join(options.sparkHome ?? cwd, "test-skills");
  const skillResolver = new SparkSkillResolver({
    cwd,
    builtinDirs: [join(isolatedSkillRoot, "builtin")],
    workspaceDir: join(isolatedSkillRoot, "workspace"),
    workspaceAgentsDirs: [join(isolatedSkillRoot, "workspace-agents")],
    userDir: join(isolatedSkillRoot, "user"),
    userAgentsDir: join(isolatedSkillRoot, "user-agents"),
    skillDirs: [join(isolatedSkillRoot, "configured")],
  });
  const config: SparkConfig = {
    extensions: [],
    providers: ["fake-provider"],
    ...(testOptions.compactKeepRecentTokens === undefined
      ? {}
      : {
          compact: {
            enabled: true,
            microThreshold: 0.75,
            fullThreshold: 0.9,
            targetReduction: 0.4,
            minUsefulReduction: 0.05,
            compactModel: "current",
            reserveTokens: 16_384,
            keepRecentTokens: testOptions.compactKeepRecentTokens,
          },
        }),
  };
  if (options.sparkHome) {
    await mkdir(options.sparkHome, { recursive: true });
    await writeFile(join(options.sparkHome, "config.json"), `${JSON.stringify(config)}\n`, "utf8");
  }
  const services = await createSparkCliHostServices({
    ...options,
    config,
    extensions: [],
    providers: ["fake-provider"],
    providerImporter: async () => fakeProviderModule(fake),
    skillResolver,
  });
  assert.equal(services.skillResolver, skillResolver);
  // Tests opt into Smart compact explicitly; default bootstrap runner would call the
  // fake provider and change overflow/providerCall expectations.
  services.runCompactionModel = testOptions.runCompactionModel;
  return services;
}

function fakeProviderModule(fake: FakeProviderOptions = {}) {
  return {
    default(api: { registerProvider(name: string, config: unknown): void }) {
      api.registerProvider("fake-provider", {
        name: "Fake Provider",
        baseUrl: "https://fake.test",
        api: "openai-completions",
        streamSimple: (
          _model: unknown,
          context: { messages?: unknown[] },
          options?: { maxTokens?: number },
        ) => {
          let messagePromise: Promise<AssistantMessage> | undefined;
          const resolveMessage = async () => {
            messagePromise ??= Promise.resolve(
              fake.streamSimple?.(context, options) ??
                assistant(`count:${context.messages?.length ?? 0}`),
            );
            return await messagePromise;
          };
          return {
            async *[Symbol.asyncIterator]() {
              const message = await resolveMessage();
              yield { type: "done", reason: "stop", message };
            },
            result: async () => await resolveMessage(),
          };
        },
        models: [
          {
            id: "fake-model",
            name: "Fake Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: fake.contextWindow ?? 8192,
            maxTokens: fake.maxTokens ?? 4096,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
