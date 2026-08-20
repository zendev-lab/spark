import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ToolCall,
} from "@zendev-lab/spark-llm";
import { defaultEvidenceStore } from "@zendev-lab/spark-artifacts";
import { registerSparkEvidenceTool } from "@zendev-lab/spark-artifacts/extension";
import {
  MODEL_EMPTY_RESPONSE_ERROR_CODE,
  TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
} from "@zendev-lab/spark-llm";
import { assertRef, type SparkHostDelegationEnvelope } from "@zendev-lab/spark-core";
import { SparkHostRuntime } from "@zendev-lab/spark-host";
import {
  SPARK_PROTOCOL_VERSION,
  type SparkDaemonEvent,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

import {
  SparkAgentLoop,
  estimateSparkProviderContextTokens,
  resolveSparkProviderOutputTokens,
  resolveSparkPromptCache,
  SparkTurnRestartYieldError,
  splitSparkSystemPrompt,
  type SparkBeforeToolCallsCheckpoint,
  type SparkAgentLoopEvent,
  type SparkAgentStreamFunction,
  type SparkRunOutcome,
  type SparkTurnLlm,
} from "./agent-loop.ts";
import { asSparkTurnLlm } from "./turn-llm.ts";
import { createSparkDshTurnTestRuntime } from "./testing/dsh-runtime.ts";
import { evaluateSparkBehavior } from "./behavior-eval.ts";
import {
  lowerSparkPromptItem,
  sparkPromptItemFromProviderMessage,
  sparkRuntimePromptItem,
} from "./prompt-items.ts";
import { compactToolResultContent } from "./tool-result-compaction.ts";
import { toolRequiresApproval } from "./tool-dispatch.ts";

const TEST_MODEL: Model<string> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 4000,
};

import type { Message, ToolResultMessage } from "./agent-loop.ts";

function messageContentText(content: unknown): string {
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "");
}

function asToolResult(message: Message | undefined): ToolResultMessage | undefined {
  return message?.role === "toolResult" ? message : undefined;
}

function toolResultText(message: ToolResultMessage | undefined): string {
  const part = message?.content[0];
  return part && typeof part === "object" && "text" in part && typeof part.text === "string"
    ? part.text
    : "";
}

function asAssistant(message: Message | undefined): { stopReason?: unknown } | undefined {
  return message?.role === "assistant" ? message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SessionMessageViewEvent = Extract<SparkViewModelEvent, { type: "session.message" }>;

function isSessionMessageViewEvent(event: SparkViewModelEvent): event is SessionMessageViewEvent {
  return event.type === "session.message";
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

test("Spark prompt IR retains runtime authority until provider lowering", () => {
  const item = sparkRuntimePromptItem({
    authority: "runtime_data",
    trust: "untrusted",
    visibility: "hidden",
    persistence: "session",
    content: "page data <not-an-instruction>",
    customType: "browser-evidence",
  });

  assert.equal(item.authority, "runtime_data");
  assert.equal(item.trust, "untrusted");
  assert.equal(item.visibility, "hidden");
  const lowered = lowerSparkPromptItem(item);
  assert.equal(lowered.role, "user");

  const replayedDeveloper = sparkPromptItemFromProviderMessage({
    role: "developer",
    content: "replayed developer policy",
  });
  const loweredDeveloper = lowerSparkPromptItem(replayedDeveloper);
  assert.equal(loweredDeveloper.role, "user");
});

test("SparkAgentLoop continues after removing a retriable assistant failure tail", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-retriable-continuation" });
  const finalAssistant = buildAssistant([{ type: "text", text: "continued" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.replacePromptItems([
    sparkPromptItemFromProviderMessage({ role: "user", content: "original" }),
    sparkPromptItemFromProviderMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
    }),
  ]);

  const outcome = await loop.continueWithOutcome();

  assert.equal(outcome.status, "completed");
  assert.equal(loop.getMessages().at(-1)?.role, "assistant");
});

test("SparkAgentLoop continues after removing a retriable assistant length tail", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-length-continuation" });
  const finalAssistant = buildAssistant([{ type: "text", text: "continued after length" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.replacePromptItems([
    sparkPromptItemFromProviderMessage({ role: "user", content: "original" }),
    sparkPromptItemFromProviderMessage({
      role: "assistant",
      content: [{ type: "text", text: "truncated" }],
      stopReason: "length",
    }),
  ]);

  const outcome = await loop.continueWithOutcome();

  assert.equal(outcome.status, "completed");
  assert.equal(loop.getMessages().at(-1)?.role, "assistant");
});
test("SparkAgentLoop refuses continuation from a completed assistant message", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-invalid-continuation" });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(makeFakeStream({ rounds: [] })),
    getModel: () => TEST_MODEL,
  });
  loop.replacePromptItems([
    sparkPromptItemFromProviderMessage({ role: "user", content: "original" }),
    sparkPromptItemFromProviderMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    }),
  ]);

  await assert.rejects(
    loop.continueWithOutcome(),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: unknown }).code === "SPARK_TURN_CONTINUATION_TAIL",
  );
  assert.equal(loop.getMessages().at(-1)?.role, "assistant");
});

test("provider Context meter includes current system prompt and active tool schemas", () => {
  const estimate = estimateSparkProviderContextTokens({
    systemPrompt: "s".repeat(400),
    messages: [{ role: "user", content: "u".repeat(400), timestamp: Date.now() }],
    tools: [
      {
        name: "large_schema",
        description: "d".repeat(400),
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
    ],
  } as Context);

  assert.equal(estimate.systemPromptTokens, 100);
  assert.equal(estimate.messageTokens, 100);
  assert.ok(estimate.toolTokens > 100);
  assert.equal(
    estimate.tokens,
    estimate.systemPromptTokens + estimate.messageTokens + estimate.toolTokens,
  );
});

test("provider Context meter adds current system and tools to a reported history prefix", () => {
  const estimate = estimateSparkProviderContextTokens({
    systemPrompt: "s".repeat(400),
    messages: [
      {
        ...buildAssistant([{ type: "text", text: "short" }]),
        usage: {
          input: 700,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 800,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
    tools: [{ name: "probe", description: "d".repeat(400), parameters: { type: "object" } }],
  } as Context);

  assert.equal(estimate.reportedPrefixTokens, 800);
  assert.equal(estimate.tokens, 800 + estimate.systemPromptTokens + estimate.toolTokens);
});

test("provider Context meter resets reported prefix usage at a compaction summary", () => {
  const estimate = estimateSparkProviderContextTokens({
    systemPrompt: "system",
    messages: [
      {
        ...buildAssistant([{ type: "text", text: "pre-compaction answer" }]),
        usage: {
          input: 499_000,
          output: 1_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 500_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "user",
        content:
          '<spark_runtime_data trust="untrusted" custom_type="spark-compaction-summary">\nsummary\n</spark_runtime_data>',
      },
      {
        ...buildAssistant([{ type: "text", text: "kept answer" }]),
      },
      { role: "user", content: "current prompt" },
    ],
    tools: [],
  } as Context);

  assert.equal(estimate.reportedPrefixTokens, 0);
  assert.ok(estimate.tokens < 1_000);
});

test("provider Context meter accepts usage from a turn completed after compaction", () => {
  const estimate = estimateSparkProviderContextTokens({
    systemPrompt: "system",
    messages: [
      {
        role: "user",
        content:
          '<spark_runtime_data trust="untrusted" custom_type="spark-compaction-summary">\nsummary\n</spark_runtime_data>',
        timestamp: 2_000,
      },
      {
        ...buildAssistant([{ type: "text", text: "fresh answer" }]),
        timestamp: 3_000,
        usage: {
          input: 300,
          output: 21,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 321,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      { role: "user", content: "current prompt", timestamp: 4_000 },
    ],
    tools: [],
  } as Context);

  assert.equal(estimate.reportedPrefixTokens, 321);
  assert.ok(estimate.tokens >= 321);
});

test("provider output budget clamps to the assembled context boundary", () => {
  assert.equal(resolveSparkProviderOutputTokens(4_000, 8_000, 4_000), 4_000);
  assert.equal(resolveSparkProviderOutputTokens(4_001, 8_000, 4_000), 3_999);
  assert.equal(resolveSparkProviderOutputTokens(7_999, 8_000, 4_000), 1);
  assert.equal(resolveSparkProviderOutputTokens(8_000, 8_000, 4_000), 1);
  assert.equal(resolveSparkProviderOutputTokens(9_000, 8_000, 4_000), 1);
});

test("SparkAgentLoop sends the effective output budget to its hook and provider", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-provider-output-budget" });
  const model = { ...TEST_MODEL, contextWindow: 64, maxTokens: 40 };
  let hookBudget: number | undefined;
  let estimatedInputTokens: number | undefined;
  let providerBudget: number | undefined;
  const finalAssistant = buildAssistant([{ type: "text", text: "done" }]);
  const loop = new SparkAgentLoop({
    host,
    getModel: () => model,
    systemPrompt: "s".repeat(160),
    beforeProviderRequest: ({ estimate, requestedOutputTokens }) => {
      estimatedInputTokens = estimate.tokens;
      hookBudget = requestedOutputTokens;
    },
    llm: asSparkTurnLlm((streamModel, context, options) => {
      providerBudget = options?.maxTokens;
      return makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
      })(streamModel, context, options);
    }),
  });

  const outcome = await loop.submitWithOutcome("u".repeat(40));

  assert.equal(outcome.status, "completed");
  assert.notEqual(estimatedInputTokens, undefined);
  assert.equal(
    hookBudget,
    resolveSparkProviderOutputTokens(estimatedInputTokens!, model.contextWindow, model.maxTokens),
  );
  assert.equal(providerBudget, hookBudget);
  assert.ok((providerBudget ?? 0) > 0);
  assert.ok((providerBudget ?? model.maxTokens) < model.maxTokens);
});

test("SparkAgentLoop runs final provider preflight after tool and prompt assembly", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-provider-preflight" });
  host.registerTool({
    name: "preflight_probe",
    description: "schema visible to final preflight",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  });
  host.setActiveTools(["preflight_probe"]);
  const requestScopedSystemPrompt = ["request", "scoped", "system", "prompt"].join("-");
  let streamCalls = 0;
  let observed:
    | {
        systemPrompt?: string;
        tools?: Array<{ name: string }>;
        messages: Array<{ role: string }>;
      }
    | undefined;
  const loop = new SparkAgentLoop({
    host,
    getModel: () => TEST_MODEL,
    systemPrompt: requestScopedSystemPrompt,
    llm: asSparkTurnLlm((...args) => {
      streamCalls += 1;
      return makeFakeStream({ rounds: [] })(...args);
    }),
    beforeProviderRequest: ({ context }) => {
      observed = context;
      throw new Error("preflight context window overflow");
    },
  });

  const outcome = await loop.submitWithOutcome("current user prompt");

  assert.equal(outcome.status, "failed");
  assert.equal(streamCalls, 0);
  assert.equal(observed?.systemPrompt, requestScopedSystemPrompt);
  assert.deepEqual(
    observed?.tools?.map((tool) => tool.name),
    ["preflight_probe"],
  );
  assert.equal(observed?.messages.at(-1)?.role, "user");
});

interface FakeStreamPlan {
  /** Each entry is one round-trip's events. The loop enqueues another round whenever
   *  the produced AssistantMessage has stopReason "toolUse" with toolCalls. */
  rounds: AssistantMessageEvent[][];
}

function buildAssistant(
  parts: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: parts,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeFakeStream(plan: FakeStreamPlan): SparkAgentStreamFunction {
  let round = 0;
  const fake: SparkAgentStreamFunction = (_model: Model<string>, _context: Context) => {
    const events = plan.rounds[round] ?? [];
    round += 1;
    let resolveResult: (value: AssistantMessage) => void = () => undefined;
    const resultPromise = new Promise<AssistantMessage>((resolve) => {
      resolveResult = resolve;
    });
    const iterable: AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<AssistantMessage>;
    } = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
          if (event.type === "done") resolveResult(event.message);
          if (event.type === "error") resolveResult(event.error);
        }
      },
      result: () => resultPromise,
    };
    return iterable;
  };
  return fake;
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("compactToolResultContent normalizes status whitespace with details", () => {
  const result = compactToolResultContent({
    toolName: "goal",
    content: [{ type: "text", text: "\n\nalpha\n\n\nbeta\n\n" }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "alpha\n\nbeta");
  assert.deepEqual(result.details, {
    profile: "status",
    level: "full",
    originalChars: 16,
    compactedChars: 11,
    trimmedLeadingBlankLines: 2,
    trimmedTrailingBlankLines: 2,
    collapsedBlankLines: 1,
    collapsedBlankRuns: 1,
    collapsedRepeatedLines: 0,
    collapsedRepeatedRuns: 0,
  });
});

test("compactToolResultContent supports diagnostic profile", () => {
  const result = compactToolResultContent({
    toolName: "spark_diagnostic",
    content: [{ type: "text", text: `error${"\n".repeat(80)}next` }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "error\n\n[78 blank lines collapsed]\nnext");
  assert.equal(result.details?.profile, "diagnostic");
  assert.equal(result.details?.collapsedBlankLines, 78);
  assert.equal(result.details?.collapsedRepeatedLines, 0);
});

test("compactToolResultContent collapses repeated log lines", () => {
  const result = compactToolResultContent({
    toolName: "cue_exec",
    content: [{ type: "text", text: `${"warning: noisy dependency\n".repeat(30)}done` }],
    level: "full",
  });

  assert.equal(
    result.content[0]?.text,
    "warning: noisy dependency\n[previous line repeated 29×]\ndone",
  );
  assert.equal(result.details?.collapsedRepeatedLines, 29);
  assert.equal(result.details?.collapsedRepeatedRuns, 1);
});

test("compactToolResultContent treats memory as compact status output", () => {
  const result = compactToolResultContent({
    toolName: "memory",
    content: [{ type: "text", text: "Memory status\n\n\n\n- active=1" }],
    level: "full",
  });

  assert.equal(result.content[0]?.text, "Memory status\n\n- active=1");
  assert.equal(result.details?.profile, "status");
});

test("compactToolResultContent preserves unknown tools by default", () => {
  const output = "alpha\n\n\n\nbeta";
  const result = compactToolResultContent({
    toolName: "third_party_tool",
    content: [{ type: "text", text: output }],
    level: "ultra",
  });

  assert.equal(result.content[0]?.text, output);
  assert.equal(result.details, undefined);
});

test("compactToolResultContent respects off level and never-worse fallback", () => {
  const output = "a\n\n\n\nb";
  assert.equal(
    compactToolResultContent({
      toolName: "cue_exec",
      content: [{ type: "text", text: output }],
      level: "off",
    }).content[0]?.text,
    output,
  );
  assert.equal(
    compactToolResultContent({
      toolName: "cue_exec",
      content: [{ type: "text", text: output }],
      level: "full",
    }).content[0]?.text,
    output,
  );
});

test("Spark prompt cache splits stable/dynamic prompt sections and honors disable switches", () => {
  const split = splitSparkSystemPrompt(
    [
      "Stable Spark operating rules.",
      "Current date: 2026-07-03\nCurrent working directory: /repo",
      "Dynamic context checkpoint: task-state-v2",
    ].join("\n\n"),
  );
  assert.equal(split.stablePrompt, "Stable Spark operating rules.");

  const enabled = resolveSparkPromptCache({
    systemPrompt: [split.stablePrompt, split.dynamicPrompt].join("\n\n"),
    sessionId: "session:abc",
    checkpoint: "manual refresh",
    env: {},
  });
  const repeated = resolveSparkPromptCache({
    systemPrompt: [split.stablePrompt, split.dynamicPrompt].join("\n\n"),
    sessionId: "session:abc",
    checkpoint: "manual refresh",
    env: {},
  });
  assert.equal(typeof enabled.promptCacheKey, "string");
  assert.equal(repeated.promptCacheKey, enabled.promptCacheKey);
  assert.ok((enabled.promptCacheKey?.length ?? Infinity) <= 64);
  assert.equal(enabled.disabledReason, undefined);

  const changedStablePrompt = resolveSparkPromptCache({
    systemPrompt: ["Changed stable operating rules.", split.dynamicPrompt].join("\n\n"),
    sessionId: "session:abc",
    checkpoint: "manual refresh",
    env: {},
  });
  const changedDynamicPrompt = resolveSparkPromptCache({
    systemPrompt: [
      split.stablePrompt,
      "Current date: 2026-07-04\nCurrent working directory: /other-repo",
    ].join("\n\n"),
    sessionId: "session:abc",
    checkpoint: "manual refresh",
    env: {},
  });
  assert.notEqual(changedStablePrompt.promptCacheKey, enabled.promptCacheKey);
  assert.equal(changedDynamicPrompt.promptCacheKey, enabled.promptCacheKey);

  const disabled = resolveSparkPromptCache({
    systemPrompt: split.stablePrompt,
    sessionId: "session:abc",
    env: { SPARK_PROMPT_CACHE_KEY: "off" },
  });
  assert.equal(disabled.promptCacheKey, undefined);
  assert.equal(disabled.disabledReason, "env");
});

test("Spark prompt cache keeps long session identities distinct within the provider limit", () => {
  const systemPrompt = "Stable Spark operating rules.";
  const sharedSessionPrefix = `session:${"shared-segment-".repeat(20)}`;
  const first = resolveSparkPromptCache({
    systemPrompt,
    sessionId: `${sharedSessionPrefix}first`,
    checkpoint: "manual refresh",
    env: {},
  });
  const second = resolveSparkPromptCache({
    systemPrompt,
    sessionId: `${sharedSessionPrefix}second`,
    checkpoint: "manual refresh",
    env: {},
  });

  for (const snapshot of [first, second]) {
    assert.equal(typeof snapshot.promptCacheKey, "string");
    assert.ok((snapshot.promptCacheKey?.length ?? Infinity) <= 64);
  }
  assert.notEqual(first.promptCacheKey, second.promptCacheKey);
});

test("SparkAgentLoop passes prompt_cache_key and reports cache usage summaries", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-cache-key-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const finalAssistant = buildAssistant([{ type: "text", text: "cached" }]);
  finalAssistant.usage.input = 40;
  finalAssistant.usage.output = 8;
  finalAssistant.usage.cacheRead = 128;
  finalAssistant.usage.cacheWrite = 32;
  finalAssistant.usage.totalTokens = 208;
  finalAssistant.usage.cost.total = 0.125;
  const calls: Array<{
    contextPromptCacheKey?: string;
    contextSystemPromptStable?: string;
    optionPromptCacheKey?: string;
    optionPromptCacheKeyCompat?: string;
  }> = [];
  const loopEvents: SparkAgentLoopEvent[] = [];
  host.registerTool({
    name: "read_manifest_probe",
    description: "read-only manifest probe",
    parameters: { type: "object" },
    policy: {
      effect: "read",
      executionMode: "parallel",
      domains: ["files"],
      modes: ["execute"],
      approval: "none",
    },
    async execute() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  });
  host.registerTool({
    name: "inactive_write_probe",
    description: "inactive write manifest probe",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "required" },
    async execute() {
      return { content: [{ type: "text", text: "unused" }] };
    },
  });
  host.setActiveTools(["read_manifest_probe"]);
  const streamFunction: SparkAgentStreamFunction = (_model, context, options) => {
    calls.push({
      contextPromptCacheKey: stringProperty(context, "promptCacheKey"),
      contextSystemPromptStable: stringProperty(context, "systemPromptStable"),
      optionPromptCacheKey: stringProperty(options, "promptCacheKey"),
      optionPromptCacheKeyCompat: stringProperty(options, "prompt_cache_key"),
    });
    return makeFakeStream({
      rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
    })(_model, context, options);
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(streamFunction),
    getModel: () => TEST_MODEL,
    systemPrompt: [
      "Stable Spark operating rules.",
      "Current date: 2026-07-03\nCurrent working directory: /repo",
    ].join("\n\n"),
    promptCache: { checkpoint: "session-start", env: {} },
    promptManifest: {
      promptVersion: "agent-loop-test-v1",
      getSelectedSkills: () => ["files", "testing", "files"],
    },
  });
  loop.setViewSessionId("session:cache-test");
  loop.onEvent((event) => loopEvents.push(event));

  const outcome = await loop.submitWithOutcome("use cache");

  assert.equal(typeof calls[0]?.contextPromptCacheKey, "string");
  assert.ok((calls[0]?.contextPromptCacheKey?.length ?? Infinity) <= 64);
  assert.equal(calls[0]?.contextSystemPromptStable, "Stable Spark operating rules.");
  assert.equal(calls[0]?.optionPromptCacheKeyCompat, calls[0]?.contextPromptCacheKey);
  assert.equal(calls[0]?.optionPromptCacheKey, calls[0]?.contextPromptCacheKey);
  assert.equal(
    viewEvents.some(
      (event) =>
        (event as { type?: string; run?: { summary?: string } }).type === "run.update" &&
        /cache read=128 write=32/.test(
          (event as { run?: { summary?: string } }).run?.summary ?? "",
        ),
    ),
    true,
  );
  const completedRun = viewEvents.find(
    (event) => event.type === "run.update" && event.run.status === "succeeded",
  );
  assert.ok(completedRun?.type === "run.update");
  assert.deepEqual(completedRun.run.metadata.usageTotals, {
    inputTokens: 40,
    outputTokens: 8,
    cacheReadTokens: 128,
    cacheWriteTokens: 32,
    costUsd: 0.125,
    latestCacheHitPercent: 64,
    contextTokens: 208,
    contextWindow: 8000,
  });
  const manifestEvents = loopEvents.filter(
    (event): event is Extract<SparkAgentLoopEvent, { type: "prompt_manifest" }> =>
      event.type === "prompt_manifest",
  );
  assert.equal(manifestEvents.length, 1);
  const manifest = manifestEvents[0]!.manifest;
  assert.equal(loop.getLastPromptManifest(), manifest);
  assert.equal(manifest.promptVersion, "agent-loop-test-v1");
  assert.deepEqual(manifest.selectedSkills, ["files", "testing"]);
  assert.deepEqual(manifest.tools, [
    {
      name: "read_manifest_probe",
      effect: "read",
      executionMode: "parallel",
      approval: "none",
      domains: ["files"],
      modes: ["execute"],
    },
  ]);
  assert.deepEqual(manifest.roundtrip, { index: 1 });
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /session:cache-test|Stable Spark operating rules|Current date: 2026-07-03/u,
  );
  const baseline = evaluateSparkBehavior(
    {
      id: "answer-only-runtime-baseline",
      allowedTools: [],
      expectedOutcomes: ["completed"],
      maxToolCalls: 0,
    },
    {
      manifest,
      toolCalls: [],
      outcome: outcome.status,
      roundtrips: outcome.roundtrips,
    },
  );
  assert.equal(baseline.passed, true);
  assert.equal(outcome.roundtrips, 1);
});

test("SparkAgentLoop applies one phase profile to schemas, manifests, and dispatch", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-phase-profile-test" });
  const lifecycleSources: unknown[] = [];
  host.on("before_agent_start", (event) => {
    lifecycleSources.push((event as { source?: unknown }).source);
  });
  let implementExecutions = 0;
  host.registerTool({
    name: "plan_probe",
    description: "available only while planning",
    parameters: { type: "object" },
    policy: { effect: "read", executionMode: "parallel", modes: ["plan"], approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "plan" }] };
    },
  });
  host.registerTool({
    name: "implement_action",
    description: "available only while implementing",
    parameters: { type: "object" },
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      modes: ["execute"],
      approval: "none",
    },
    async execute() {
      implementExecutions += 1;
      return { content: [{ type: "text", text: "implemented" }] };
    },
  });
  host.registerTool({
    name: "unphased_probe",
    description: "available in every phase",
    parameters: { type: "object" },
    policy: { effect: "read", executionMode: "parallel", approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "unphased" }] };
    },
  });

  const schemaToolNames: string[][] = [];
  const manifestToolNames: string[][] = [];
  const forgedPlanCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-forged",
    name: "implement_action",
    arguments: {},
  };
  const allowedImplementCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-allowed",
    name: "implement_action",
    arguments: {},
  };
  let modelCall = 0;
  const streamFunction: SparkAgentStreamFunction = (model, context, options) => {
    schemaToolNames.push((context.tools ?? []).map((tool: { name: string }) => tool.name));
    const call = modelCall;
    modelCall += 1;
    const message =
      call === 0
        ? buildAssistant([forgedPlanCall], "toolUse")
        : call === 2
          ? buildAssistant([allowedImplementCall], "toolUse")
          : buildAssistant([{ type: "text", text: `phase complete ${call}` }]);
    const event: AssistantMessageEvent =
      message.stopReason === "toolUse"
        ? { type: "done", reason: "toolUse", message }
        : { type: "done", reason: "stop", message };
    return makeFakeStream({ rounds: [[event]] })(model, context, options);
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(streamFunction),
    getModel: () => TEST_MODEL,
  });
  loop.onEvent((event) => {
    if (event.type === "prompt_manifest") {
      manifestToolNames.push(event.manifest.tools.map((tool) => tool.name));
    }
  });

  assert.equal(loop.getCurrentMode(), undefined);
  loop.setCurrentMode("plan");
  assert.equal(loop.getCurrentMode(), "plan");
  await loop.submit("plan without writes");

  assert.equal(implementExecutions, 0);
  assert.deepEqual(schemaToolNames[0], ["plan_probe", "unphased_probe"]);
  const rejected = asToolResult(
    loop
      .getMessages()
      .find((message) => message.role === "toolResult" && message.toolCallId === "tc-phase-forged"),
  );
  assert.equal(rejected?.isError, true);
  assert.match(toolResultText(rejected), /mode-inactive tool: implement_action/u);

  loop.setCurrentMode("execute");
  assert.equal(loop.getCurrentMode(), "execute");
  await loop.submit("implement now");

  assert.equal(implementExecutions, 1);
  assert.deepEqual(schemaToolNames[2], ["implement_action", "unphased_probe"]);
  const allowed = asToolResult(
    loop
      .getMessages()
      .find(
        (message) => message.role === "toolResult" && message.toolCallId === "tc-phase-allowed",
      ),
  );
  assert.equal(allowed?.isError, false);
  assert.deepEqual(manifestToolNames, schemaToolNames);
  assert.deepEqual(lifecycleSources, ["agentLoop", "agentLoop", "agentLoop", "agentLoop"]);
});

test("SparkAgentLoop rechecks phase availability after async approval", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-phase-approval-test",
    ui: {
      interaction: async (request) => ({
        version: SPARK_PROTOCOL_VERSION,
        kind: "toolApproval",
        requestId: request.requestId,
        status: "answered",
        approved: true,
        metadata: {},
      }),
    },
  });
  let executions = 0;
  host.registerTool({
    name: "approved_implement_action",
    description: "phase may change while approval is pending",
    parameters: { type: "object" },
    policy: {
      effect: "local_write",
      executionMode: "sequential",
      modes: ["execute"],
      approval: "required",
    },
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-phase-after-approval",
    name: "approved_implement_action",
    arguments: {},
  };
  let loop!: SparkAgentLoop;
  loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "phase changed" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    reviewToolApproval: async () => {
      loop.setCurrentMode("plan");
      return { outcome: "approved", summary: "approved before phase transition" };
    },
  });
  loop.setCurrentMode("execute");

  await loop.submit("approve then switch phase");

  assert.equal(executions, 0);
  const result = asToolResult(
    loop
      .getMessages()
      .find((message) => message.role === "toolResult" && message.toolCallId === toolCall.id),
  );
  assert.equal(result?.isError, true);
  assert.match(toolResultText(result), /mode-inactive tool: approved_implement_action/u);
});

test("SparkAgentLoop enforces action-resolved Fleet policy at dispatch", async () => {
  const run = async (action: "read" | "write") => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-fleet-policy-test" });
    let executions = 0;
    host.registerTool({
      name: "action_tool",
      description: "action-aware tool",
      parameters: { type: "object" },
      policy: {
        effect: "local_write",
        executionMode: "sequential",
        modes: ["plan", "execute", "fleet"],
        approval: "none",
      },
      resolvePolicy(args) {
        return args.action === "read"
          ? {
              effect: "read",
              executionMode: "parallel",
              modes: ["plan", "execute", "fleet"],
              approval: "none",
            }
          : {
              effect: "local_write",
              executionMode: "sequential",
              modes: ["execute"],
              approval: "none",
            };
      },
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: action }] };
      },
    });
    const call: ToolCall = {
      type: "toolCall",
      id: `tc-fleet-${action}`,
      name: "action_tool",
      arguments: { action },
    };
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [
            [{ type: "done", reason: "toolUse", message: buildAssistant([call], "toolUse") }],
            [
              {
                type: "done",
                reason: "stop",
                message: buildAssistant([{ type: "text", text: "done" }]),
              },
            ],
          ],
        }),
      ),
      getModel: () => TEST_MODEL,
    });
    loop.setCurrentMode("fleet");
    await loop.submit(action);
    const result = asToolResult(
      loop.getMessages().find((message) => message.role === "toolResult"),
    );
    return { executions, result };
  };

  const denied = await run("write");
  assert.equal(denied.executions, 0);
  assert.equal(denied.result?.isError, true);
  assert.match(toolResultText(denied.result), /mode-inactive tool: action_tool/u);

  const allowed = await run("read");
  assert.equal(allowed.executions, 1);
  assert.equal(allowed.result?.isError, false);
});

test("SparkAgentLoop forwards getReasoning into stream options.reasoning", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-reasoning-test" });
  const reasoningValues: unknown[] = [];
  const streamFunction: SparkAgentStreamFunction = (_model, _context, options) => {
    reasoningValues.push(isRecord(options) ? options.reasoning : undefined);
    return makeFakeStream({
      rounds: [
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "ok" }]),
          },
        ],
      ],
    })(_model, _context, options);
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(streamFunction),
    getModel: () => TEST_MODEL,
    getReasoning: () => "high",
  });

  await loop.submit("think carefully");

  assert.equal(reasoningValues[0], "high");
});

test("SparkAgentLoop supplies tools with the exact current delegation envelope", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-delegation-envelope-test",
    allowedToolEffects: ["read"],
  });
  let delegation: SparkHostDelegationEnvelope | undefined;
  host.registerTool({
    name: "delegation_probe",
    description: "capture the current delegation envelope",
    parameters: { type: "object" },
    policy: { effect: "read", executionMode: "parallel", approval: "none" },
    async execute(_id, _args, _signal, _onUpdate, ctx) {
      delegation = ctx.delegation;
      return { content: [{ type: "text", text: "captured" }] };
    },
  });
  host.registerTool({
    name: "blocked_write",
    description: "inactive under the host effect ceiling",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute() {
      return { content: [{ type: "text", text: "must not run" }] };
    },
  });
  const call: ToolCall = {
    type: "toolCall",
    id: "delegation-probe-call",
    name: "delegation_probe",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([call], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
    getReasoning: () => "high",
  });

  await loop.submit("capture delegation authority");

  assert.deepEqual(delegation, {
    model: { provider: "openai", id: "test-model", api: "openai-completions" },
    thinking: "high",
    activeTools: ["delegation_probe"],
    allowedToolEffects: ["read"],
  });
});

test("SparkAgentLoop runs a single-turn stop with one streamed text chunk", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello world" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello world", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  loop.onEvent((event) => events.push(event));

  const result = await loop.submit("hi");
  assert.equal(result?.stopReason, "stop");
  assert.equal(loop.getState(), "idle");
  assert.equal(host.isIdle(), true);
  assert.equal(loop.getMessages().length, 2, "user + assistant");
  const types = events.filter((event) => event.type !== "view_event").map((event) => event.type);
  assert.deepEqual(types.slice(0, 3), ["user_message", "prompt_manifest", "stream_event"]);
  assert.equal(events.find((event) => event.type === "turn_complete") !== undefined, true);
});

test("SparkAgentLoop times out a never-resolving model stream", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-stream-timeout-test" });
  const agentEndEvents: unknown[] = [];
  host.on("agent_end", (event) => agentEndEvents.push(event));
  const fake: SparkAgentStreamFunction = () =>
    ({
      async *[Symbol.asyncIterator]() {
        await new Promise<never>(() => undefined);
        yield undefined as never;
      },
      result: async () => await new Promise<never>(() => undefined),
    }) as ReturnType<SparkAgentStreamFunction>;
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    streamTimeoutMs: 10,
  });

  await loop.submit("hang stream");

  assert.equal(loop.getState(), "idle");
  assert.match(
    (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
    /Spark agent model stream timed out after 10ms/u,
  );
});

test("SparkAgentLoop projects user, streaming, final, and run updates to view-model events", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-view-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const events: SparkAgentLoopEvent[] = [];
  const finalMessage = buildAssistant([{ type: "text", text: "hello protocol" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: finalMessage },
        { type: "text_delta", contentIndex: 0, delta: "hello protocol", partial: finalMessage },
        { type: "done", reason: "stop", message: finalMessage },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  loop.setViewSessionId("session-view-loop");
  loop.onEvent((event) => events.push(event));

  await loop.submit("hi");

  const protocolEvents = events.filter((event) => event.type === "view_event");
  assert.equal(protocolEvents.length, viewEvents.length);
  assert.equal(
    viewEvents.some((event) => event.type === "run.update" && event.run.status === "running"),
    true,
  );
  assert.equal(
    viewEvents.some((event) => event.type === "run.update" && event.run.status === "succeeded"),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.sessionId === "session-view-loop" &&
        event.message.role === "assistant" &&
        event.message.status === "done" &&
        event.message.text === "hello protocol",
    ),
    true,
  );
});

test("SparkAgentLoop suppresses identical cumulative assistant stream projections", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-cumulative-dedup-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const partialStart = buildAssistant([{ type: "text", text: "same" }]);
  const partialComplete = buildAssistant([{ type: "text", text: "same cumulative text" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [
            { type: "start", partial: partialStart },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: " cumulative text",
              partial: partialComplete,
            },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "",
              partial: partialComplete,
            },
            { type: "done", reason: "stop", message: partialComplete },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("deduplicate the projection");

  const assistantMessages = viewEvents
    .filter(isSessionMessageViewEvent)
    .filter((event) => event.message.role === "assistant");
  assert.deepEqual(
    assistantMessages
      .filter((event) => event.message.status === "streaming")
      .map((event) => event.message.text),
    ["same", "same cumulative text"],
  );
  assert.equal(assistantMessages.filter((event) => event.message.status === "done").length, 1);
});

test("SparkAgentLoop projects an empty provider error as a visible terminal message", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-visible-error-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const errorAssistant = {
    ...buildAssistant([], "error"),
    errorMessage: "provider unavailable",
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "error", reason: "error", error: errorAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-visible-error");

  await loop.submit("hello");

  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "assistant" &&
        event.message.status === "error" &&
        event.message.text === "provider unavailable" &&
        event.message.metadata.errorMessage === "provider unavailable",
    ),
    true,
  );
});

test("SparkAgentLoop appends multi-roundtrip assistant messages in order without overwriting", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-order-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  host.registerTool({
    name: "noop",
    description: "noop",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-order",
    name: "noop",
    arguments: {},
  };
  const firstAssistant = buildAssistant(
    [{ type: "text", text: "before tool" }, toolCallEnvelope],
    "toolUse",
  );
  const secondAssistant = buildAssistant([{ type: "text", text: "after tool" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: firstAssistant },
        { type: "done", reason: "toolUse", message: firstAssistant },
      ],
      [
        { type: "start", partial: secondAssistant },
        { type: "done", reason: "stop", message: secondAssistant },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  loop.setViewSessionId("session-order-loop");

  await loop.submit("do it");

  const assistantMessages = viewEvents
    .filter(isSessionMessageViewEvent)
    .filter((event) => event.message.role === "assistant");
  const distinctIds = new Set(assistantMessages.map((event) => event.message.id));
  assert.equal(distinctIds.size, 2, "each roundtrip's assistant message gets its own view id");
  const doneTexts = assistantMessages
    .filter((event) => event.message.status === "done")
    .map((event) => event.message.text);
  assert.deepEqual(doneTexts, ["before tool", "after tool"]);
});

test("SparkAgentLoop projects thinking deltas on the stable assistant message", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-thinking-stream-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const started = buildAssistant([]);
  const thinking = buildAssistant([{ type: "thinking", thinking: "checking constraints" }]);
  const final = buildAssistant([
    { type: "thinking", thinking: "checking constraints" },
    { type: "text", text: "done" },
  ]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [
            { type: "start", partial: started },
            { type: "thinking_start", contentIndex: 0, partial: thinking },
            {
              type: "thinking_delta",
              contentIndex: 0,
              delta: "checking constraints",
              partial: thinking,
            },
            {
              type: "thinking_end",
              contentIndex: 0,
              content: "checking constraints",
              partial: thinking,
            },
            { type: "done", reason: "stop", message: final },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("think first");

  const assistantMessages = viewEvents
    .filter(isSessionMessageViewEvent)
    .filter((event) => event.message.role === "assistant");
  const thinkingUpdate = assistantMessages.find(
    (event) =>
      event.message.status === "streaming" &&
      event.message.parts?.some(
        (part: { type: string; text?: string }) =>
          part.type === "thinking" && part.text === "checking constraints",
      ),
  );
  assert.ok(thinkingUpdate, "thinking deltas should be projected before the final answer");
  const doneMessage = assistantMessages.find((event) => event.message.status === "done");
  assert.equal(doneMessage?.message.id, thinkingUpdate.message.id);
});

test("SparkAgentLoop terminalizes a partial assistant bubble when the stream throws", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-partial-error-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const partial = buildAssistant([{ type: "text", text: "partial answer" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial };
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial answer",
              partial,
            };
            throw new Error("provider disconnected");
          },
          result: async () => partial,
        }) as ReturnType<SparkAgentStreamFunction>,
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("stream then fail");

  const assistantMessages = viewEvents
    .filter(isSessionMessageViewEvent)
    .filter((event) => event.message.role === "assistant");
  assert.equal(new Set(assistantMessages.map((event) => event.message.id)).size, 1);
  assert.equal(assistantMessages.at(-1)?.message.status, "error");
  assert.equal(assistantMessages.at(-1)?.message.text, "partial answer");
  assert.equal(
    viewEvents.some((event) => event.type === "run.update" && event.run.status === "failed"),
    true,
  );
});

test("SparkAgentLoop preserves a stable provider error code on a thrown stream failure", async () => {
  const failure = Object.assign(new Error("opaque provider failure"), {
    code: TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE,
  });
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-provider-code" });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw failure;
              },
            };
          },
          result: async () => {
            throw failure;
          },
        }) as ReturnType<SparkAgentStreamFunction>,
    ),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("classify by code");
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") assert.fail("expected failed outcome");
  assert.equal(outcome.errorCode, TERMINAL_LESS_PROVIDER_STREAM_ERROR_CODE);
  assert.equal(outcome.errorMessage, "opaque provider failure");
});

test("SparkAgentLoop marks an empty terminal response with a stable transient code", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-empty-code" });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: buildAssistant([]) }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("empty response code");
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") assert.fail("expected failed outcome");
  assert.equal(outcome.errorCode, MODEL_EMPTY_RESPONSE_ERROR_CODE);
  assert.match(outcome.errorMessage, /without a displayable response/u);
});

test("SparkAgentLoop emits exactly one agent_end for terminal outcomes", async () => {
  const stopAssistant = buildAssistant([{ type: "text", text: "done" }]);
  const cases: Array<{
    name: string;
    llm: SparkTurnLlm;
    expectedError?: RegExp;
    expectedStopReason?: AssistantMessage["stopReason"];
    expectedStatus: SparkRunOutcome["status"];
  }> = [
    {
      name: "normal stop",
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [[{ type: "done", reason: "stop", message: stopAssistant }]],
        }),
      ),
      expectedStatus: "completed",
    },
    {
      name: "provider abort",
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [
            [
              {
                type: "error",
                reason: "aborted",
                error: buildAssistant([], "aborted"),
              },
            ],
          ],
        }),
      ),
      expectedStatus: "aborted",
      expectedStopReason: "aborted",
    },
    {
      name: "stream throws",
      llm: asSparkTurnLlm(
        () =>
          ({
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  throw new Error("stream boom");
                },
              };
            },
            result: async () => stopAssistant,
          }) as ReturnType<SparkAgentStreamFunction>,
      ),
      expectedError: /stream boom/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
    {
      name: "no assistant",
      llm: asSparkTurnLlm(
        () =>
          ({
            [Symbol.asyncIterator]() {
              return {
                next: async () => ({
                  done: true,
                  value: undefined as unknown as AssistantMessageEvent,
                }),
              };
            },
            result: async () => undefined as unknown as AssistantMessage,
          }) as ReturnType<SparkAgentStreamFunction>,
      ),
      expectedError: /stream produced no assistant message/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
    {
      name: "empty response",
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [[{ type: "done", reason: "stop", message: buildAssistant([]) }]],
        }),
      ),
      expectedError: /model completed without a displayable response/,
      expectedStopReason: "error",
      expectedStatus: "failed",
    },
  ];

  for (const entry of cases) {
    const host = new SparkHostRuntime({ cwd: `/tmp/spark-agent-loop-test-${entry.name}` });
    const agentEndEvents: unknown[] = [];
    const loopEvents: SparkAgentLoopEvent[] = [];
    host.on("agent_end", (event) => agentEndEvents.push(event));
    const loop = new SparkAgentLoop({
      host,
      llm: entry.llm,
      getModel: () => TEST_MODEL,
    });
    loop.onEvent((event) => loopEvents.push(event));

    const outcome = await loop.submitWithOutcome(entry.name);
    const result = outcome.assistant;

    assert.equal(agentEndEvents.length, 1, `${entry.name} should emit agent_end exactly once`);
    assert.equal(loop.getState(), "idle", `${entry.name} should leave the loop idle`);
    assert.equal(outcome.status, entry.expectedStatus, `${entry.name} should classify its outcome`);
    assert.equal(loop.getLastOutcome()?.status, entry.expectedStatus);
    assert.equal(
      loopEvents.filter((event) => event.type === "run_outcome").length,
      1,
      `${entry.name} should publish exactly one explicit outcome`,
    );
    if (entry.expectedStopReason) {
      assert.equal(
        result?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should return its terminal stop reason`,
      );
      assert.equal(
        asAssistant(loop.getMessages().at(-1))?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should persist its terminal stop reason`,
      );
      assert.equal(
        (agentEndEvents[0] as { messages?: AssistantMessage[] }).messages?.[0]?.stopReason,
        entry.expectedStopReason,
        `${entry.name} should expose its terminal stop reason on agent_end`,
      );
      if (entry.expectedError) {
        assert.match(
          result?.errorMessage ?? "",
          entry.expectedError,
          `${entry.name} should return the terminal error detail`,
        );
      }
    }
    if (entry.expectedError) {
      assert.match(
        (agentEndEvents[0] as { errorMessage?: string }).errorMessage ?? "",
        entry.expectedError,
        `${entry.name} should expose the terminal error on agent_end`,
      );
      assert.equal(
        loopEvents.some(
          (event) => event.type === "error" && entry.expectedError?.test(event.message),
        ),
        true,
        `${entry.name} should publish the terminal error`,
      );
    }
  }
});

test("SparkAgentLoop continues through more than sixteen tool rounds by default", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-long-tool-run-test" });
  const toolRounds = Array.from({ length: 16 }, (_, index) => [
    {
      type: "done" as const,
      reason: "toolUse" as const,
      message: buildAssistant(
        [
          {
            type: "toolCall",
            id: `tc-unbounded-${index}`,
            name: "missing",
            arguments: {},
          },
        ],
        "toolUse",
      ),
    },
  ]);
  const finalAssistant = buildAssistant([{ type: "text", text: "completed after round 16" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [...toolRounds, [{ type: "done", reason: "stop", message: finalAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  const errors: string[] = [];
  loop.onEvent((event) => {
    if (event.type === "error") errors.push(event.message);
  });

  const outcome = await loop.submitWithOutcome("continue until the work is complete");

  assert.equal(outcome.status, "completed");
  assert.equal(outcome.roundtrips, 17);
  assert.deepEqual(loop.getLastPromptManifest()?.roundtrip, { index: 17 });
  assert.deepEqual(errors, []);
});

test("SparkAgentLoop dispatches tool calls and feeds tool results back into the next turn", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  let toolCalls = 0;
  let toolSessionId: string | undefined;
  host.registerTool({
    name: "echo",
    description: "echo input",
    parameters: { type: "object" },
    async execute(_id, params, _signal, onUpdate, ctx) {
      toolCalls += 1;
      toolSessionId = ctx.sessionId;
      onUpdate({ content: [{ type: "text", text: "echo is running" }] });
      return {
        content: [{ type: "text", text: `echoed:${(params as { x?: string }).x ?? ""}` }],
        details: {
          task: {
            ref: "task:echo-1",
            title: "Echo task",
            status: "running",
            projectRef: "proj:echo",
            outputEvidenceRefs: ["evidence:echo-1"],
          },
          artifact: {
            ref: "evidence:echo-1",
            title: "Echo artifact",
            kind: "record",
            format: "json",
            producer: "task",
          },
        },
      };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-1",
    name: "echo",
    arguments: { x: "ping" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after echo" }]);
  const fake = makeFakeStream({
    rounds: [
      [
        { type: "start", partial: firstAssistant },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: toolCallEnvelope,
          partial: firstAssistant,
        },
        { type: "done", reason: "toolUse", message: firstAssistant },
      ],
      [
        { type: "start", partial: finalAssistant },
        { type: "done", reason: "stop", message: finalAssistant },
      ],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  loop.setViewSessionId("session:tool-context");
  const events: SparkAgentLoopEvent[] = [];
  loop.onEvent((event) => events.push(event));

  await loop.submit("call the echo tool");
  assert.equal(toolCalls, 1);
  assert.equal(toolSessionId, "session:tool-context");
  assert.equal(host.makeContext().sessionId, "session:tool-context");
  const messages = loop.getMessages();
  assert.equal(messages.length, 4, "user + asst toolUse + toolResult + asst stop");
  assert.equal(messages[2]!.role, "toolResult");
  assert.equal((messages[2] as { isError?: boolean }).isError, false);
  assert.equal(loop.getState(), "idle");
  const toolResultEvent = events.find((event) => event.type === "tool_result");
  assert.equal(toolResultEvent !== undefined, true);
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "pending" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  const echoToolMessages = viewEvents
    .filter(isSessionMessageViewEvent)
    .filter((event) => event.message.role === "tool" && event.message.toolCallId === "tc-1");
  assert.deepEqual(
    [...new Set(echoToolMessages.map((event) => event.message.id))],
    ["tool-call:tc-1"],
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "streaming" &&
        event.message.text === "echo is running" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "tool" &&
        event.message.status === "done" &&
        event.message.toolName === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "task.update" &&
        event.task.ref === "task:echo-1" &&
        event.task.status === "running" &&
        event.task.evidenceRefs.includes("evidence:echo-1") &&
        event.task.metadata.sourceTool === "echo",
    ),
    true,
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "evidence.update" &&
        event.evidence.ref === "evidence:echo-1" &&
        event.evidence.kind === "record" &&
        event.evidence.metadata.sourceTool === "echo",
    ),
    true,
  );
});

test("SparkAgentLoop yields before tool dispatch and resumes the exact calls once", async () => {
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-restart",
    name: "checkpoint_echo",
    arguments: { value: "resume-me" },
  };
  const toolAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const predecessorHost = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-restart-predecessor",
  });
  let toolExecutions = 0;
  predecessorHost.registerTool({
    name: "checkpoint_echo",
    description: "checkpoint test tool",
    parameters: { type: "object" },
    async execute() {
      toolExecutions += 1;
      return { content: [{ type: "text", text: "unexpected predecessor execution" }] };
    },
  });
  const predecessorAgentEnd: unknown[] = [];
  predecessorHost.on("agent_end", (event) => predecessorAgentEnd.push(event));
  const predecessor = new SparkAgentLoop({
    host: predecessorHost,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "toolUse", message: toolAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  let checkpoint: SparkBeforeToolCallsCheckpoint | undefined;

  await assert.rejects(
    predecessor.submitWithOutcome("run the checkpoint tool", {
      beforeToolCalls: (candidate) => {
        checkpoint = candidate;
        throw new SparkTurnRestartYieldError();
      },
    }),
    (error: unknown) => error instanceof SparkTurnRestartYieldError,
  );
  assert.equal(toolExecutions, 0);
  assert.equal(predecessorAgentEnd.length, 0);
  assert.equal(predecessor.getState(), "idle");
  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.toolCalls, [toolCallEnvelope]);

  const successorHost = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-restart-successor",
  });
  successorHost.registerTool({
    name: "checkpoint_echo",
    description: "checkpoint test tool",
    parameters: { type: "object" },
    async execute(_id, parameters) {
      toolExecutions += 1;
      return {
        content: [
          {
            type: "text",
            text: `resumed:${(parameters as { value?: string }).value ?? ""}`,
          },
        ],
      };
    },
  });
  const finalAssistant = buildAssistant([{ type: "text", text: "restart continuation complete" }]);
  const successor = new SparkAgentLoop({
    host: successorHost,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: finalAssistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  successor.replacePromptItems(checkpoint.promptItems);

  const outcome = await successor.resumeToolCallsWithOutcome(checkpoint.toolCalls);

  assert.equal(outcome.status, "completed");
  assert.equal(toolExecutions, 1);
  assert.deepEqual(
    successor.getMessages().map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.match(toolResultText(asToolResult(successor.getMessages()[2])), /resumed:resume-me/u);
});

test("SparkAgentLoop retries a confirmed not-sent tool call and completes it once", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-not-sent-retry" });
  let toolCalls = 0;
  host.registerTool({
    name: "send_once",
    description: "not-sent retry probe",
    parameters: { type: "object" },
    async execute() {
      toolCalls += 1;
      if (toolCalls === 1) {
        throw Object.assign(new Error("dispatch rejected"), {
          code: "CHANNEL_DELIVERY_NOT_SENT",
          certainty: "not-sent",
          retryability: "transient",
        });
      }
      return { content: [{ type: "text", text: "receipt:sent" }] };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "not-sent-1",
    name: "send_once",
    arguments: {},
  };
  const finalAssistant = buildAssistant([{ type: "text", text: "sent after safe retry" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [{ type: "done", reason: "stop", message: finalAssistant }],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("send safely");
  assert.equal(outcome.status, "completed");
  assert.equal(toolCalls, 2);
  assert.match(toolResultText(asToolResult(loop.getMessages()[2])), /receipt:sent/u);
});

test("SparkAgentLoop reconciles an unknown tool outcome before continuing without replay", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-unknown-reconcile" });
  let toolCalls = 0;
  let reconcileCalls = 0;
  host.registerTool({
    name: "uncertain_send",
    description: "unknown outcome reconcile probe",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential" },
    async execute() {
      toolCalls += 1;
      throw new Error("response lost after dispatch");
    },
    async reconcile() {
      reconcileCalls += 1;
      return {
        outcome: "completed",
        result: { content: [{ type: "text", text: "receipt:reconciled" }] },
      };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "unknown-1",
    name: "uncertain_send",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "continued after reconciliation" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("reconcile first");
  assert.equal(outcome.status, "completed");
  assert.equal(toolCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.match(toolResultText(asToolResult(loop.getMessages()[2])), /receipt:reconciled/u);
});

test("SparkAgentLoop returns an unresolved external write to the Agent without replay", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-unknown-blocker" });
  let providerCalls = 0;
  let toolCalls = 0;
  let reconcileCalls = 0;
  host.registerTool({
    name: "uncertain_send",
    description: "unknown outcome blocker probe",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential" },
    async execute() {
      toolCalls += 1;
      throw new Error("response lost after dispatch");
    },
    async reconcile() {
      reconcileCalls += 1;
      return { outcome: "unknown", message: "provider has no query endpoint" };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "unknown-blocked",
    name: "uncertain_send",
    arguments: {},
  };
  const streamFunction: SparkAgentStreamFunction = (_model, _context) => {
    providerCalls += 1;
    return makeFakeStream({
      rounds: [
        [
          {
            type: "done",
            reason: providerCalls === 1 ? "toolUse" : "stop",
            message:
              providerCalls === 1
                ? buildAssistant([toolCall], "toolUse")
                : buildAssistant([{ type: "text", text: "inspected state and chose a safe path" }]),
          },
        ],
      ],
    })(_model, _context);
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(streamFunction),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("recover from unknown");
  assert.equal(outcome.status, "completed");
  assert.equal(providerCalls, 2);
  assert.equal(toolCalls, 1);
  assert.equal(reconcileCalls, 1);
  const recoveryError = asToolResult(loop.getMessages()[2]);
  assert.equal(recoveryError?.isError, true);
  assert.match(toolResultText(recoveryError), /Do not replay this operation/u);
  assert.deepEqual(recoveryError?.details, {
    sparkToolRecovery: "agent_action_required",
    code: "SPARK_TOOL_OUTCOME_UNKNOWN",
    operationId: "spark-agent:unknown-blocked",
    certainty: "unknown",
    retryability: "agent-decides",
    replayAllowed: false,
    automaticRetryAllowed: false,
    executeRetries: 0,
    reconciliationAttempts: 1,
  });
});

test("SparkAgentLoop does not retry a permanent not-sent failure", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-not-sent-permanent" });
  let toolCalls = 0;
  host.registerTool({
    name: "invalid_send",
    description: "permanent not-sent probe",
    parameters: { type: "object" },
    async execute() {
      toolCalls += 1;
      throw Object.assign(new Error("invalid recipient"), {
        certainty: "not-sent",
        retryability: "permanent",
      });
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "not-sent-permanent",
    name: "invalid_send",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "corrected the target instead" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const outcome = await loop.submitWithOutcome("send once");
  assert.equal(outcome.status, "completed");
  assert.equal(toolCalls, 1);
  const recoveryError = asToolResult(loop.getMessages()[2]);
  assert.equal(recoveryError?.isError, true);
  assert.match(toolResultText(recoveryError), /failure is permanent/u);
  assert.deepEqual(recoveryError?.details, {
    sparkToolRecovery: "agent_action_required",
    code: "SPARK_TOOL_RETRY_NOT_AUTHORIZED",
    operationId: "spark-agent:not-sent-permanent",
    certainty: "not-sent",
    retryability: "permanent",
    replayAllowed: true,
    automaticRetryAllowed: false,
    executeRetries: 0,
    reconciliationAttempts: 0,
  });
});

test("SparkAgentLoop aborts a timed-out tool attempt before reconciling its external outcome", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-timeout-abort" });
  let toolCalls = 0;
  let reconcileCalls = 0;
  let timedOutSignalAborted = false;
  host.registerTool({
    name: "slow_external_write",
    description: "tool timeout abort probe",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential" },
    async execute(_id, _parameters, signal) {
      toolCalls += 1;
      return await new Promise((_resolve, reject) => {
        const onAbort = () => {
          timedOutSignalAborted = signal.aborted;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    async reconcile(_id, _parameters, signal) {
      reconcileCalls += 1;
      assert.equal(signal.aborted, false);
      return { outcome: "unknown", message: "remote status is not queryable" };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "timeout-external-write",
    name: "slow_external_write",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([
                { type: "text", text: "did not replay the timed-out write" },
              ]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
    toolTimeoutMs: 20,
  });

  const outcome = await loop.submitWithOutcome("write once");
  assert.equal(outcome.status, "completed");
  assert.equal(timedOutSignalAborted, true);
  assert.equal(toolCalls, 1);
  assert.equal(reconcileCalls, 1);
  const recoveryError = asToolResult(loop.getMessages()[2]);
  assert.equal(recoveryError?.isError, true);
  assert.equal(
    (recoveryError?.details as { replayAllowed?: unknown } | undefined)?.replayAllowed,
    false,
  );
});

test("SparkAgentLoop waits for a timed-out tool attempt to settle before reconciliation", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-timeout-settlement" });
  let releaseTool: (() => void) | undefined;
  const toolGate = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let observeAbort: (() => void) | undefined;
  const abortObserved = new Promise<void>((resolve) => {
    observeAbort = resolve;
  });
  let reconcileCalls = 0;
  host.registerTool({
    name: "abort_ignoring_external_write",
    description: "tool timeout settlement probe",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential" },
    async execute(_id, _parameters, signal) {
      signal.addEventListener("abort", () => observeAbort?.(), { once: true });
      await toolGate;
      return { content: [{ type: "text", text: "original attempt settled" }] };
    },
    async reconcile() {
      reconcileCalls += 1;
      return { outcome: "unknown", message: "remote status is not queryable" };
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "timeout-settlement",
    name: "abort_ignoring_external_write",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "handled uncertain outcome" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
    toolTimeoutMs: 20,
  });

  const pendingOutcome = loop.submitWithOutcome("write once");
  await abortObserved;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconcileCalls, 0);
  releaseTool?.();

  const outcome = await pendingOutcome;
  assert.equal(outcome.status, "completed");
  assert.equal(reconcileCalls, 1);
});

test("SparkAgentLoop keeps a thrown tool error inside the execution chain and completes the turn", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-tool-error-projection-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  host.registerTool({
    name: "unstable_read",
    description: "fails while reading",
    parameters: { type: "object" },
    async execute() {
      throw new Error("cue transport failed");
    },
  });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-tool-error-projection",
    name: "unstable_read",
    arguments: {},
  };
  const finalAssistant = buildAssistant([
    { type: "text", text: "I recovered and finished normally." },
  ]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [{ type: "done", reason: "stop", message: finalAssistant }],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("recover after a tool error");

  const transcript = loop.getMessages();
  const toolResult = asToolResult(
    transcript.find(
      (message) => message.role === "toolResult" && message.toolCallId === toolCall.id,
    ),
  );
  assert.equal(toolResult?.isError, true);
  assert.match(toolResultText(toolResult), /cue transport failed/u);
  assert.equal(transcript.at(-1)?.role, "assistant");
  assert.equal(
    (transcript.at(-1)?.content[0] as { text?: string } | undefined)?.text,
    "I recovered and finished normally.",
  );

  const toolView = viewEvents
    .filter(isSessionMessageViewEvent)
    .find((event) => event.message.id === `tool-call:${toolCall.id}`);
  assert.equal(toolView?.message.role, "tool");
  assert.equal(toolView?.message.status, "done");
  assert.equal(toolView?.message.parts?.[0]?.type, "tool-result");
  assert.equal(toolView?.message.parts?.[0]?.status, "failed");
  assert.equal(
    viewEvents.some(
      (event) => event.type === "session.message" && event.message.status === "error",
    ),
    false,
  );
  assert.equal(
    viewEvents.some(
      (event) =>
        event.type === "session.message" &&
        event.message.role === "assistant" &&
        event.message.status === "done" &&
        event.message.text === "I recovered and finished normally.",
    ),
    true,
  );
});

test("SparkAgentLoop runs an explicitly safe read batch concurrently and commits results in source order", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-read-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const events: SparkAgentLoopEvent[] = [];
  for (const name of ["read_alpha", "read_beta"]) {
    host.registerTool({
      name,
      description: name,
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute(toolCallId) {
        started.push(toolCallId);
        await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
        return { content: [{ type: "text", text: `result:${toolCallId}` }] };
      },
    });
  }
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-alpha", name: "read_alpha", arguments: {} },
    { type: "toolCall", id: "tc-beta", name: "read_beta", arguments: {} },
  ];
  const firstAssistant = buildAssistant(toolCalls, "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "reads complete" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: firstAssistant }],
          [{ type: "done", reason: "stop", message: finalAssistant }],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.onEvent((event) => events.push(event));

  const run = loop.submit("read two files");
  await waitForCondition(
    () => started.length === 2,
    "both explicitly safe reads should start before either one completes",
  );
  releases.get("tc-beta")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get("tc-alpha")!();
  await run;

  assert.deepEqual(started, ["tc-alpha", "tc-beta"]);
  const results = loop.getMessages().filter((message) => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.toolCallId),
    ["tc-alpha", "tc-beta"],
  );
  assert.deepEqual(
    results.map((message) => toolResultText(message)),
    ["result:tc-alpha", "result:tc-beta"],
  );
  assert.deepEqual(
    events
      .filter(
        (event): event is Extract<SparkAgentLoopEvent, { type: "tool_result" }> =>
          event.type === "tool_result",
      )
      .map((event) => event.message.toolCallId),
    ["tc-alpha", "tc-beta"],
  );
});

test("SparkAgentLoop treats a mixed read/write batch as one sequential barrier", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-mixed-tool-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  host.registerTool({
    name: "parallel_read",
    description: "explicitly safe read",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      started.push(toolCallId);
      await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  host.registerTool({
    name: "write_barrier",
    description: "stateful write",
    parameters: { type: "object" },
    effect: "local_write",
    executionMode: "sequential",
    async execute(toolCallId) {
      started.push(toolCallId);
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-read-a", name: "parallel_read", arguments: {} },
    { type: "toolCall", id: "tc-read-b", name: "parallel_read", arguments: {} },
    { type: "toolCall", id: "tc-write", name: "write_barrier", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("read then write");
  await waitForCondition(() => started.length === 1, "the first read should start");
  assert.deepEqual(started, ["tc-read-a"]);
  releases.get("tc-read-a")!();
  await waitForCondition(
    () => started.length === 2,
    "the second read should start after the first",
  );
  assert.deepEqual(started, ["tc-read-a", "tc-read-b"]);
  releases.get("tc-read-b")!();
  await run;

  assert.deepEqual(started, ["tc-read-a", "tc-read-b", "tc-write"]);
});

test("SparkAgentLoop keeps tools without explicit execution metadata sequential", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-unknown-policy-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  for (const name of ["unknown_a", "unknown_b"]) {
    host.registerTool({
      name,
      description: name,
      parameters: { type: "object" },
      async execute(toolCallId) {
        started.push(toolCallId);
        await new Promise<void>((resolve) => releases.set(toolCallId, resolve));
        return { content: [{ type: "text", text: toolCallId }] };
      },
    });
  }
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-unknown-a", name: "unknown_a", arguments: {} },
    { type: "toolCall", id: "tc-unknown-b", name: "unknown_b", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("call unknown-policy tools");
  await waitForCondition(() => started.length === 1, "the first unknown-policy tool should start");
  assert.deepEqual(started, ["tc-unknown-a"]);
  releases.get("tc-unknown-a")!();
  await waitForCondition(
    () => started.length === 2,
    "the second unknown-policy tool should wait for the first",
  );
  releases.get("tc-unknown-b")!();
  await run;

  assert.deepEqual(started, ["tc-unknown-a", "tc-unknown-b"]);
});

test("SparkAgentLoop bounds parallel read batches to four calls by default", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-bound-test" });
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let maxActive = 0;
  host.registerTool({
    name: "bounded_read",
    description: "bounded parallel read",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      started.push(toolCallId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) =>
        releases.set(toolCallId, () => {
          releases.delete(toolCallId);
          resolve();
        }),
      );
      active -= 1;
      return { content: [{ type: "text", text: toolCallId }] };
    },
  });
  const toolCalls: ToolCall[] = Array.from({ length: 6 }, (_, index) => ({
    type: "toolCall",
    id: `tc-bounded-${index}`,
    name: "bounded_read",
    arguments: {},
  }));
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const run = loop.submit("run bounded reads");
  await waitForCondition(() => started.length === 4, "the first four reads should fill the pool");
  assert.equal(active, 4);
  assert.equal(maxActive, 4);
  for (const release of [...releases.values()]) release();
  await waitForCondition(
    () => started.length === 6,
    "the final reads should start after capacity frees",
  );
  assert.equal(active, 2);
  for (const release of [...releases.values()]) release();
  await run;

  assert.equal(maxActive, 4);
  assert.deepEqual(
    loop
      .getMessages()
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
    toolCalls.map((toolCall) => toolCall.id),
  );
});

test("SparkAgentLoop isolates failures inside a parallel read batch", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-parallel-error-test" });
  const executed: string[] = [];
  host.registerTool({
    name: "fallible_read",
    description: "read with one failing call",
    parameters: { type: "object" },
    effect: "read",
    executionMode: "parallel",
    async execute(toolCallId) {
      executed.push(toolCallId);
      if (toolCallId === "tc-fail") throw new Error("read failed independently");
      return { content: [{ type: "text", text: `ok:${toolCallId}` }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-fail", name: "fallible_read", arguments: {} },
    { type: "toolCall", id: "tc-ok", name: "fallible_read", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("run fallible reads");

  assert.deepEqual(executed, ["tc-fail", "tc-ok"]);
  const results = loop
    .getMessages()
    .filter((message): message is ToolResultMessage => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => [message.toolCallId, message.isError]),
    [
      ["tc-fail", true],
      ["tc-ok", false],
    ],
  );
  assert.match(toolResultText(results[0]), /read failed independently/);
  assert.equal(toolResultText(results[1]), "ok:tc-ok");
});

test("SparkAgentLoop publishes ordered display-safe conversation parts without tool payloads", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-display-safe-view-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  host.registerTool({
    name: "inspect_secret",
    description: "exercise display-safe tool projection",
    parameters: { type: "object" },
    async execute() {
      return {
        content: [{ type: "text", text: "public-tool-output" }],
        details: { token: "secret-tool-details" },
      };
    },
  });

  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-display-safe",
    name: "inspect_secret",
    arguments: { token: "secret-tool-argument" },
  };
  const firstAssistant = buildAssistant(
    [
      { type: "thinking", thinking: "Check the safe public state." },
      {
        type: "thinking",
        thinking: "secret-redacted-thinking",
        thinkingSignature: "secret-thinking-signature",
        redacted: true,
      },
      { type: "text", text: "Inspecting now." },
      toolCall,
    ],
    "toolUse",
  );
  const finalAssistant = buildAssistant([{ type: "text", text: "Inspection complete." }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [
            { type: "start", partial: firstAssistant },
            { type: "toolcall_end", contentIndex: 3, toolCall, partial: firstAssistant },
            { type: "done", reason: "toolUse", message: firstAssistant },
          ],
          [
            { type: "start", partial: finalAssistant },
            { type: "done", reason: "stop", message: finalAssistant },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-display-safe-view");

  await loop.submit("inspect safely");

  const assistantMessage = viewEvents
    .filter(isSessionMessageViewEvent)
    .find(
      (event) =>
        event.message.role === "assistant" &&
        event.message.status === "done" &&
        event.message.text === "Inspecting now.",
    )?.message;
  assert.ok(assistantMessage);
  const assistantParts = assistantMessage.parts;
  assert.ok(assistantParts);
  assert.deepEqual(
    assistantParts.map((part) => part.type),
    ["thinking", "thinking", "text", "tool-call"],
  );
  assert.deepEqual(assistantParts[1], {
    id: `${assistantMessage.id}:part:1`,
    type: "thinking",
    text: "",
    status: "complete",
    redacted: true,
    metadata: {},
  });
  assert.deepEqual(assistantParts[2], {
    id: `${assistantMessage.id}:part:2`,
    type: "text",
    text: "Inspecting now.",
    status: "complete",
    metadata: {},
  });
  assert.deepEqual(assistantParts[3], {
    id: `${assistantMessage.id}:part:3`,
    type: "tool-call",
    toolCallId: "tc-display-safe",
    toolName: "inspect_secret",
    status: "pending",
    metadata: {},
  });

  const toolCallMessage = viewEvents
    .filter(isSessionMessageViewEvent)
    .find((event) => event.message.id === "tool-call:tc-display-safe")?.message;
  assert.ok(toolCallMessage);
  assert.deepEqual(toolCallMessage.parts, [
    {
      id: "tool-call:tc-display-safe:part:0",
      type: "tool-call",
      toolCallId: "tc-display-safe",
      toolName: "inspect_secret",
      status: "pending",
      metadata: {},
    },
  ]);
  assert.deepEqual(toolCallMessage.metadata, { kind: "tool_call" });

  const toolResultMessage = viewEvents
    .filter(isSessionMessageViewEvent)
    .find(
      (event) =>
        event.message.id === "tool-call:tc-display-safe" && event.message.status === "done",
    )?.message;
  assert.ok(toolResultMessage);
  assert.equal(toolResultMessage.text, "public-tool-output");
  assert.deepEqual(toolResultMessage.parts, [
    {
      id: "tool-call:tc-display-safe:part:0",
      type: "tool-result",
      toolCallId: "tc-display-safe",
      toolName: "inspect_secret",
      status: "complete",
      summary: "public-tool-output",
      metadata: {},
    },
  ]);
  assert.deepEqual(toolResultMessage.metadata, { kind: "tool_result" });

  assert.doesNotMatch(
    JSON.stringify(viewEvents),
    /secret-tool-argument|secret-tool-details|secret-redacted-thinking|secret-thinking-signature/u,
  );
});

test("SparkAgentLoop keeps text phases without projecting commentary as assistant prose", async () => {
  const viewEvents: SparkViewModelEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-text-phase-test",
    ui: { publishView: (event) => viewEvents.push(event) },
  });
  const assistant = buildAssistant([
    {
      type: "text",
      text: "Checking the repository.",
      textSignature: JSON.stringify({
        v: 1,
        phase: "commentary",
        providerSecret: "commentary-text-signature-secret",
      }),
    },
    {
      type: "text",
      text: "The check passed.",
      textSignature: JSON.stringify({
        phase: "final_answer",
        providerSecret: "final-text-signature-secret",
      }),
    },
    { type: "text", text: "Legacy detail." },
    {
      type: "text",
      text: "Unknown phase stays visible.",
      textSignature: JSON.stringify({ phase: "future_phase" }),
    },
    {
      type: "text",
      text: "Malformed signature stays visible.",
      textSignature: "not-json-signature-secret",
    },
  ]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [[{ type: "done", reason: "stop", message: assistant }]],
      }),
    ),
    getModel: () => TEST_MODEL,
  });
  loop.setViewSessionId("session-text-phase-view");

  await loop.submit("check phases");

  const message = viewEvents
    .filter(isSessionMessageViewEvent)
    .find(
      (event) => event.message.role === "assistant" && event.message.status === "done",
    )?.message;
  assert.ok(message);
  const messageParts = message.parts;
  assert.ok(messageParts);
  assert.equal(
    message.text,
    "The check passed.\nLegacy detail.\nUnknown phase stays visible.\nMalformed signature stays visible.",
  );
  assert.deepEqual(
    messageParts.map((part) => ("phase" in part ? part.phase : undefined)),
    ["commentary", "final_answer", undefined, undefined, undefined],
  );
  assert.doesNotMatch(
    JSON.stringify(viewEvents),
    /commentary-text-signature-secret|final-text-signature-secret|not-json-signature-secret/u,
  );
});

test("SparkAgentLoop compacts blank runs for log-like tool results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-compaction-test" });
  const noisyOutput = `alpha${"\n".repeat(61)}omega`;
  host.registerTool({
    name: "cue_exec",
    description: "fake cue output",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: noisyOutput }] };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-compact",
    name: "cue_exec",
    arguments: { command: "fake" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after compaction" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("call compacting tool");

  const toolResult = asToolResult(
    loop.getMessages().find((message) => message.role === "toolResult"),
  );
  assert.equal(toolResultText(toolResult), "alpha\n\n[58 blank lines collapsed]\n\nomega");
  assert.ok(isRecord(toolResult?.details));
  const compaction = toolResult.details.toolResultCompaction;
  assert.ok(isRecord(compaction));
  assert.equal(compaction.profile, "log");
  assert.equal(compaction.level, "full");
  assert.equal(compaction.trimmedLeadingBlankLines, 0);
  assert.equal(compaction.trimmedTrailingBlankLines, 0);
  assert.equal(compaction.collapsedBlankLines, 58);
  assert.equal(compaction.collapsedBlankRuns, 1);
  assert.equal(compaction.collapsedRepeatedLines, 0);
  assert.equal(compaction.collapsedRepeatedRuns, 0);
  assert.equal(
    typeof compaction.originalChars === "number" &&
      typeof compaction.compactedChars === "number" &&
      compaction.originalChars > compaction.compactedChars,
    true,
  );
});

test("SparkAgentLoop records raw trace artifact for large lossy compacted tool output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-loop-raw-recovery-"));
  try {
    const host = new SparkHostRuntime({ cwd: dir });
    registerSparkEvidenceTool({
      registerTool: (config) =>
        host.registerTool(config as Parameters<typeof host.registerTool>[0]),
    });
    const noisyOutput = `alpha${"\n".repeat(4_500)}omega`;
    host.registerTool({
      name: "cue_exec",
      description: "fake cue output",
      parameters: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: noisyOutput }] };
      },
    });

    const toolCallEnvelope: ToolCall = {
      type: "toolCall",
      id: "tc-raw-recovery",
      name: "cue_exec",
      arguments: { command: "fake" },
    };
    const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
    const finalAssistant = buildAssistant([{ type: "text", text: "after raw recovery" }]);
    const fake = makeFakeStream({
      rounds: [
        [{ type: "done", reason: "toolUse", message: firstAssistant }],
        [{ type: "done", reason: "stop", message: finalAssistant }],
      ],
    });
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(fake),
      getModel: () => TEST_MODEL,
    });

    await loop.submit("call compacting tool");

    const toolResult = asToolResult(
      loop.getMessages().find((message) => message.role === "toolResult"),
    );
    const text = toolResultText(toolResult);
    assert.match(text, /\[4497 blank lines collapsed\]/);
    assert.match(text, /\[recovery\] Full raw tool output saved as evidence:/);
    assert.match(
      text,
      /evidence\(\{ action: "read", evidenceRef: "evidence:[^"]+", maxChars: 20000 \}\)/,
    );
    assert.equal(toolResult?.toolCallId, toolCallEnvelope.id);
    assert.equal(toolResult?.toolName, toolCallEnvelope.name);
    assert.equal(toolResult?.isError, false);
    assert.ok(isRecord(toolResult?.details));
    const recovery = toolResult.details.toolResultRawRecovery;
    assert.ok(isRecord(recovery));
    const evidenceRefValue = recovery.evidenceRef;
    assert.ok(typeof evidenceRefValue === "string");
    const evidenceRef = assertRef(evidenceRefValue, "evidence");
    assert.match(evidenceRef, /^evidence:/);
    assert.equal(recovery.reason, "lossy_compaction");
    assert.equal(recovery.bodyChars, noisyOutput.length);
    assert.deepEqual(recovery.recoveryPath, {
      kind: "evidence",
      evidenceRef,
      readTool: "evidence",
      readArgs: { action: "read", evidenceRef, maxChars: 20_000 },
    });

    const store = defaultEvidenceStore(dir);
    const artifact = await store.get(evidenceRef);
    assert.equal(artifact.kind, "trace");
    assert.equal(artifact.format, "text");
    assert.equal(artifact.curation?.status, "raw");
    assert.equal(artifact.curation?.retention, "ephemeral");
    assert.equal(artifact.provenance.producer, "cue");
    assert.equal(
      artifact.provenance.note,
      "Raw recoverable tool result for cue_exec (lossy_compaction)",
    );
    assert.equal(await store.getBody(evidenceRef), noisyOutput);

    const artifactTool = host.getTool("evidence");
    assert.ok(artifactTool);
    const readResult = await artifactTool.config.execute(
      "read-raw-output",
      { action: "read", evidenceRef, maxChars: noisyOutput.length + 200 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const readText = readResult.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.match(readText, new RegExp(`${evidenceRef} \\[trace\\] Raw tool output for cue_exec`));
    assert.match(readText, /alpha/);
    assert.match(readText, /omega/);

    const defaultList = await artifactTool.config.execute(
      "list-default-raw-hidden",
      { action: "list", limit: 5 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const defaultListText = defaultList.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.doesNotMatch(defaultListText, new RegExp(evidenceRef));

    const explicitRawList = await artifactTool.config.execute(
      "list-explicit-raw",
      { action: "list", includeRaw: true, limit: 5 },
      new AbortController().signal,
      () => undefined,
      host.makeContext(),
    );
    const explicitRawListText = explicitRawList.content
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n");
    assert.match(explicitRawListText, new RegExp(evidenceRef));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentLoop offloads failed long output while preserving diagnostics and exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-agent-loop-error-recovery-"));
  try {
    const host = new SparkHostRuntime({ cwd: dir });
    registerSparkEvidenceTool({
      registerTool: (config) =>
        host.registerTool(config as Parameters<typeof host.registerTool>[0]),
    });
    const diagnostic = `fatal: command failed${"\n".repeat(4_500)}exit code: 7`;
    host.registerTool({
      name: "cue_exec",
      description: "failed fake cue output",
      parameters: { type: "object" },
      async execute() {
        return {
          content: [{ type: "text", text: diagnostic }],
          isError: true,
          details: { exitCode: 7 },
        };
      },
    });
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tc-error-recovery",
      name: "cue_exec",
      arguments: {},
    };
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [
            [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
            [
              {
                type: "done",
                reason: "stop",
                message: buildAssistant([{ type: "text", text: "failure recorded" }]),
              },
            ],
          ],
        }),
      ),
      getModel: () => TEST_MODEL,
    });
    await loop.submit("produce failed output");
    const result = asToolResult(
      loop.getMessages().find((message) => message.role === "toolResult"),
    );
    const text = toolResultText(result);
    assert.equal(result?.toolCallId, toolCall.id);
    assert.equal(result?.toolName, toolCall.name);
    assert.equal(result?.isError, true);
    assert.match(text, /fatal: command failed/u);
    assert.match(text, /exit code: 7/u);
    assert.match(text, /evidence\(\{ action: "read"/u);
    assert.ok(isRecord(result?.details));
    const recovery = result.details.toolResultRawRecovery;
    assert.ok(isRecord(recovery));
    assert.equal(recovery.reason, "error_compaction");
    const evidenceRefValue = recovery.evidenceRef;
    assert.ok(typeof evidenceRefValue === "string");
    const evidenceRef = assertRef(evidenceRefValue, "evidence");
    const store = defaultEvidenceStore(dir);
    const artifact = await store.get(evidenceRef);
    assert.equal(await store.getBody(artifact.ref), diagnostic);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "SparkAgentLoop aborts a hanging raw recovery and keeps the compacted tool result paired",
  { timeout: 2_000 },
  async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-raw-recovery-abort" });
    let artifactCalls = 0;
    let artifactStarted = false;
    let artifactAborted = false;
    host.registerTool({
      name: "evidence",
      description: "raw recovery sink that deliberately never resolves",
      parameters: { type: "object" },
      policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
      async execute(_toolCallId, _args, signal) {
        artifactCalls += 1;
        artifactStarted = true;
        if (signal.aborted) artifactAborted = true;
        signal.addEventListener(
          "abort",
          () => {
            artifactAborted = true;
          },
          { once: true },
        );
        return await new Promise<never>(() => undefined);
      },
    });
    const noisyOutput = `alpha${"\n".repeat(4_500)}omega`;
    host.registerTool({
      name: "cue_exec",
      description: "compactable read-like output",
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute() {
        return { content: [{ type: "text", text: noisyOutput }] };
      },
    });
    const toolCall: ToolCall = {
      type: "toolCall",
      id: "tc-hanging-raw-recovery",
      name: "cue_exec",
      arguments: {},
    };
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(
        makeFakeStream({
          rounds: [
            [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          ],
        }),
      ),
      getModel: () => TEST_MODEL,
      toolTimeoutMs: 60_000,
    });

    const running = loop.submitWithOutcome("produce a large compactable result");
    await waitForCondition(() => artifactStarted, "raw artifact recovery should start");
    loop.abort("switch_session");
    const outcome = await running;

    assert.equal(outcome.status, "aborted");
    assert.equal(loop.getState(), "idle");
    assert.equal(artifactCalls, 1, "raw recovery must not recursively persist itself");
    assert.equal(artifactAborted, true);
    const results = loop
      .getMessages()
      .filter((message): message is ToolResultMessage => message.role === "toolResult");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.toolCallId, toolCall.id);
    assert.equal(results[0]?.isError, false);
    assert.match(toolResultText(results[0]), /\[4497 blank lines collapsed\]/u);
    assert.doesNotMatch(toolResultText(results[0]), /\[recovery\]/u);
  },
);

test("SparkAgentLoop preserves exact-content tool results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-exact-compaction-test" });
  const exactOutput = "line1\n\n\n\n\nline2";
  host.registerTool({
    name: "read",
    description: "fake read output",
    parameters: { type: "object" },
    async execute() {
      return { content: [{ type: "text", text: exactOutput }] };
    },
  });

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-read-exact",
    name: "read",
    arguments: { path: "file.txt" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after read" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("call read tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { content: Array<{ text?: string }> }).content[0]?.text, exactOutput);
  assert.equal(
    (toolResult as { details?: { toolResultCompaction?: unknown } }).details?.toolResultCompaction,
    undefined,
  );
});

test("SparkAgentLoop times out and aborts a signal-aware tool execution", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-tool-timeout-test" });
  host.registerTool({
    name: "hang_tool",
    description: "never returns",
    parameters: { type: "object" },
    async execute(_id, _parameters, signal) {
      return await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-tool-timeout",
    name: "hang_tool",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    toolTimeoutMs: 10,
  });

  await loop.submit("call hanging tool");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool "hang_tool" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop times out a never-resolving tool approval interaction", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-timeout-test",
    ui: {
      interaction: async () => await new Promise<never>(() => undefined),
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "approval_hang",
    description: "requires approval that never arrives",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-timeout",
    name: "approval_hang",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after approval timeout" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    interactionTimeoutMs: 10,
  });

  await loop.submit("call approval hanging tool");

  assert.equal(toolCalls, 0);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.equal(
    (toolResult as { content: Array<{ text?: string }> }).content[0]?.text,
    'Spark tool approval for "approval_hang" timed out after 10ms',
  );
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop blocks approval-required tools without explicit approval", async () => {
  const interactionRequests: unknown[] = [];
  const daemonEvents: SparkDaemonEvent[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "escape",
          metadata: {},
        };
      },
    },
  });
  host.onDaemonEvent((event) => daemonEvents.push(event));
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous",
    description: "requires approval",
    parameters: { type: "object" },
    policy: { effect: "destructive", executionMode: "sequential", approval: "required" },
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);

  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval",
    name: "dangerous",
    arguments: { path: "important.txt" },
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "after blocked tool" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("try dangerous tool");

  assert.equal(toolCalls, 0);
  assert.equal((interactionRequests[0] as { kind?: string }).kind, "toolApproval");
  assert.equal(
    daemonEvents.some(
      (event) =>
        event.type === "daemon.interaction.request" &&
        event.request.kind === "toolApproval" &&
        event.request.toolName === "dangerous",
    ),
    true,
  );
  assert.equal(
    daemonEvents.some(
      (event) =>
        event.type === "daemon.interaction.response" &&
        event.response.kind === "toolApproval" &&
        event.response.status === "blocked",
    ),
    true,
  );
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /dangerous.*approval cancelled.*Escape/u);
  assert.match(JSON.stringify(toolResult), /no tool execution occurred/u);
});

test("manual_only authority excludes standalone WorkflowRuns and includes real drivers", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-manual-only-driver-authority" });
  host.registerTool({
    name: "draft_pr_policy_probe",
    description: "bounded Draft PR operation",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential", approval: "manual_only" },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as never);
  const tool = host.getTool("draft_pr_policy_probe");
  assert.ok(tool);
  const loop = (binding: { goalId?: string; workflowRunId?: string; reproId?: string }) => ({
    loopId: "loop-driver-authority",
    binding,
    generation: 1,
    ownerSessionId: "session-owner",
    schedule: async () => undefined,
    stop: async () => undefined,
  });

  assert.equal(toolRequiresApproval(tool), true);
  assert.equal(toolRequiresApproval(tool, {}, { loop: loop({}) }), true);
  assert.equal(
    toolRequiresApproval(tool, {}, { loop: loop({}), driverAuthority: "granted" }),
    false,
  );
  assert.equal(
    toolRequiresApproval(
      tool,
      {},
      { loop: loop({ goalId: "goal-1" }), driverAuthority: "granted" },
    ),
    false,
  );
  assert.equal(
    toolRequiresApproval(
      tool,
      {},
      { loop: loop({ reproId: "repro-1" }), driverAuthority: "granted" },
    ),
    false,
  );
  assert.equal(
    toolRequiresApproval(
      tool,
      {},
      { loop: loop({ workflowRunId: "workflow-run-1" }), driverAuthority: "granted" },
    ),
    true,
  );
  assert.equal(
    toolRequiresApproval(
      tool,
      {},
      {
        loop: loop({ goalId: "goal-1", workflowRunId: "workflow-run-1" }),
        driverAuthority: "granted",
      },
    ),
    false,
  );
  assert.equal(
    toolRequiresApproval(tool, {}, { loop: loop({ goalId: "goal-1" }), driverAuthority: "denied" }),
    true,
  );
});

test("SparkAgentLoop requires human approval for manual_only tools on manual turns", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-manual-only-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "not authorized",
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "draft_pr_manual",
    description: "creates a bounded draft PR",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential", approval: "manual_only" },
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "draft created" }] };
    },
  } as never);
  const fake = makeFakeStream({
    rounds: [
      [
        {
          type: "done",
          reason: "toolUse",
          message: buildAssistant(
            [
              {
                type: "toolCall",
                id: "tc-draft-pr-manual",
                name: "draft_pr_manual",
                arguments: {},
              },
            ],
            "toolUse",
          ),
        },
      ],
      [{ type: "done", reason: "stop", message: buildAssistant([{ type: "text", text: "done" }]) }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("create draft PR manually");

  assert.equal(toolCalls, 0);
  assert.equal(interactionRequests.length, 1);
  assert.equal((interactionRequests[0] as { toolName?: string }).toolName, "draft_pr_manual");
});

test("SparkAgentLoop lets a driver run manual_only tools but keeps required gates", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-driver-approval-test",
    loop: {
      loopId: "goal-loop",
      binding: { goalId: "goal-1" },
      generation: 1,
      ownerSessionId: "session-owner",
      schedule: async () => undefined,
      stop: async () => undefined,
    },
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: 1,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "required approval withheld",
          metadata: {},
        };
      },
    },
  });
  let draftCalls = 0;
  let destructiveCalls = 0;
  host.registerTool({
    name: "draft_pr_driver",
    description: "creates a bounded draft PR",
    parameters: { type: "object" },
    policy: { effect: "external_write", executionMode: "sequential", approval: "manual_only" },
    async execute() {
      draftCalls += 1;
      return { content: [{ type: "text", text: "draft created" }] };
    },
  } as never);
  host.registerTool({
    name: "cleanup_driver",
    description: "destructive cleanup",
    parameters: { type: "object" },
    policy: { effect: "destructive", executionMode: "sequential", approval: "required" },
    async execute() {
      destructiveCalls += 1;
      return { content: [{ type: "text", text: "cleaned" }] };
    },
  } as never);
  const fake = makeFakeStream({
    rounds: [
      [
        {
          type: "done",
          reason: "toolUse",
          message: buildAssistant(
            [
              {
                type: "toolCall",
                id: "tc-draft-pr-driver",
                name: "draft_pr_driver",
                arguments: {},
              },
              {
                type: "toolCall",
                id: "tc-cleanup-driver",
                name: "cleanup_driver",
                arguments: {},
              },
            ],
            "toolUse",
          ),
        },
      ],
      [{ type: "done", reason: "stop", message: buildAssistant([{ type: "text", text: "done" }]) }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("continue goal delivery");

  assert.equal(draftCalls, 1);
  assert.equal(destructiveCalls, 0);
  assert.equal(interactionRequests.length, 1);
  assert.equal((interactionRequests[0] as { toolName?: string }).toolName, "cleanup_driver");
});

test("SparkAgentLoop asks interactive sessions once before driver manual_only bypass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-driver-consent-ask-"));
  try {
    const kinds: string[] = [];
    const host = new SparkHostRuntime({
      cwd: dir,
      hasUI: true,
      loop: {
        loopId: "goal-loop",
        binding: { goalId: "goal-1" },
        generation: 1,
        ownerSessionId: "session-owner",
        schedule: async () => undefined,
        stop: async () => undefined,
      },
      ui: {
        interaction: async (request) => {
          kinds.push(request.kind);
          if (request.kind === "askFlow") {
            return {
              version: SPARK_PROTOCOL_VERSION,
              kind: "askFlow",
              requestId: request.requestId,
              status: "answered",
              answers: { driver_authority: { values: ["grant"] } },
            };
          }
          return {
            version: SPARK_PROTOCOL_VERSION,
            kind: "toolApproval",
            requestId: request.requestId,
            status: "blocked",
            approved: false,
            message: "should not be asked",
          };
        },
      },
    });
    host.setSessionId("session:consent");
    let toolCalls = 0;
    host.registerTool({
      name: "draft_pr_consent",
      description: "creates a bounded draft PR",
      parameters: { type: "object" },
      policy: { effect: "external_write", executionMode: "sequential", approval: "manual_only" },
      async execute() {
        toolCalls += 1;
        return { content: [{ type: "text", text: "draft created" }] };
      },
    } as never);
    const fake = makeFakeStream({
      rounds: [
        [
          {
            type: "done",
            reason: "toolUse",
            message: buildAssistant(
              [
                {
                  type: "toolCall",
                  id: "tc-draft-pr-consent",
                  name: "draft_pr_consent",
                  arguments: {},
                },
              ],
              "toolUse",
            ),
          },
        ],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    });
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(fake),
      getModel: () => TEST_MODEL,
    });
    await loop.submit("continue goal delivery");
    assert.equal(toolCalls, 1);
    assert.deepEqual(kinds, ["askFlow"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentLoop treats denied driver authority as required for manual_only tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-driver-consent-deny-"));
  try {
    const kinds: string[] = [];
    const host = new SparkHostRuntime({
      cwd: dir,
      hasUI: true,
      loop: {
        loopId: "goal-loop",
        binding: { goalId: "goal-1" },
        generation: 1,
        ownerSessionId: "session-owner",
        schedule: async () => undefined,
        stop: async () => undefined,
      },
      ui: {
        interaction: async (request) => {
          kinds.push(request.kind);
          if (request.kind === "askFlow") {
            return {
              version: SPARK_PROTOCOL_VERSION,
              kind: "askFlow",
              requestId: request.requestId,
              status: "answered",
              answers: { driver_authority: { values: ["deny"] } },
            };
          }
          return {
            version: SPARK_PROTOCOL_VERSION,
            kind: "toolApproval",
            requestId: request.requestId,
            status: "blocked",
            approved: false,
            message: "per-tool approval withheld",
          };
        },
      },
    });
    host.setSessionId("session:denied");
    let toolCalls = 0;
    host.registerTool({
      name: "draft_pr_denied",
      description: "creates a bounded draft PR",
      parameters: { type: "object" },
      policy: { effect: "external_write", executionMode: "sequential", approval: "manual_only" },
      async execute() {
        toolCalls += 1;
        return { content: [{ type: "text", text: "draft created" }] };
      },
    } as never);
    const fake = makeFakeStream({
      rounds: [
        [
          {
            type: "done",
            reason: "toolUse",
            message: buildAssistant(
              [
                {
                  type: "toolCall",
                  id: "tc-draft-pr-denied",
                  name: "draft_pr_denied",
                  arguments: {},
                },
              ],
              "toolUse",
            ),
          },
        ],
        [
          {
            type: "done",
            reason: "stop",
            message: buildAssistant([{ type: "text", text: "done" }]),
          },
        ],
      ],
    });
    const loop = new SparkAgentLoop({
      host,
      llm: asSparkTurnLlm(fake),
      getModel: () => TEST_MODEL,
    });
    await loop.submit("continue goal delivery");
    assert.equal(toolCalls, 0);
    assert.deepEqual(kinds, ["askFlow", "toolApproval"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SparkAgentLoop skip approvalMethod executes requiresApproval tools without interaction", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-skip-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "blocked",
          approved: false,
          message: "should not be asked",
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_skip",
    description: "requires approval but session skips",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-skip",
    name: "dangerous_skip",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    approvalMethod: "skip",
  });

  await loop.submit("try skip approval");

  assert.equal(toolCalls, 1);
  assert.equal(interactionRequests.length, 0);
});

test("SparkAgentLoop auto review cannot substitute for human approval", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-ok-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "answered",
          approved: true,
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  const reviewCalls: unknown[] = [];
  host.registerTool({
    name: "dangerous_auto_ok",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-ok",
    name: "dangerous_auto_ok",
    arguments: { cmd: "echo hi" },
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    reviewToolApproval: async (request) => {
      reviewCalls.push(request);
      return { outcome: "approved", summary: "safe" };
    },
  });

  await loop.submit("try auto approve");

  assert.equal(toolCalls, 1);
  assert.equal(reviewCalls.length, 1);
  assert.equal((reviewCalls[0] as { toolName?: string }).toolName, "dangerous_auto_ok");
  assert.equal(interactionRequests.length, 1);
});

test("SparkAgentLoop auto approvalMethod escalates to ask when reviewer rejects", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-ask-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "answered",
          approved: true,
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_auto_ask",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "ran after ask" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-ask",
    name: "dangerous_auto_ask",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    approvalRejectAction: "ask",
    reviewToolApproval: async () => ({ outcome: "blocked", summary: "too risky" }),
  });

  await loop.submit("try auto then ask");

  assert.equal(toolCalls, 1);
  assert.equal((interactionRequests[0] as { kind?: string }).kind, "toolApproval");
});

test("SparkAgentLoop auto approvalMethod can deny without ask", async () => {
  const interactionRequests: unknown[] = [];
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-auto-deny-test",
    ui: {
      interaction: async (request) => {
        interactionRequests.push(request);
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: request.requestId,
          status: "answered",
          approved: true,
          metadata: {},
        };
      },
    },
  });
  let toolCalls = 0;
  host.registerTool({
    name: "dangerous_auto_deny",
    description: "requires approval",
    parameters: { type: "object" },
    requiresApproval: true,
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    },
  } as never);
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-approval-auto-deny",
    name: "dangerous_auto_deny",
    arguments: {},
  };
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: buildAssistant([toolCallEnvelope], "toolUse") }],
      [
        {
          type: "done",
          reason: "stop",
          message: buildAssistant([{ type: "text", text: "done" }]),
        },
      ],
    ],
  });
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
    approvalMethod: "auto",
    approvalRejectAction: "deny",
    reviewToolApproval: async () => ({
      outcome: "needs_changes",
      summary: "needs a safer command",
    }),
  });

  await loop.submit("try auto deny");

  assert.equal(toolCalls, 0);
  assert.equal(interactionRequests.length, 0);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /needs a safer command/);
});

test("SparkAgentLoop preserves tool-returned isError results", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  host.registerTool({
    name: "business_error",
    description: "returns an explicit tool error",
    parameters: { type: "object" },
    async execute() {
      return {
        content: [{ type: "text", text: "business rule failed" }],
        details: { error: "business_rule_failed" },
        isError: true,
      };
    },
  });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-business-error",
    name: "business_error",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "handled" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  await loop.submit("trigger business error");

  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /business_rule_failed/);
});

test("SparkAgentLoop unknown tool returns an isError tool result without throwing", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const toolCallEnvelope: ToolCall = {
    type: "toolCall",
    id: "tc-2",
    name: "missing",
    arguments: {},
  };
  const firstAssistant = buildAssistant([toolCallEnvelope], "toolUse");
  const finalAssistant = buildAssistant([{ type: "text", text: "fallback" }]);
  const fake = makeFakeStream({
    rounds: [
      [{ type: "done", reason: "toolUse", message: firstAssistant }],
      [{ type: "done", reason: "stop", message: finalAssistant }],
    ],
  });
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  await loop.submit("trigger missing tool");
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal(toolResult !== undefined, true);
  assert.equal((toolResult as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(toolResult), /unknown tool: missing/);
});

test("SparkAgentLoop refuses a model call to a registered but inactive tool", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-inactive-tool-test" });
  let executed = false;
  host.registerTool({
    name: "inactive_write",
    description: "must remain behind the active-tool boundary",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute() {
      executed = true;
      return { content: [{ type: "text", text: "should not execute" }] };
    },
  });
  host.setActiveTools([]);
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-inactive",
    name: "inactive_write",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "inactive call rejected" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("attempt inactive tool");

  assert.equal(executed, false);
  const toolResult = loop.getMessages().find((message) => message.role === "toolResult");
  assert.equal((toolResult as { isError?: boolean } | undefined)?.isError, true);
  assert.match(JSON.stringify(toolResult), /inactive tool: inactive_write/u);
});

test("SparkAgentLoop drainOutboxIntoMessages turns sendUserMessage envelopes into next-turn user messages", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  const firstAssistant = buildAssistant([{ type: "text", text: "first turn" }]);
  const secondAssistant = buildAssistant([{ type: "text", text: "after outbox" }]);
  let calls = 0;
  const fake: SparkAgentStreamFunction = (_model, _context) => {
    calls += 1;
    if (calls === 1) {
      // After turn 1, push a user message into the outbox so the loop runs again.
      host.sendUserMessage("follow up", { deliverAs: "steer" });
    }
    const message = calls === 1 ? firstAssistant : secondAssistant;
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
        resolve(message);
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
  });
  await loop.submit("start");
  // Expected message log: user("start"), asst1, user("follow up"), asst2
  const messages = loop.getMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[2]!.role, "user");
  assert.match(JSON.stringify(messages[2]!.content), /follow up/);
  assert.equal((messages[3] as AssistantMessage).content[0]!.type, "text");
});

test("SparkAgentLoop includes tool-enqueued outbox in the next model request", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-tool-outbox" });
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "outbox-1",
    name: "enqueue_followup",
    arguments: {},
  };
  host.registerTool({
    name: "enqueue_followup",
    description: "enqueue an outbox user message",
    parameters: { type: "object" },
    async execute() {
      host.sendUserMessage("tool follow-up", { deliverAs: "steer" });
      return { content: [{ type: "text", text: "enqueued" }] };
    },
  });
  const contexts: Message[][] = [];
  let calls = 0;
  const fake: SparkAgentStreamFunction = (_model, context) => {
    contexts.push([...(context.messages ?? [])]);
    calls += 1;
    const message =
      calls === 1
        ? buildAssistant([toolCall], "toolUse")
        : buildAssistant([{ type: "text", text: "after tool outbox" }]);
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "done" as const,
          reason: (calls === 1 ? "toolUse" : "stop") as "toolUse" | "stop",
          message,
        };
      },
      result: async () => message,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(fake),
    getModel: () => TEST_MODEL,
  });
  const outcome = await loop.submitWithOutcome("start");
  assert.equal(outcome.status, "completed");
  assert.equal(calls, 2);
  assert.match(JSON.stringify(contexts[1]), /tool follow-up/);
});

test("SparkAgentLoop consumes a non-triggering turn_end follow-up inside the current run", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-turn-end-follow-up-test" });
  const firstAssistant = buildAssistant([{ type: "text", text: "premature final" }]);
  const secondAssistant = buildAssistant([{ type: "text", text: "reconciled final" }]);
  const contexts: Message[][] = [];
  let calls = 0;
  host.on("turn_end", () => {
    if (calls !== 1) return;
    host.sendMessage(
      {
        customType: "spark-agent-end-reconciliation",
        content: "reconcile current state",
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
      { deliverAs: "followUp", triggerTurn: false },
    );
  });
  const fake: SparkAgentStreamFunction = (_model, context) => {
    contexts.push([...context.messages]);
    calls += 1;
    const message = calls === 1 ? firstAssistant : secondAssistant;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message };
      },
      result: async () => message,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  const result = await loop.submit("start");

  assert.equal(calls, 2);
  assert.equal(result.content[0]?.type, "text");
  assert.match(JSON.stringify(result.content), /reconciled final/);
  assert.match(messageContentText(contexts[1]?.at(-1)?.content), /reconcile current state/);
});

test("SparkAgentLoop triggerTurn queues hidden custom messages without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-custom-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    {
      customType: "spark-goal-request",
      content: "queued goal instruction",
      display: false,
      authority: "runtime_control",
      trust: "trusted",
    },
    { deliverAs: "followUp", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  assert.equal(eventTypes.includes("user_message"), false);
});

test("SparkAgentLoop defaults extension custom messages to untrusted runtime data", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-untrusted-custom-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "observed" }]);
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(() => {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: finalAssistant };
        },
        result: async () => finalAssistant,
      } as ReturnType<SparkAgentStreamFunction>;
    }),
    getModel: () => TEST_MODEL,
  });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-role-result", content: "model-authored result", display: false },
    { deliverAs: "followUp", triggerTurn: true },
  );

  await completed;
  const item = loop.getPromptItems().find((entry) => entry.customType === "spark-role-result");
  assert.equal(item?.authority, "runtime_data");
  assert.equal(item?.trust, "untrusted");
});

test("SparkAgentLoop retains nextTurn runtime data in its originating session", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-next-turn-test" });
  const contexts: Message[][] = [];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm((_model, context) => {
      contexts.push([...context.messages]);
      const message = buildAssistant([{ type: "text", text: "ok" }]);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message };
        },
        result: async () => message,
      } as ReturnType<SparkAgentStreamFunction>;
    }),
    getModel: () => TEST_MODEL,
  });

  loop.setViewSessionId("session-a");
  host.sendMessage(
    {
      customType: "spark-memory-checkpoint",
      deliveryId: "spark-memory-checkpoint:generation-1",
      content: "checkpoint payload",
      display: false,
    },
    { deliverAs: "nextTurn", triggerTurn: false },
  );
  host.sendMessage(
    {
      customType: "spark-memory-checkpoint",
      deliveryId: "spark-memory-checkpoint:generation-1",
      content: "checkpoint payload",
      display: false,
    },
    { deliverAs: "nextTurn", triggerTurn: false },
  );
  loop.setViewSessionId("session-b");
  await loop.submit("session b prompt");

  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.length, 1);
  assert.equal(contexts[0]?.[0]?.content, "session b prompt");

  loop.replaceMessages([]);
  loop.setViewSessionId("session-a");
  await loop.submit("session a prompt");

  assert.equal(contexts.length, 2);
  assert.equal(contexts[1]?.length, 2);
  const checkpointContext = messageContentText(contexts[1]?.[0]?.content);
  assert.match(checkpointContext, /spark-memory-checkpoint/u);
  assert.match(checkpointContext, /checkpoint payload/u);
  assert.equal(contexts[1]?.[1]?.content, "session a prompt");
  assert.equal(
    loop.getPromptItems().filter((entry) => entry.customType === "spark-memory-checkpoint").length,
    1,
  );

  host.sendMessage(
    {
      customType: "spark-memory-checkpoint",
      deliveryId: "spark-memory-checkpoint:generation-1",
      content: "checkpoint payload",
      display: false,
    },
    { deliverAs: "nextTurn", triggerTurn: false },
  );
  await loop.submit("session a second prompt");
  assert.equal(
    loop.getPromptItems().filter((entry) => entry.customType === "spark-memory-checkpoint").length,
    1,
    "a consumed checkpoint identity is not replayed",
  );
});

test("SparkAgentLoop scopes delivery ids by session and bounds consumed history", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-delivery-ledger-test" });
  const contexts: Message[][] = [];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm((_model, context) => {
      contexts.push([...context.messages]);
      const message = buildAssistant([{ type: "text", text: "ok" }]);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message };
        },
        result: async () => message,
      } as ReturnType<SparkAgentStreamFunction>;
    }),
    getModel: () => TEST_MODEL,
  });
  const checkpoint = (deliveryId: string) => ({
    customType: "spark-memory-checkpoint",
    deliveryId,
    content: deliveryId,
    display: false,
  });

  loop.setViewSessionId("session-a");
  host.sendMessage(checkpoint("shared-id"), { deliverAs: "nextTurn", triggerTurn: false });
  loop.setViewSessionId("session-b");
  host.sendMessage(checkpoint("shared-id"), { deliverAs: "nextTurn", triggerTurn: false });
  await loop.submit("session b prompt");
  assert.match(messageContentText(contexts[0]?.[0]?.content), /shared-id/u);

  loop.replaceMessages([]);
  loop.setViewSessionId("session-a");
  await loop.submit("session a prompt");
  assert.match(messageContentText(contexts[1]?.[0]?.content), /shared-id/u);

  loop.replaceMessages([]);
  loop.setViewSessionId("bounded-session");
  for (let index = 0; index <= 256; index += 1) {
    host.sendMessage(checkpoint(`bounded-${index}`), {
      deliverAs: "nextTurn",
      triggerTurn: false,
    });
  }
  await loop.submit("fill bounded delivery history");

  loop.replaceMessages([]);
  host.sendMessage(checkpoint("bounded-0"), { deliverAs: "nextTurn", triggerTurn: false });
  await loop.submit("replay evicted delivery");
  assert.match(
    messageContentText(contexts.at(-1)?.[0]?.content),
    /bounded-0/u,
    "the oldest identity is evicted once the bounded per-session history is full",
  );

  for (let index = 0; index <= 64; index += 1) {
    loop.replaceMessages([]);
    loop.setViewSessionId(`lru-session-${index}`);
    host.sendMessage(checkpoint("session-lru-id"), {
      deliverAs: "nextTurn",
      triggerTurn: false,
    });
    await loop.submit(`fill session ledger ${index}`);
  }
  loop.replaceMessages([]);
  loop.setViewSessionId("lru-session-0");
  host.sendMessage(checkpoint("session-lru-id"), {
    deliverAs: "nextTurn",
    triggerTurn: false,
  });
  await loop.submit("replay evicted session delivery");
  assert.match(
    messageContentText(contexts.at(-1)?.[0]?.content),
    /session-lru-id/u,
    "the oldest session ledger is evicted once the bounded session history is full",
  );
});

test("SparkAgentLoop triggerTurn uses queued user instruction without duplicate custom", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-user-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let contextMessages: Message[] = [];
  const fake: SparkAgentStreamFunction = (_model, context) => {
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendUserMessage("queued goal instruction", { deliverAs: "followUp" });
  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.content, "queued goal instruction");
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
});

test("SparkAgentLoop triggerTurn runs hidden before_agent_start context without visible user echo", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-trigger-turn-test" });
  const finalAssistant = buildAssistant([{ type: "text", text: "goal tick executed" }]);
  let streamCalls = 0;
  let contextMessages: Message[] = [];
  const eventTypes: string[] = [];
  const lifecycleSources: unknown[] = [];
  host.on("before_agent_start", (event) => {
    lifecycleSources.push((event as { source?: unknown }).source);
    return {
      message: {
        customType: "spark-phase-context",
        content: "hidden context payload",
        display: false,
        authority: "runtime_control",
        trust: "trusted",
      },
    };
  });
  const fake: SparkAgentStreamFunction = (_model, context) => {
    streamCalls += 1;
    contextMessages = [...context.messages];
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: finalAssistant };
      },
      result: async () => finalAssistant,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  const completed = new Promise<void>((resolve) => {
    loop.onEvent((event) => {
      eventTypes.push(event.type);
      if (event.type === "turn_complete") resolve();
    });
  });

  host.sendMessage(
    { customType: "spark-goal-request", content: "queued goal instruction", display: false },
    { deliverAs: "nextTurn", triggerTurn: true },
  );

  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(streamCalls, 1);
  assert.equal(loop.getState(), "idle");
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0]?.role, "user");
  const contextContent = messageContentText(contextMessages[0]?.content);
  assert.match(contextContent, /<spark_runtime_control trust="trusted"/);
  assert.match(contextContent, /custom_type="spark-phase-context"/);
  assert.match(contextContent, /hidden context payload/);
  assert.doesNotMatch(JSON.stringify(loop.getMessages()), /spark-goal-request/);
  assert.equal(eventTypes.includes("user_message"), false);
  assert.deepEqual(lifecycleSources, ["triggerTurn"]);
  const runtimeItem = loop
    .getPromptItems()
    .find((item) => item.customType === "spark-phase-context");
  assert.equal(runtimeItem?.authority, "runtime_control");
  assert.equal(runtimeItem?.trust, "trusted");
  assert.equal(runtimeItem?.visibility, "hidden");
  assert.equal(runtimeItem?.persistence, "transient");
});

test("SparkAgentLoop abort cancels the in-flight stream and returns to idle", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let aborted = false;
  const fake: SparkAgentStreamFunction = (_model, _context, options) => {
    let resolve!: (value: AssistantMessage) => void;
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolve = r;
    });
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
      resolve(buildAssistant([{ type: "text", text: "aborted" }], "aborted"));
    });
    return {
      async *[Symbol.asyncIterator]() {
        // Wait forever until aborted
        await new Promise<void>((r) => {
          options?.signal?.addEventListener("abort", () => r());
        });
        yield {
          type: "error",
          reason: "aborted",
          error: buildAssistant([], "aborted"),
        };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  const promise = loop.submitWithOutcome("hang");
  // Abort after a microtask to ensure the loop entered streaming
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("test_abort");
  const outcome = await promise;
  assert.equal(aborted, true, "abort signal fired");
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.assistant.stopReason, "aborted");
  if (outcome.status === "aborted") assert.equal(outcome.reason, "test_abort");
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop classifies a provider AbortError caused by user abort as aborted", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-abort-throw-test" });
  const fake: SparkAgentStreamFunction = (_model, _context, options) =>
    ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            const error = new Error("provider cancelled request");
            error.name = "AbortError";
            throw error;
          },
        };
      },
      result: async () => buildAssistant([], "aborted"),
    }) as ReturnType<SparkAgentStreamFunction>;
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });

  const running = loop.submitWithOutcome("hang then throw");
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  if (outcome.status === "aborted") assert.equal(outcome.reason, "switch_session");
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop abort releases a pending human tool approval", async () => {
  let toolCalls = 0;
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-approval-abort-test",
    ui: {
      interaction: async () => await new Promise<never>(() => undefined),
    },
  });
  host.registerTool({
    name: "approval_wait",
    description: "wait for human approval",
    parameters: { type: "object" },
    policy: { effect: "local_write", approval: "required" },
    async execute() {
      toolCalls += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  } as never);
  const toolCall: ToolCall = {
    type: "toolCall",
    id: "tc-approval-abort",
    name: "approval_wait",
    arguments: {},
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([toolCall], "toolUse") }],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
    approvalMethod: "human",
    interactionTimeoutMs: 60_000,
  });

  const running = loop.submitWithOutcome("ask then cancel");
  await new Promise<void>((resolve) => setImmediate(resolve));
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  assert.equal(toolCalls, 0);
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop pairs every sequential tool call with an aborted result", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-sequential-abort-test" });
  let firstStarted = false;
  let secondExecutions = 0;
  host.registerTool({
    name: "slow_sequential_tool",
    description: "waits until the run is aborted",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute(_toolCallId, _params, signal) {
      firstStarted = true;
      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { content: [{ type: "text", text: "unreachable" }] };
    },
  });
  host.registerTool({
    name: "later_sequential_tool",
    description: "must be paired but not executed after abort",
    parameters: { type: "object" },
    policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
    async execute() {
      secondExecutions += 1;
      return { content: [{ type: "text", text: "must not run" }] };
    },
  });
  const toolCalls: ToolCall[] = [
    { type: "toolCall", id: "tc-abort-first", name: "slow_sequential_tool", arguments: {} },
    { type: "toolCall", id: "tc-abort-later", name: "later_sequential_tool", arguments: {} },
  ];
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant(toolCalls, "toolUse") }],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  const running = loop.submitWithOutcome("start then abort sequential tools");
  await waitForCondition(() => firstStarted, "the first sequential tool should start");
  loop.abort("switch_session");
  const outcome = await running;

  assert.equal(outcome.status, "aborted");
  assert.equal(secondExecutions, 0);
  const results = loop
    .getMessages()
    .filter((message): message is ToolResultMessage => message.role === "toolResult");
  assert.deepEqual(
    results.map((message) => message.toolCallId),
    ["tc-abort-first", "tc-abort-later"],
  );
  assert.deepEqual(
    results.map((message) => message.isError),
    [true, true],
  );
  assert.match(toolResultText(results[1]), /skipped because the agent was aborted/u);
});

test("SparkAgentLoop refuses concurrent submit while in flight", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-test" });
  let resolveStream!: (message: AssistantMessage) => void;
  const fake: SparkAgentStreamFunction = () => {
    const resultPromise = new Promise<AssistantMessage>((r) => {
      resolveStream = r;
    });
    return {
      async *[Symbol.asyncIterator]() {
        const message = await resultPromise;
        yield { type: "done", reason: "stop", message };
      },
      result: () => resultPromise,
    } as ReturnType<SparkAgentStreamFunction>;
  };
  const loop = new SparkAgentLoop({ host, llm: asSparkTurnLlm(fake), getModel: () => TEST_MODEL });
  const first = loop.submit("first");
  await new Promise<void>((r) => setImmediate(r));
  await assert.rejects(loop.submit("second"), /not idle/);
  resolveStream(buildAssistant([{ type: "text", text: "ok" }]));
  await first;
  assert.equal(loop.getState(), "idle");
});

test("SparkAgentLoop strips provider-filled blank optional arguments before dispatch", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-optional-args-test" });
  let executedArgs: Record<string, unknown> | undefined;
  host.registerTool({
    name: "optional_args_probe",
    description: "records normalized optional arguments",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        artifactRef: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["action"],
    },
    policy: { effect: "read", executionMode: "parallel", approval: "none" },
    async execute(_id: string, args: Record<string, unknown>) {
      executedArgs = args;
      return { content: [{ type: "text", text: "normalized" }] };
    },
  } as never);
  const call: ToolCall = {
    type: "toolCall",
    id: "optional-args-call",
    name: "optional_args_probe",
    arguments: { action: "inspect", artifactRef: "", cwd: "   " },
  };
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [{ type: "done", reason: "toolUse", message: buildAssistant([call], "toolUse") }],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("normalize optional args");

  assert.deepEqual(executedArgs, { action: "inspect" });
});

test("SIDE-EFFECT-003 SparkAgentLoop rechecks host effect policy immediately before dispatch", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-agent-loop-read-only-dispatch-test",
    allowedToolEffects: ["read"],
  });
  let readExecutions = 0;
  let writeExecutions = 0;
  host.registerTool({
    name: "inspect",
    description: "safe read",
    parameters: { type: "object" },
    policy: { effect: "read", approval: "none" },
    async execute() {
      readExecutions += 1;
      return { content: [{ type: "text", text: "read result" }] };
    },
  });
  host.registerTool({
    name: "mutate",
    description: "must remain blocked",
    parameters: { type: "object" },
    policy: { effect: "local_write", approval: "none" },
    async execute() {
      writeExecutions += 1;
      return { content: [{ type: "text", text: "write result" }] };
    },
  });

  // The model may emit a stale schema. Even if a caller corrupts the public
  // active bit, the host guard is consulted directly before execute().
  const mutateTool = host.getTool("mutate");
  assert.ok(mutateTool);
  mutateTool.active = true;
  const loop = new SparkAgentLoop({
    host,
    llm: asSparkTurnLlm(
      makeFakeStream({
        rounds: [
          [
            {
              type: "done",
              reason: "toolUse",
              message: buildAssistant(
                [
                  { type: "toolCall", id: "read-call", name: "inspect", arguments: {} },
                  { type: "toolCall", id: "write-call", name: "mutate", arguments: {} },
                ],
                "toolUse",
              ),
            },
          ],
          [
            {
              type: "done",
              reason: "stop",
              message: buildAssistant([{ type: "text", text: "done" }]),
            },
          ],
        ],
      }),
    ),
    getModel: () => TEST_MODEL,
  });

  await loop.submit("inspect then mutate");

  assert.equal(readExecutions, 1);
  assert.equal(writeExecutions, 0);
  const results = loop
    .getMessages()
    .filter((message): message is ToolResultMessage => message.role === "toolResult");
  assert.equal(results[0]?.isError, false);
  assert.equal(results[1]?.isError, true);
  assert.match(toolResultText(results[1]), /denied by host policy: mutate/u);
});

test("SparkAgentLoop runs a structural llm through an explicit isolated test runtime", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-agent-loop-llm-only" });
  const llm: SparkTurnLlm = {
    async *stream() {
      yield { type: "text-delta", index: 0, text: "hello from llm" };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
    createDshTestRuntime: createSparkDshTurnTestRuntime,
  };
  const loop = new SparkAgentLoop({
    host,
    llm,
    getModel: () => TEST_MODEL,
    streamIdleTimeoutMs: 0,
  });
  assert.equal("ctx" in loop, false);
  const outcome = await loop.submitWithOutcome("hi");
  assert.equal(outcome.status, "completed");
  if (outcome.status !== "completed") assert.fail("expected completed outcome");
  assert.match(JSON.stringify(outcome.assistant.content), /hello from llm/u);
});
