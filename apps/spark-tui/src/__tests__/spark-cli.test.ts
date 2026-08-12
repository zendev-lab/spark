import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isNormalizedBaiduContextOverflow,
  normalizeBaiduOneApiEvent,
  normalizeBaiduOneApiMessage,
  normalizeBaiduOneApiStream,
  remapBaiduOneApiPayload,
  repairBaiduOneApiSseLine,
  resolveBaiduOneApiKey,
  streamBaiduOneApiAnthropic,
  streamBaiduOneApiOpenAIResponses,
} from "@zendev-lab/spark-ai/baidu-oneapi-provider";
import {
  handleSparkRpcLine,
  parseSparkCliArgs,
  parseSparkCliCommand,
  runSparkCli,
  sparkTuiReloadArgv,
  type SparkRpcState,
} from "../cli.ts";
import type { SparkDaemonClientOptions } from "../cli/daemon.ts";
import {
  SparkNativeAdmissionError,
  SparkNativeSession,
  type SparkNativeAdmissionContext,
  type SparkNativeResponder,
  type SparkNativeResponderContext,
} from "../native-tui.ts";
import {
  SPARK_PROTOCOL_VERSION,
  type SparkInvocationRetryResult,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";
import sparkCliHostExtension from "../spark-host-extension.ts";

test("parseSparkCliArgs treats positional args as the initial message", () => {
  assert.deepEqual(parseSparkCliArgs(["hello", "spark"]), {
    help: false,
    initialMessage: "hello spark",
  });
});

test("sparkTuiReloadArgv keeps runtime overrides but pins one durable session", () => {
  assert.deepEqual(
    sparkTuiReloadArgv(
      {
        provider: "provider-a",
        model: "model-a",
        session: "old.jsonl",
        sessionId: "old-session",
        sparkSessionKey: "session:old-session",
        sessionDir: ".spark-home",
        noSession: true,
        wait: true,
        name: "named session",
        extensions: ["extension-a"],
        noExtensions: true,
        skills: ["skill-a"],
        noSkills: true,
        promptTemplates: ["prompt-a"],
        noPromptTemplates: true,
        themes: ["theme-a"],
        noThemes: true,
        noContextFiles: true,
        thinking: "xhigh",
        tools: ["Read", "Write"],
        excludeTools: ["Bash"],
        projectTrustOverride: false,
        fileArgs: ["README.md"],
      },
      "durable-session",
    ),
    [
      "--provider",
      "provider-a",
      "--model",
      "model-a",
      "--session-dir",
      ".spark-home",
      "--name",
      "named session",
      "--extension",
      "extension-a",
      "--no-extensions",
      "--skill",
      "skill-a",
      "--no-skills",
      "--prompt-template",
      "prompt-a",
      "--no-prompt-templates",
      "--theme",
      "theme-a",
      "--no-themes",
      "--no-context-files",
      "--thinking",
      "xhigh",
      "--tools",
      "Read,Write",
      "--exclude-tools",
      "Bash",
      "--no-approve",
      "--session-id",
      "durable-session",
    ],
  );
});

test("runSparkCli rejects implicit TUI launch in non-interactive terminals", async () => {
  const errors: string[] = [];
  const previousError = console.error;
  let ranTui = false;
  try {
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    const code = await runSparkCli([], {
      terminal: { stdinIsTTY: false, stdoutIsTTY: true },
      runTui: async () => {
        ranTui = true;
      },
    });

    assert.equal(code, 2);
    assert.equal(ranTui, false);
    assert.match(errors.join("\n"), /requires an interactive terminal/u);
    assert.match(errors.join("\n"), /spark run <prompt>/u);
  } finally {
    console.error = previousError;
  }
});

function fakeHeadlessDaemonClient(
  submissions: Array<{ sessionId: string; prompt: string; reset?: boolean }> = [],
): SparkDaemonClientOptions {
  const now = new Date(0).toISOString();
  const sessions: Array<{
    sessionId: string;
    scope: { kind: "workspace"; workspaceId: string };
    workspaceId: string;
    status: "ready" | "archived";
    bindings: [];
    createdAt: string;
    updatedAt: string;
    cwd?: string;
  }> = [];
  const workspace = {
    id: "ws_test",
    serverUrl: "http://127.0.0.1:0",
    localWorkspaceKey: "repo",
    displayName: "repo",
    localPath: process.cwd(),
    status: "active",
  };
  const clientLease = {
    id: "client_test",
    workspaceId: workspace.id,
    kind: "headless" as const,
    status: "connected" as const,
    attachedAt: now,
    lastSeenAt: now,
  };
  return {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    }),
    workspaceEnsureLocal: async () => workspace,
    workspaceClientAttach: async () => ({ client: clientLease, workspace, observedAt: now }),
    workspaceClientRelease: async () => ({ client: clientLease, workspace, observedAt: now }),
    managedSessions: {
      list: async () => sessions,
      create: async (input) => {
        const record = {
          sessionId: input.sessionId!,
          scope: input.scope as { kind: "workspace"; workspaceId: string },
          workspaceId: input.workspaceId!,
          status: "ready" as const,
          bindings: [] as [],
          createdAt: now,
          updatedAt: now,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        };
        sessions.push(record);
        return record;
      },
      get: async (sessionId) => sessions.find((session) => session.sessionId === sessionId)!,
      bind: async (sessionId) => sessions.find((session) => session.sessionId === sessionId)!,
      unbind: async (sessionId) => sessions.find((session) => session.sessionId === sessionId)!,
      archive: async (sessionId) => {
        const index = sessions.findIndex((session) => session.sessionId === sessionId);
        sessions[index] = { ...sessions[index]!, status: "archived", updatedAt: now };
        return sessions[index]!;
      },
    },
    turnSubmit: async (_paths, input) => {
      submissions.push(input);
      return { invocationId: "inv_turn", status: "queued" as const, acceptedAt: now };
    },
  } satisfies SparkDaemonClientOptions;
}

test("runSparkCli keeps native run mode usable without an interactive terminal", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient = fakeHeadlessDaemonClient(submissions);

  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const code = await runSparkCli(["run", "hello", "spark"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });

    assert.equal(code, 0);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.prompt, "hello spark");
    assert.match(logs.join("\n"), /inv_turn/u);
  } finally {
    console.log = previousLog;
  }
});

test("runSparkCli JSON run emits documented JSONL event order", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient = fakeHeadlessDaemonClient(submissions);

  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    const code = await runSparkCli(["run", "--json", "hello", "spark"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });

    assert.equal(code, 0);
    const events = logs.map((line) => JSON.parse(line) as { type: string; result?: unknown });
    assert.deepEqual(
      events.map((event) => event.type),
      ["session", "agent_start", "turn_start", "queue_update", "turn_end", "agent_end"],
    );
    assert.deepEqual((events[3] as { followUp?: string[] }).followUp, ["hello spark"]);
    assert.equal(
      (events[4]?.result as { result?: { invocationId?: string } })?.result?.invocationId,
      "inv_turn",
    );
  } finally {
    console.log = previousLog;
  }
});

test("handleSparkRpcLine abort cancels the last submitted daemon turn", async () => {
  const writes: Record<string, unknown>[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const cancellations: Array<{ invocationId: string; reason?: string }> = [];
  const now = new Date(0).toISOString();
  const daemonClient = {
    daemonStatus: async () => ({
      observedAt: now,
      servers: [],
      invocations: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    }),
    turnSubmit: async (_paths, input) => {
      submissions.push(input);
      return { invocationId: "inv_turn_file", status: "queued" as const, acceptedAt: now };
    },
    turnCancel: async (_paths, input) => {
      cancellations.push(input);
      return {
        invocationId: input.invocationId,
        status: "running" as const,
        cancelRequested: true,
      };
    },
  } satisfies SparkDaemonClientOptions;
  const state: SparkRpcState = {};

  await handleSparkRpcLine(
    JSON.stringify({ id: "prompt-1", type: "prompt", message: "do work" }),
    daemonClient,
    { sessionId: "rpc-session" },
    (value) => writes.push(value),
    state,
  );
  await handleSparkRpcLine(
    JSON.stringify({ id: "abort-1", type: "abort" }),
    daemonClient,
    { sessionId: "rpc-session" },
    (value) => writes.push(value),
    state,
  );

  assert.equal(submissions.length, 1);
  assert.deepEqual(
    {
      sessionId: submissions[0]?.sessionId,
      prompt: submissions[0]?.prompt,
      reset: submissions[0]?.reset,
    },
    { sessionId: "rpc-session", prompt: "do work", reset: undefined },
  );
  assert.match(submissions[0]?.idempotencyKey ?? "", /^turn\.submit:spark_cli_/u);
  assert.deepEqual(cancellations, [
    { invocationId: "inv_turn_file", reason: "Spark RPC abort requested by client." },
  ]);
  assert.equal(writes.at(-1)?.success, true);
  assert.deepEqual(writes.at(-1)?.data, {
    invocationId: "inv_turn_file",
    status: "running",
    cancelRequested: true,
  });
});

test("handleSparkRpcLine abort reports no target without an invocation", async () => {
  const writes: Record<string, unknown>[] = [];
  await handleSparkRpcLine(
    JSON.stringify({ id: "abort-missing", type: "abort" }),
    {},
    undefined,
    (value) => writes.push(value),
  );

  assert.equal(writes[0]?.success, false);
  assert.match(String(writes[0]?.error), /abort requires invocationId/u);
});

test("Baidu OneAPI payload keeps gateway model spelling", () => {
  assert.deepEqual(remapBaiduOneApiPayload({ model: "claude-opus-5", x: 1 }, "Opus 5"), {
    model: "Opus 5",
    x: 1,
  });
});

test("Baidu OneAPI payload forces adaptive thinking for gateway Opus models", () => {
  assert.deepEqual(
    remapBaiduOneApiPayload(
      {
        model: "claude-opus-5",
        thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
      },
      "Opus 5",
      "xhigh",
    ),
    {
      model: "Opus 5",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    },
  );
});

test("Baidu OneAPI key resolver uses only dedicated auth identity", () => {
  const previousBaiduKey = process.env.BAIDU_ONEAPI_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  try {
    delete process.env.BAIDU_ONEAPI_API_KEY;
    process.env.OPENAI_API_KEY = "openai-fallback-key";
    assert.equal(resolveBaiduOneApiKey("BAIDU_ONEAPI_API_KEY"), undefined);
    assert.equal(resolveBaiduOneApiKey(undefined), undefined);
    assert.throws(
      () => resolveBaiduOneApiKey("OPENAI_API_KEY"),
      /baidu-oneapi does not accept OPENAI_API_KEY/,
    );

    process.env.BAIDU_ONEAPI_API_KEY = "baidu-key";
    assert.equal(resolveBaiduOneApiKey("BAIDU_ONEAPI_API_KEY"), "baidu-key");
    assert.equal(resolveBaiduOneApiKey("resolved-key"), "resolved-key");
  } finally {
    if (previousBaiduKey === undefined) delete process.env.BAIDU_ONEAPI_API_KEY;
    else process.env.BAIDU_ONEAPI_API_KEY = previousBaiduKey;

    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});

test("Baidu OneAPI normalizes only explicit context overflow errors for Pi recovery", async () => {
  const base = {
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages" as never,
    provider: "anthropic" as never,
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    timestamp: Date.now(),
  };
  const source =
    "Context window is full — reduce conversation history, tool/file output, or system prompt.";
  const normalized = normalizeBaiduOneApiMessage({ ...base, errorMessage: source });
  assert.equal(normalized.errorMessage, `context_length_exceeded: ${source}`);
  assert.equal(normalized.errorMessage?.includes(source), true);
  assert.equal(isNormalizedBaiduContextOverflow(normalized), true);
  assert.equal(
    isNormalizedBaiduContextOverflow(
      normalizeBaiduOneApiMessage({ ...base, errorMessage: "Maximum context length exceeded" }),
    ),
    true,
  );
  assert.equal(
    isNormalizedBaiduContextOverflow(
      normalizeBaiduOneApiMessage({
        ...base,
        errorMessage: "Prompt is too long for the context window",
      }),
    ),
    true,
  );

  const ordinary400 = normalizeBaiduOneApiMessage({
    ...base,
    errorMessage: "HTTP 400 Bad Request",
  });
  assert.equal(ordinary400.errorMessage, "HTTP 400 Bad Request");
  assert.equal(isNormalizedBaiduContextOverflow(ordinary400), false);

  const partial = normalizeBaiduOneApiEvent({
    type: "text_delta",
    contentIndex: 0,
    delta: "",
    partial: { ...base, errorMessage: source },
  });
  assert.ok("partial" in partial);
  assert.equal(isNormalizedBaiduContextOverflow(partial.partial), true);
  const done = normalizeBaiduOneApiEvent({
    type: "done",
    reason: "stop",
    message: { ...base, errorMessage: source },
  });
  assert.ok("message" in done);
  assert.equal(isNormalizedBaiduContextOverflow(done.message), true);
  const error = normalizeBaiduOneApiEvent({
    type: "error",
    reason: "error",
    error: { ...base, errorMessage: source },
  });
  assert.ok("error" in error);
  assert.equal(isNormalizedBaiduContextOverflow(error.error), true);
});

test("Baidu OneAPI stream wrapper normalizes done error and result paths for both transports", async () => {
  const source =
    "Context window is full — reduce conversation history, tool/file output, or system prompt.";
  const base = {
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages" as never,
    provider: "anthropic" as never,
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: source,
    timestamp: Date.now(),
  };

  for (const transport of ["anthropic-messages", "openai-responses"] as const) {
    const upstream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", reason: "stop", message: { ...base, api: transport } } as never;
        yield { type: "error", reason: "error", error: { ...base, api: transport } } as never;
      },
      async result() {
        return { ...base, api: transport };
      },
    };
    const stream = normalizeBaiduOneApiStream(upstream as never);
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "done");
    assert.equal(events[1]?.type, "error");
    if (events[0]?.type === "done") {
      assert.equal(events[0].message.api, "baidu-oneapi");
      assert.equal(isNormalizedBaiduContextOverflow(events[0].message), true);
    }
    if (events[1]?.type === "error") {
      assert.equal(events[1].error.api, "baidu-oneapi");
      assert.equal(isNormalizedBaiduContextOverflow(events[1].error), true);
    }
    const result = await stream.result();
    assert.equal(result.api, "baidu-oneapi");
    assert.equal(result.provider, "baidu-oneapi");
    assert.equal(result.errorMessage?.includes(source), true);
    assert.equal(isNormalizedBaiduContextOverflow(result), true);
  }
});

test("Baidu OneAPI adapters use upstream transport APIs but report baidu-oneapi", async () => {
  const context = { messages: [], tools: [] };
  const baseModel = {
    name: "Baidu test model",
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    baseUrl: "https://oneapi-comate.baidu-int.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };

  for (const stream of [
    streamBaiduOneApiAnthropic({ ...baseModel, id: "claude-opus-5" } as never, context as never, {
      apiKey: "",
    }),
    streamBaiduOneApiOpenAIResponses(
      {
        ...baseModel,
        id: "gpt-5.6-sol",
        baseUrl: "https://oneapi-comate.baidu-int.com/v1",
      } as never,
      context as never,
      { apiKey: "" },
    ),
  ]) {
    for await (const _event of stream) void _event;
    const result = await stream.result();
    assert.equal(result.api, "baidu-oneapi");
    assert.equal(result.provider, "baidu-oneapi");
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No API key for provider: baidu-oneapi/);
    assert.doesNotMatch(result.errorMessage ?? "", /Mismatched api/);
  }
});

const malformedResponsesSse = `data: ${JSON.stringify({
  type: "response.in_progress",
  response: { id: "resp_bad_1", status: "in_progress" },
})}${JSON.stringify({
  type: "response.in_progress",
  response: { id: "resp_bad_2", status: "in_progress" },
})}\n\n`;
const truncatedResponsesSse =
  'data: {"type":"response.in_progress","response":{"id":"resp_truncated","status":"in_progress","instructions":"cons\n\n';
const completedResponseEvent = {
  type: "response.completed",
  response: {
    id: "resp_ok",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
};
const completedResponsesSse = `data: ${JSON.stringify(completedResponseEvent)}\n\n`;
const trailingColonResponsesSse = `data: ${JSON.stringify(completedResponseEvent)}:\n\n`;

function responsesSse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("Baidu OneAPI sends the system prompt once as top-level Responses instructions", async () => {
  const originalFetch = globalThis.fetch;
  const systemPrompt = "SPARK_RESPONSES_INSTRUCTIONS_SENTINEL";
  let requestPayload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requestPayload = (await request.clone().json()) as Record<string, unknown>;
    return responsesSse(completedResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { systemPrompt, messages: [], tools: [] },
      { apiKey: "test-key", maxRetryDelayMs: 1 },
    );
    for await (const _event of stream) void _event;

    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal(requestPayload?.instructions, systemPrompt);
    assert.doesNotMatch(JSON.stringify(requestPayload?.input), new RegExp(systemPrompt, "u"));
    assert.equal(JSON.stringify(requestPayload).split(systemPrompt).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI SSE repair removes only the observed trailing colon from a complete response event", () => {
  const event = {
    type: "response.in_progress",
    response: { id: "resp_wire", status: "in_progress", sequence_number: 1 },
  };
  const malformed = `data: ${JSON.stringify(event)}:`;
  assert.equal(repairBaiduOneApiSseLine(malformed), `data: ${JSON.stringify(event)}`);
  assert.equal(
    repairBaiduOneApiSseLine('data: {"type":"response.in_progress"}:junk:'),
    'data: {"type":"response.in_progress"}:junk:',
  );
  assert.equal(
    repairBaiduOneApiSseLine('data: {"type":"other.event"}:'),
    'data: {"type":"other.event"}:',
  );
});

test("Baidu OneAPI direct Responses stream repairs the observed trailing-colon SSE defect", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(trailingColonResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetries: 0, maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    const result = await stream.result();
    assert.equal(fetchCalls, 1);
    assert.deepEqual(eventTypes, ["start", "done"]);
    assert.equal(result.stopReason, "stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream retries malformed wire envelopes without SDK parser logs", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const previousOpenAiLog = process.env.OPENAI_LOG;
  const sdkErrors: unknown[][] = [];
  let fetchCalls = 0;
  process.env.OPENAI_LOG = "debug";
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(fetchCalls === 1 ? malformedResponsesSse : completedResponsesSse);
  }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    sdkErrors.push(args);
  };

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 2);
    assert.deepEqual(eventTypes, ["start", "done"]);
    assert.equal((await stream.result()).stopReason, "stop");
    assert.deepEqual(sdkErrors, []);
    assert.equal(process.env.OPENAI_LOG, "debug");
  } finally {
    if (previousOpenAiLog === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousOpenAiLog;
    console.error = originalError;
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream retries truncated JSON before visible output", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(fetchCalls === 1 ? truncatedResponsesSse : completedResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 2);
    assert.deepEqual(eventTypes, ["start", "done"]);
    assert.equal((await stream.result()).stopReason, "stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream exhausts its bounded default retry budget", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(malformedResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 4);
    assert.deepEqual(eventTypes, ["start", "error"]);
    assert.equal((await stream.result()).stopReason, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream honors disabled provider retries", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(malformedResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetries: 0, maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(eventTypes, ["start", "error"]);
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /Unexpected non-whitespace character after JSON/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream does not retry after visible output", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  const textStart = `data: ${JSON.stringify({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message",
      id: "msg_partial",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  })}\n\n`;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return responsesSse(`${textStart}${malformedResponsesSse}`);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(eventTypes, ["start", "text_start", "error"]);
    assert.equal((await stream.result()).stopReason, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Baidu OneAPI direct Responses stream does not retry after cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    controller.abort(new Error("cancelled by test"));
    return responsesSse(malformedResponsesSse);
  }) as typeof fetch;

  try {
    const stream = streamBaiduOneApiOpenAIResponses(
      baiduTestModel(),
      { messages: [], tools: [] },
      { apiKey: "test-key", signal: controller.signal, maxRetryDelayMs: 1 },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(eventTypes, ["start", "error"]);
    assert.equal((await stream.result()).stopReason, "aborted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function baiduTestModel() {
  return {
    id: "gpt-5.6-sol",
    name: "Baidu test model",
    api: "baidu-oneapi",
    provider: "baidu-oneapi",
    baseUrl: "https://oneapi-comate.baidu-int.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  } as never;
}

test("Spark CLI host lets ordinary input reach the agent without /spark wrapping", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
  });

  const result = handlers.get("input")?.({ text: "build the CLI", source: "interactive" }, {});

  assert.deepEqual(result, { action: "continue" });
});

test("Spark native session queues steering updates while processing", async () => {
  let releaseFirst: ((value: string) => void) | undefined;
  const calls: string[] = [];
  const session = new SparkNativeSession(async (input) => {
    calls.push(input);
    if (input === "first") {
      return await new Promise<string>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return `done ${input}`;
  });

  assert.equal(await session.submit("first"), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isProcessing, true);

  assert.equal(await session.submit("second"), "queued");
  assert.equal(session.queuedCount, 1);
  assert.deepEqual(calls, ["first"]);

  releaseFirst?.("done first");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.isProcessing, false);
  assert.equal(session.queuedCount, 0);
  assert.equal(calls[0], "first");
  assert.match(calls[1] ?? "", /^Steering update for the previous Spark turn\./);
  assert.match(calls[1] ?? "", /Steering 1:\nsecond/);
});

test("Spark native session admits busy input to the daemon before observing it", async () => {
  let releaseFirst: (() => void) | undefined;
  const admitted: Array<{ prompt: string; submissionId?: string; invocationId: string }> = [];
  const observed: string[] = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (prompt: string, context: SparkNativeAdmissionContext) => {
        const invocationId = `inv_${admitted.length + 1}`;
        admitted.push({ prompt, submissionId: context.submissionId, invocationId });
        return {
          invocationId,
          status: "queued" as const,
          acceptedAt: `2026-07-28T00:00:0${admitted.length}.000Z`,
        };
      },
      observe: async (admission: SparkTurnSubmitResult, _context: SparkNativeResponderContext) => {
        observed.push(admission.invocationId);
        if (admission.invocationId === "inv_1") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return `done ${admission.invocationId}`;
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  assert.equal(await session.submit("first", { submissionId: "idem_first" }), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await session.submit("second", {
      mode: "steer",
      submissionId: "idem_second",
    }),
    "queued",
  );
  assert.equal(
    await session.submit("third", {
      mode: "followUp",
      submissionId: "idem_third",
    }),
    "queued",
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    admitted.map(({ submissionId }) => submissionId),
    ["idem_first", "idem_second", "idem_third"],
  );
  assert.equal(admitted[0]?.prompt, "first");
  assert.equal(admitted[1]?.prompt, "second");
  assert.equal(admitted[2]?.prompt, "third");
  assert.deepEqual(observed, ["inv_1"]);
  assert.deepEqual(session.queuedInputs, []);
  assert.deepEqual(
    session.daemonPending.map(({ invocationId }) => invocationId),
    ["inv_1", "inv_2", "inv_3"],
  );

  releaseFirst?.();
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(observed, ["inv_1", "inv_2", "inv_3"]);
  assert.equal(session.isProcessing, false);
  assert.deepEqual(session.daemonPending, []);
});

test("Spark native session resumes snapshot-owned invocations without resubmitting them", async () => {
  const admitted: string[] = [];
  const observed: string[] = [];
  const releases = new Map<string, () => void>();
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (prompt: string) => {
        admitted.push(prompt);
        throw new Error("attached work must not be resubmitted");
      },
      observe: async (admission: SparkTurnSubmitResult) => {
        observed.push(admission.invocationId);
        await new Promise<void>((resolve) => releases.set(admission.invocationId, resolve));
        return "";
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
      status: async (invocationId: string) => ({
        invocationId,
        sessionId: "attached",
        status: "succeeded" as const,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:03.000Z",
        finishedAt: "2026-07-28T00:00:03.000Z",
        eventCursor: 0,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  session.applySessionView({
    ...session.toSessionView("attached"),
    messages: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "attached-user",
        role: "user",
        text: "already durable",
        status: "done",
        metadata: {},
      },
    ],
    pendingTurns: [
      {
        invocationId: "inv_queued",
        prompt: "queued next",
        status: "queued",
        createdAt: "2026-07-28T00:00:01.000Z",
      },
      {
        invocationId: "inv_running",
        prompt: "already durable",
        status: "running",
        createdAt: "2026-07-28T00:00:02.000Z",
      },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(admitted, []);
  assert.deepEqual(observed, ["inv_running"]);
  assert.equal(session.messages.filter(({ role }) => role === "user").length, 1);

  releases.get("inv_running")?.();
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(observed, ["inv_running", "inv_queued"]);

  releases.get("inv_queued")?.();
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.isProcessing, false);
  assert.deepEqual(session.daemonPending, []);
});

test("Spark native session makes definitively rejected admissions recoverable", async () => {
  let releaseFirst: (() => void) | undefined;
  const observed: string[] = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (_prompt: string, context: SparkNativeAdmissionContext) => {
        if (context.submissionId === "idem_rejected_second") {
          throw new SparkNativeAdmissionError("workspace policy rejected the turn", "rejected");
        }
        return {
          invocationId: "inv_rejected_first",
          status: "running" as const,
          acceptedAt: "2026-07-28T00:00:00.000Z",
        };
      },
      observe: async (admission: SparkTurnSubmitResult) => {
        observed.push(admission.invocationId);
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "first complete";
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("first", { submissionId: "idem_rejected_first" });
  await new Promise((resolve) => setImmediate(resolve));
  await session.submit("recover me", {
    mode: "followUp",
    submissionId: "idem_rejected_second",
  });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(observed, ["inv_rejected_first"]);
  assert.deepEqual(session.queuedInputs, []);
  assert.equal(session.canRestoreQueuedInput, true);
  assert.equal(session.restoreQueuedText(), "recover me");
  assert.match(
    session.messages.map(({ text }) => text).join("\n"),
    /workspace policy rejected the turn/u,
  );

  releaseFirst?.();
  await new Promise((resolve) => setImmediate(resolve));
});

test("Spark native session clears rejected recovery after a successful retry", async () => {
  const submissionIds: Array<string | undefined> = [];
  let reject = true;
  const responder = Object.assign(async () => "compatibility path", {
    admit: async (_prompt: string, context: SparkNativeAdmissionContext) => {
      submissionIds.push(context.submissionId);
      if (reject) {
        reject = false;
        throw new SparkNativeAdmissionError("rejected once", "rejected");
      }
      return {
        invocationId: "inv_rejectedretry",
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:00.000Z",
      };
    },
    observe: async () => "retry succeeded",
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "cancelled" as const,
      cancelRequested: true,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("recover exactly once", {
    submissionId: "idem_rejected_once",
    submittedInput: "@retry.md",
  });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.canRestoreQueuedInput, true);
  assert.equal(session.canRetry, true);

  assert.equal(await session.retryLast(), "started");
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(session.canRestoreQueuedInput, false);
  assert.equal(session.restoreQueuedText(), undefined);
  assert.notEqual(submissionIds[0], submissionIds[1]);
});

test("Spark native session holds rejected retry ownership through admission acknowledgement", async () => {
  let admitCount = 0;
  let acknowledgeRetry: ((receipt: SparkTurnSubmitResult) => void) | undefined;
  let finishObservation: (() => void) | undefined;
  let retryTargetReads = 0;
  const canonicalRetries: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => {
      admitCount += 1;
      if (admitCount === 1) {
        throw new SparkNativeAdmissionError("rejected once", "rejected");
      }
      return await new Promise<SparkTurnSubmitResult>((resolve) => {
        acknowledgeRetry = resolve;
      });
    },
    observe: async () => {
      await new Promise<void>((resolve) => {
        finishObservation = resolve;
      });
      return "rejected retry completed";
    },
    latestRetryableFailure: async () => {
      retryTargetReads += 1;
      return {
        invocationId: "inv_olderfailed",
        failedAt: "2026-08-12T00:00:01.000Z",
      };
    },
    retry: async (invocationId: string) => {
      canonicalRetries.push(invocationId);
      return {
        invocationId: "inv_wrongchild",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  await session.submit("retry rejected admission");
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const first = session.retryLast();
  await new Promise((resolve) => setImmediate(resolve));
  const second = session.retryLast();
  assert.equal(first, second);
  acknowledgeRetry?.({
    invocationId: "inv_rejectedretrychild",
    status: "queued",
    acceptedAt: "2026-08-12T00:00:02.000Z",
  });
  assert.deepEqual(await Promise.all([first, second]), ["started", "started"]);
  assert.equal(await session.retryLast(), "ignored");
  assert.equal(retryTargetReads, 0);
  assert.deepEqual(canonicalRetries, []);

  finishObservation?.();
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("Spark native session stops a rejected retry by cancelling its exact child after ACK", async () => {
  let admitCount = 0;
  let acknowledgeRetry: ((receipt: SparkTurnSubmitResult) => void) | undefined;
  const observations: string[] = [];
  const cancellations: Array<{ invocationId: string; reason: string }> = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => {
      admitCount += 1;
      if (admitCount === 1) {
        throw new SparkNativeAdmissionError("rejected once", "rejected");
      }
      return await new Promise<SparkTurnSubmitResult>((resolve) => {
        acknowledgeRetry = resolve;
      });
    },
    observe: async (admission: SparkTurnSubmitResult) => {
      observations.push(admission.invocationId);
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("cancelled by daemon");
    },
    cancel: async (invocationId: string, reason: string) => {
      cancellations.push({ invocationId, reason });
      return {
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      };
    },
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("retry rejected admission then stop");
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.canRetry, true);

  const retry = session.retryLast();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isProcessing, true);
  assert.deepEqual(session.abort("operator stopped rejected retry"), {
    aborted: true,
    clearedQueued: 0,
  });
  assert.deepEqual(cancellations, []);

  acknowledgeRetry?.({
    invocationId: "inv_rejected_retry_stop_child",
    status: "queued",
    acceptedAt: "2026-08-12T00:00:02.000Z",
  });
  assert.equal(await retry, "started");
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(cancellations, [
    {
      invocationId: "inv_rejected_retry_stop_child",
      reason: "operator stopped rejected retry",
    },
  ]);
  assert.deepEqual(observations, ["inv_rejected_retry_stop_child"]);
  assert.equal(session.isProcessing, false);
});

test("Spark native session retries unknown admission with the same request identity", async () => {
  const admissions: Array<{ prompt: string; submissionId?: string }> = [];
  const observed: string[] = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (prompt: string, context: SparkNativeAdmissionContext) => {
        admissions.push({ prompt, submissionId: context.submissionId });
        if (admissions.length === 1) {
          throw new SparkNativeAdmissionError("connection closed after request write", "unknown");
        }
        return {
          invocationId: "inv_unknown_replay",
          status: "queued" as const,
          acceptedAt: "2026-07-28T00:00:00.000Z",
        };
      },
      observe: async (admission: SparkTurnSubmitResult) => {
        observed.push(admission.invocationId);
        return "replayed admission complete";
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("submit exactly once", { submissionId: "idem_unknown" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(admissions, [
    { prompt: "submit exactly once", submissionId: "idem_unknown" },
    { prompt: "submit exactly once", submissionId: "idem_unknown" },
  ]);
  assert.deepEqual(observed, ["inv_unknown_replay"]);
  assert.equal(session.canRestoreQueuedInput, false);
  assert.equal(session.isProcessing, false);
  assert.match(session.messages.map(({ text }) => text).join("\n"), /unknown outcome/u);
});

test("Spark native session bounds detach by aborting an unacknowledged admission", async () => {
  let admissionSignal: AbortSignal | undefined;
  const cancellations: string[] = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (_prompt: string, context: SparkNativeAdmissionContext) => {
        admissionSignal = context.signal;
        return await new Promise<SparkTurnSubmitResult>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("detached")),
            { once: true },
          );
        });
      },
      observe: async () => "must not observe before ACK",
      cancel: async (invocationId: string) => {
        cancellations.push(invocationId);
        return {
          invocationId,
          status: "cancelled" as const,
          cancelRequested: true,
        };
      },
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("detach before ACK", { submissionId: "idem_detach_admission" });
  await new Promise((resolve) => setImmediate(resolve));
  session.detach();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(admissionSignal?.aborted, true);
  assert.deepEqual(cancellations, []);
  assert.equal(session.isProcessing, false);
  assert.equal(
    session.messages.some(({ text }) => /rejected the turn/u.test(text)),
    false,
  );
});

test("Spark native session cancels snapshot-owned running then earliest queued invocation", async () => {
  const cancellations: Array<{ invocationId: string; reason: string }> = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => {
        throw new Error("snapshot cancellation must not submit");
      },
      observe: async () => {
        throw new Error("snapshot cancellation must not observe");
      },
      cancel: async (invocationId: string, reason: string) => {
        cancellations.push({ invocationId, reason });
        return {
          invocationId,
          status: "cancelled" as const,
          cancelRequested: true,
        };
      },
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  session.applySessionView({
    ...session.toSessionView("attached"),
    pendingTurns: [
      {
        invocationId: "inv_snapshot_queued_first",
        prompt: "queued first",
        status: "queued",
        createdAt: "2026-07-28T00:00:00.000Z",
      },
      {
        invocationId: "inv_snapshot_running",
        prompt: "running",
        status: "running",
        createdAt: "2026-07-28T00:00:01.000Z",
      },
      {
        invocationId: "inv_snapshot_queued_second",
        prompt: "queued second",
        status: "queued",
        createdAt: "2026-07-28T00:00:02.000Z",
      },
    ],
  });

  assert.equal(session.isProcessing, true);
  assert.deepEqual(session.abort("stop attached running"), {
    aborted: true,
    clearedQueued: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancellations, [
    {
      invocationId: "inv_snapshot_running",
      reason: "stop attached running",
    },
  ]);

  assert.deepEqual(session.abort("stop earliest queued"), {
    aborted: true,
    clearedQueued: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancellations, [
    {
      invocationId: "inv_snapshot_running",
      reason: "stop attached running",
    },
    {
      invocationId: "inv_snapshot_queued_first",
      reason: "stop earliest queued",
    },
  ]);
});

test("Spark native session retains then settles daemon state after live observation disconnects", async () => {
  let statusReads = 0;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_observation_running",
        status: "running" as const,
        acceptedAt: "2026-07-28T00:00:00.000Z",
      }),
      observe: async () => {
        throw new Error("stream transport disconnected");
      },
      status: async (invocationId: string) => {
        statusReads += 1;
        return {
          invocationId,
          status: statusReads === 1 ? ("running" as const) : ("succeeded" as const),
          createdAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:01.000Z",
          ...(statusReads === 1
            ? { startedAt: "2026-07-28T00:00:00.500Z" }
            : { finishedAt: "2026-07-28T00:00:02.000Z" }),
          eventCursor: 4,
        };
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "running" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("keep daemon truth", { submissionId: "idem_observation_running" });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(
    session.daemonPending.map(({ invocationId, status }) => ({ invocationId, status })),
    [{ invocationId: "inv_observation_running", status: "running" }],
  );
  assert.equal(session.isProcessing, true);
  assert.match(
    session.messages.map(({ text }) => text).join("\n"),
    /Live observation .* was interrupted: stream transport disconnected/u,
  );
  assert.equal(
    session.messages.some(({ text }) => /Spark turn failed/u.test(text)),
    false,
  );

  await new Promise((resolve) => setTimeout(resolve, 550));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statusReads, 2);
  assert.deepEqual(session.daemonPending, []);
  assert.equal(session.isProcessing, false);
});

test("Spark native session aborts status reconciliation when the TUI detaches", async () => {
  let statusSignal: AbortSignal | undefined;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_status_detach",
        status: "running" as const,
        acceptedAt: "2026-07-28T00:00:00.000Z",
      }),
      observe: async () => {
        throw new Error("stream transport disconnected");
      },
      status: async (invocationId: string, context?: { readonly signal?: AbortSignal }) => {
        statusSignal = context?.signal;
        return await new Promise<{
          invocationId: string;
          status: "running";
          createdAt: string;
          updatedAt: string;
          eventCursor: number;
        }>((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("detached")),
            { once: true },
          );
        });
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "running" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("detach during status read", { submissionId: "idem_status_detach" });
  for (let index = 0; index < 4 && !statusSignal; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.notEqual(statusSignal, undefined);

  session.detach();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(statusSignal?.aborted, true);
  assert.equal(session.isProcessing, false);
});

test("Spark native session settles observation failures from exact daemon status", async () => {
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_observation_failed",
        status: "running" as const,
        acceptedAt: "2026-07-28T00:00:00.000Z",
      }),
      observe: async () => {
        throw new Error("stream ended");
      },
      status: async (invocationId: string) => ({
        invocationId,
        status: "failed" as const,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:01.000Z",
        finishedAt: "2026-07-28T00:00:01.000Z",
        error: { code: "provider_error", message: "provider upstream 503" },
        eventCursor: 4,
      }),
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "failed" as const,
        cancelRequested: false,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("surface daemon failure", { submissionId: "idem_observation_failed" });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(session.daemonPending, []);
  assert.equal(session.isProcessing, false);
  assert.match(
    session.messages.map(({ text }) => text).join("\n"),
    /Spark turn failed: provider upstream 503/u,
  );
});

test("Spark native session retries a failed daemon invocation as a linked child", async () => {
  const admissions: string[] = [];
  const observations: string[] = [];
  const retries: string[] = [];
  let retryTargetReads = 0;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (prompt: string) => {
        admissions.push(prompt);
        return {
          invocationId: "inv_retry_source",
          status: "running" as const,
          acceptedAt: "2026-08-12T00:00:00.000Z",
        };
      },
      observe: async (admission: SparkTurnSubmitResult) => {
        observations.push(admission.invocationId);
        if (admission.invocationId === "inv_retry_source") throw new Error("empty response");
        return "linked retry completed";
      },
      status: async (invocationId: string) => ({
        invocationId,
        status: invocationId === "inv_retry_source" ? ("failed" as const) : ("succeeded" as const),
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:01.000Z",
        finishedAt: "2026-08-12T00:00:01.000Z",
        ...(invocationId === "inv_retry_source"
          ? { error: { code: "EXECUTION_TRANSIENT", message: "empty response" } }
          : {}),
        eventCursor: 2,
      }),
      retry: async (invocationId: string) => {
        retries.push(invocationId);
        return {
          invocationId: "inv_retry_child",
          retryOfInvocationId: invocationId,
          status: "queued" as const,
          acceptedAt: "2026-08-12T00:00:02.000Z",
        };
      },
      latestRetryableFailure: async () => {
        retryTargetReads += 1;
        return {
          invocationId: "inv_unrelatednewerfailure",
          failedAt: "2026-08-12T00:00:01.500Z",
        };
      },
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "failed" as const,
        cancelRequested: false,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("retry through the daemon", {
    submissionId: "idem_retry_source",
    submittedInput: "@task.md",
  });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.canRetry, true);

  assert.equal(await session.retryLast(), "started");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(admissions, ["retry through the daemon"]);
  assert.equal(retryTargetReads, 0);
  assert.deepEqual(retries, ["inv_retry_source"]);
  assert.deepEqual(observations, ["inv_retry_source", "inv_retry_child"]);
  assert.equal(session.canRetry, false);
  assert.match(session.messages.map(({ text }) => text).join("\n"), /linked retry completed/u);
});

test("Spark native session coalesces concurrent retries of one failed invocation", async () => {
  let releaseRetry: (() => void) | undefined;
  const retries: string[] = [];
  const observed: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => ({
      invocationId: "inv_concurrentsource",
      status: "running" as const,
      acceptedAt: "2026-08-12T00:00:00.000Z",
    }),
    observe: async (admission: SparkTurnSubmitResult) => {
      observed.push(admission.invocationId);
      if (admission.invocationId === "inv_concurrentsource") throw new Error("empty response");
      return "retried once";
    },
    status: async (invocationId: string) => ({
      invocationId,
      status:
        invocationId === "inv_concurrentsource" ? ("failed" as const) : ("succeeded" as const),
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      finishedAt: "2026-08-12T00:00:01.000Z",
      ...(invocationId === "inv_concurrentsource"
        ? { error: { code: "EXECUTION_TRANSIENT", message: "empty response" } }
        : {}),
      eventCursor: 2,
    }),
    retry: async (invocationId: string) => {
      retries.push(invocationId);
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      return {
        invocationId: "inv_concurrentchild",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  await session.submit("retry once");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const first = session.retryLast();
  const second = session.retryLast();
  assert.equal(first, second);
  releaseRetry?.();
  assert.deepEqual(await Promise.all([first, second]), ["started", "started"]);
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(retries, ["inv_concurrentsource"]);
  assert.deepEqual(observed, ["inv_concurrentsource", "inv_concurrentchild"]);
  assert.equal(
    session.messages.filter(
      (message) =>
        message.role === "user" && message.details?.invocationId === "inv_concurrentchild",
    ).length,
    1,
  );
});

test("Spark native session stops an unacknowledged retry by cancelling its exact child after ACK", async () => {
  let acknowledgeRetry: ((receipt: SparkInvocationRetryResult) => void) | undefined;
  const observations: string[] = [];
  const cancellations: Array<{ invocationId: string; reason: string }> = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => ({
      invocationId: "inv_retry_stop_source",
      status: "running" as const,
      acceptedAt: "2026-08-12T00:00:00.000Z",
    }),
    observe: async (admission: SparkTurnSubmitResult) => {
      observations.push(admission.invocationId);
      if (admission.invocationId === "inv_retry_stop_source") throw new Error("empty response");
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("cancelled by daemon");
    },
    status: async (invocationId: string) => ({
      invocationId,
      status:
        invocationId === "inv_retry_stop_source"
          ? ("failed" as const)
          : cancellations.some((entry) => entry.invocationId === invocationId)
            ? ("cancelled" as const)
            : ("running" as const),
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      ...(invocationId === "inv_retry_stop_source"
        ? {
            finishedAt: "2026-08-12T00:00:01.000Z",
            error: { code: "EXECUTION_TRANSIENT", message: "empty response" },
          }
        : {}),
      eventCursor: 2,
    }),
    retry: async () =>
      await new Promise<SparkInvocationRetryResult>((resolve) => {
        acknowledgeRetry = resolve;
      }),
    cancel: async (invocationId: string, reason: string) => {
      cancellations.push({ invocationId, reason });
      return {
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      };
    },
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("retry then stop");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.canRetry, true);

  const retry = session.retryLast();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isProcessing, true);
  assert.equal(session.canRetry, false);
  assert.deepEqual(session.abort("operator stopped retry"), {
    aborted: true,
    clearedQueued: 0,
  });
  assert.deepEqual(cancellations, []);

  acknowledgeRetry?.({
    invocationId: "inv_retry_stop_child",
    retryOfInvocationId: "inv_retry_stop_source",
    status: "queued",
    acceptedAt: "2026-08-12T00:00:02.000Z",
  });
  assert.equal(await retry, "started");
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(cancellations, [
    { invocationId: "inv_retry_stop_child", reason: "operator stopped retry" },
  ]);
  assert.deepEqual(observations, ["inv_retry_stop_source", "inv_retry_stop_child"]);
  assert.equal(session.isProcessing, false);
});

test("Spark native session aborts retry acknowledgement and skips its child after detach", async () => {
  let acknowledgeRetry: ((receipt: SparkInvocationRetryResult) => void) | undefined;
  let retrySignal: AbortSignal | undefined;
  const observations: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => ({
      invocationId: "inv_retry_detach_source",
      status: "running" as const,
      acceptedAt: "2026-08-12T00:00:00.000Z",
    }),
    observe: async (admission: SparkTurnSubmitResult) => {
      observations.push(admission.invocationId);
      if (admission.invocationId === "inv_retry_detach_source") throw new Error("empty response");
      return "detached child must not be observed";
    },
    status: async (invocationId: string) => ({
      invocationId,
      status:
        invocationId === "inv_retry_detach_source" ? ("failed" as const) : ("succeeded" as const),
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
      finishedAt: "2026-08-12T00:00:01.000Z",
      ...(invocationId === "inv_retry_detach_source"
        ? { error: { code: "EXECUTION_TRANSIENT", message: "empty response" } }
        : {}),
      eventCursor: 2,
    }),
    retry: async (_invocationId: string, context?: { readonly signal?: AbortSignal }) => {
      retrySignal = context?.signal;
      // Deliberately ignore abort and deliver a late ACK. The detached TUI must
      // still avoid attaching a child observer.
      return await new Promise<SparkInvocationRetryResult>((resolve) => {
        acknowledgeRetry = resolve;
      });
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "cancelled" as const,
      cancelRequested: true,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("retry then detach");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const retry = session.retryLast();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.isProcessing, true);
  assert.notEqual(retrySignal, undefined);

  session.detach();
  assert.equal(retrySignal?.aborted, true);
  acknowledgeRetry?.({
    invocationId: "inv_retry_detach_child",
    retryOfInvocationId: "inv_retry_detach_source",
    status: "queued",
    acceptedAt: "2026-08-12T00:00:02.000Z",
  });
  assert.equal(await retry, "started");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(observations, ["inv_retry_detach_source"]);
  assert.equal(session.isProcessing, false);
});

test("Spark native session restores canonical retry after reattaching to a failed Session", async () => {
  const admissions: string[] = [];
  const retries: string[] = [];
  const retryTargetReads: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async (prompt: string) => {
      admissions.push(prompt);
      throw new Error("reattachment retry must not resubmit");
    },
    observe: async () => "reattached retry completed",
    status: async (invocationId: string) => ({
      invocationId,
      status: "succeeded" as const,
      createdAt: "2026-08-12T00:00:02.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
      finishedAt: "2026-08-12T00:00:03.000Z",
      eventCursor: 1,
    }),
    retry: async (invocationId: string) => {
      retries.push(invocationId);
      return {
        invocationId: "inv_reattachedchild",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    latestRetryableFailure: async () => {
      retryTargetReads.push("read");
      return {
        invocationId: "inv_reattachedsource",
        failedAt: "2026-08-12T00:00:01.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  await session.hydrateRetryableFailure();

  assert.equal(session.canRetry, true);
  assert.equal(await session.retryLast(), "started");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(retryTargetReads, ["read", "read"]);
  assert.deepEqual(retries, ["inv_reattachedsource"]);
  assert.deepEqual(admissions, []);
  assert.equal(
    session.messages.some(
      (message) => message.role === "user" && /Retry failed invocation/u.test(message.text),
    ),
    false,
  );
});

test("Spark native session revalidates a hydrated retry target before mutation", async () => {
  const retries: string[] = [];
  let targetRead = 0;
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => {
      throw new Error("stale retry target must not resubmit");
    },
    observe: async () => "unused",
    latestRetryableFailure: async () => {
      targetRead += 1;
      if (targetRead > 1) return null;
      return {
        invocationId: "inv_stalehydrated",
        failedAt: "2026-08-12T00:00:01.000Z",
      };
    },
    retry: async (invocationId: string) => {
      retries.push(invocationId);
      return {
        invocationId: "inv_mustnotexist",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.hydrateRetryableFailure();
  assert.equal(session.canRetry, true);
  assert.equal(await session.retryLast(), "ignored");
  assert.equal(session.canRetry, false);
  assert.equal(targetRead, 2);
  assert.deepEqual(retries, []);
});

test("Spark native session orders a concurrent submit after cold retry selection", async () => {
  let releaseTarget: (() => void) | undefined;
  let releaseObservation: (() => void) | undefined;
  const operations: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => {
      operations.push("admit");
      return {
        invocationId: "inv_newprompt",
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:03.000Z",
      };
    },
    observe: async () => {
      await new Promise<void>((resolve) => {
        releaseObservation = resolve;
      });
      return "completed";
    },
    latestRetryableFailure: async () => {
      await new Promise<void>((resolve) => {
        releaseTarget = resolve;
      });
      return {
        invocationId: "inv_coldretrytarget",
        failedAt: "2026-08-12T00:00:01.000Z",
      };
    },
    retry: async (invocationId: string) => {
      operations.push("retry");
      return {
        invocationId: "inv_coldretrychild",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  const retry = session.retryLast();
  await new Promise((resolve) => setImmediate(resolve));
  const submit = session.submit("new prompt");
  releaseTarget?.();

  assert.equal(await retry, "started");
  assert.equal(await submit, "queued");
  assert.deepEqual(operations, ["retry", "admit"]);
  releaseObservation?.();
});

test("Spark native session never renders a reattached retry placeholder as user input", async () => {
  let latestInvocationId = "inv_reattachedsource";
  const retries: string[] = [];
  const responder = Object.assign(async () => "compatibility path", {
    admit: async () => {
      throw new Error("reattached retry must not resubmit");
    },
    observe: async (admission: SparkTurnSubmitResult) => {
      if (admission.invocationId === "inv_reattachedchild1") {
        latestInvocationId = admission.invocationId;
        throw new Error("first linked retry also failed");
      }
      return "second linked retry completed";
    },
    status: async (invocationId: string) => ({
      invocationId,
      status:
        invocationId === "inv_reattachedchild1" ? ("failed" as const) : ("succeeded" as const),
      createdAt: "2026-08-12T00:00:02.000Z",
      updatedAt: "2026-08-12T00:00:03.000Z",
      finishedAt: "2026-08-12T00:00:03.000Z",
      ...(invocationId === "inv_reattachedchild1"
        ? { error: { code: "EXECUTION_TRANSIENT", message: "first linked retry also failed" } }
        : {}),
      eventCursor: 2,
    }),
    latestRetryableFailure: async () => ({
      invocationId: latestInvocationId,
      failedAt: "2026-08-12T00:00:01.000Z",
    }),
    retry: async (invocationId: string) => {
      retries.push(invocationId);
      return {
        invocationId:
          invocationId === "inv_reattachedsource" ? "inv_reattachedchild1" : "inv_reattachedchild2",
        retryOfInvocationId: invocationId,
        status: "queued" as const,
        acceptedAt: "2026-08-12T00:00:02.000Z",
      };
    },
    cancel: async (invocationId: string) => ({
      invocationId,
      status: "failed" as const,
      cancelRequested: false,
    }),
  }) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.hydrateRetryableFailure();
  assert.equal(await session.retryLast(), "started");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(session.canRetry, true);
  assert.equal(await session.retryLast(), "started");
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(retries, ["inv_reattachedsource", "inv_reattachedchild1"]);
  assert.equal(
    session.messages.some(
      (message) => message.role === "user" && /Retry failed invocation/u.test(message.text),
    ),
    false,
  );
});

test("Spark native session defers exact daemon cancellation until admission is acknowledged", async () => {
  let acknowledgeFirst: ((receipt: SparkTurnSubmitResult) => void) | undefined;
  let releaseCancelledObservation: (() => void) | undefined;
  const admissions: string[] = [];
  const cancellations: Array<{ invocationId: string; reason: string }> = [];
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (prompt: string) => {
        admissions.push(prompt);
        if (admissions.length === 1) {
          return await new Promise<SparkTurnSubmitResult>((resolve) => {
            acknowledgeFirst = resolve;
          });
        }
        return {
          invocationId: "inv_2",
          status: "queued" as const,
          acceptedAt: "2026-07-28T00:00:02.000Z",
        };
      },
      observe: async (admission: SparkTurnSubmitResult, _context: SparkNativeResponderContext) => {
        if (admission.invocationId === "inv_1") {
          if (cancellations.some(({ invocationId }) => invocationId === admission.invocationId)) {
            throw new Error("cancelled by daemon");
          }
          await new Promise<void>((resolve) => {
            releaseCancelledObservation = resolve;
          });
          throw new Error("cancelled by daemon");
        }
        return "second complete";
      },
      cancel: async (invocationId: string, reason: string) => {
        cancellations.push({ invocationId, reason });
        releaseCancelledObservation?.();
        return {
          invocationId,
          status: "cancelled" as const,
          cancelRequested: true,
        };
      },
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("first", { submissionId: "idem_cancel_first" });
  await session.submit("leave queued", {
    mode: "followUp",
    submissionId: "idem_cancel_second",
  });
  assert.deepEqual(session.abort("operator stop"), {
    aborted: true,
    clearedQueued: 0,
  });
  assert.deepEqual(cancellations, []);

  acknowledgeFirst?.({
    invocationId: "inv_1",
    status: "running",
    acceptedAt: "2026-07-28T00:00:01.000Z",
  });
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(cancellations, [{ invocationId: "inv_1", reason: "operator stop" }]);
  assert.equal(admissions.length, 2);
  assert.equal(
    session.messages.some((message) => /Stopped current Spark turn/u.test(message.text)),
    false,
  );
  assert.equal(
    session.messages.some((message) =>
      /Cancellation will be requested as soon as daemon admission is acknowledged/u.test(
        message.text,
      ),
    ),
    true,
  );
});

test("Spark native session does not claim a daemon turn stopped when cancellation is unconfirmed", async () => {
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_unconfirmed",
        status: "running" as const,
        acceptedAt: "2026-07-28T00:00:00.000Z",
      }),
      observe: async (_admission: SparkTurnSubmitResult, context: SparkNativeResponderContext) =>
        await new Promise<string>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("detached")),
            { once: true },
          );
        }),
      cancel: async () => {
        throw new Error("connection closed before response");
      },
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("long daemon turn", { submissionId: "idem_unconfirmed" });
  await new Promise((resolve) => setImmediate(resolve));
  session.abort("operator stop");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    session.messages.some((message) =>
      /Cancellation for daemon invocation inv_unconfirmed could not be confirmed/u.test(
        message.text,
      ),
    ),
    true,
  );
  assert.equal(
    session.messages.some((message) => /Stopped current Spark turn/u.test(message.text)),
    false,
  );

  session.detach();
  await new Promise((resolve) => setImmediate(resolve));
});

test("Spark native session surfaces terminal provider failure when cancellation loses the race", async () => {
  let rejectObservation: ((error: Error) => void) | undefined;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_cancel_provider",
        status: "running" as const,
        acceptedAt: "2026-07-28T00:00:00.000Z",
      }),
      observe: async () =>
        await new Promise<string>((_resolve, reject) => {
          rejectObservation = reject;
        }),
      status: async (invocationId: string) => ({
        invocationId,
        status: "failed" as const,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:01.000Z",
        finishedAt: "2026-07-28T00:00:01.000Z",
        error: { code: "provider_error", message: "provider upstream 503" },
        eventCursor: 1,
      }),
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "failed" as const,
        cancelRequested: false,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("provider may fail", { submissionId: "idem_cancel_provider" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.abort("operator stop"), {
    aborted: true,
    clearedQueued: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  rejectObservation?.(new Error("provider upstream 503"));
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const transcript = session.messages.map(({ text }) => text).join("\n");
  assert.match(
    transcript,
    /inv_cancel_provider was already failed; no new cancellation was recorded/u,
  );
  assert.match(transcript, /Spark turn failed: provider upstream 503/u);
  assert.doesNotMatch(transcript, /Cancellation requested for daemon invocation/u);
  assert.doesNotMatch(transcript, /Stopped current Spark turn/u);
  assert.deepEqual(session.daemonPending, []);
});

test("Spark CLI host preserves slash commands and shell input", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  sparkCliHostExtension({
    on: (event, handler) => handlers.set(event, handler),
  });

  assert.deepEqual(handlers.get("input")?.({ text: "/plan x", source: "interactive" }, {}), {
    action: "continue",
  });
  assert.deepEqual(handlers.get("input")?.({ text: "!git status", source: "interactive" }, {}), {
    action: "continue",
  });
});

// ---- --wait flag tests ----

test("parseSparkCliCommand parses --wait flag into run command options", () => {
  const cmd = parseSparkCliCommand(["run", "--wait", "hello"]);
  assert.equal(cmd.kind, "run");
  if (cmd.kind === "run") {
    assert.equal(cmd.prompt, "hello");
    assert.equal(cmd.options?.wait, true);
  }
});

test("parseSparkCliCommand parses -w short flag", () => {
  const cmd = parseSparkCliCommand(["run", "-w", "hello"]);
  assert.equal(cmd.kind, "run");
  if (cmd.kind === "run") {
    assert.equal(cmd.options?.wait, true);
  }
});

test("parseSparkCliCommand without --wait has no wait option", () => {
  const cmd = parseSparkCliCommand(["run", "hello"]);
  assert.equal(cmd.kind, "run");
  if (cmd.kind === "run") {
    assert.equal(cmd.options?.wait, undefined);
  }
});

test("runSparkCli --wait returns 0 on succeeded invocation", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient: SparkDaemonClientOptions = {
    ...fakeHeadlessDaemonClient(submissions),
    turnStatus: async (_paths, input) => ({
      invocationId: input.invocationId,
      status: "succeeded" as const,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:01.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z",
      eventCursor: 0,
    }),
  };
  // Mock turn.result via the control request path
  (daemonClient as Record<string, unknown>).controlRequest = async () => ({
    invocationId: "inv_turn",
    status: "succeeded",
    assistantText: "result text",
  });

  try {
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const code = await runSparkCli(["run", "--wait", "hello"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /succeeded|result text/u);
  } finally {
    console.log = previousLog;
  }
});

test("runSparkCli --wait returns 1 on failed invocation", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient: SparkDaemonClientOptions = {
    ...fakeHeadlessDaemonClient(submissions),
    turnStatus: async (_paths, input) => ({
      invocationId: input.invocationId,
      status: "failed" as const,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:01.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z",
      eventCursor: 0,
      error: { code: "model_error", message: "model refused" },
    }),
  };
  (daemonClient as Record<string, unknown>).controlRequest = async () => ({
    invocationId: "inv_turn",
    status: "failed",
    error: { code: "model_error", message: "model refused", retryable: false },
  });

  try {
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const code = await runSparkCli(["run", "--wait", "hello"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /failed|model refused/u);
  } finally {
    console.log = previousLog;
  }
});

test("runSparkCli --wait returns 2 on cancelled invocation", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient: SparkDaemonClientOptions = {
    ...fakeHeadlessDaemonClient(submissions),
    turnStatus: async (_paths, input) => ({
      invocationId: input.invocationId,
      status: "cancelled" as const,
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:01.000Z",
      finishedAt: "2026-07-21T00:00:01.000Z",
      cancelReason: "user requested",
      eventCursor: 0,
    }),
  };
  (daemonClient as Record<string, unknown>).controlRequest = async () => ({
    invocationId: "inv_turn",
    status: "cancelled",
  });

  try {
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const code = await runSparkCli(["run", "--wait", "hello"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });
    assert.equal(code, 2);
    assert.match(logs.join("\n"), /cancelled/u);
  } finally {
    console.log = previousLog;
  }
});

test("runSparkCli without --wait still returns queued ACK immediately", async () => {
  const logs: string[] = [];
  const submissions: Array<{
    sessionId: string;
    prompt: string;
    reset?: boolean;
    idempotencyKey?: string;
  }> = [];
  const previousLog = console.log;
  const daemonClient = fakeHeadlessDaemonClient(submissions);

  try {
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    const code = await runSparkCli(["run", "hello"], {
      daemonClient,
      terminal: { stdinIsTTY: false, stdoutIsTTY: false },
    });
    assert.equal(code, 0);
    assert.equal(submissions.length, 1);
    // Should contain invocationId from the queued ACK, not a wait result
    assert.match(logs.join("\n"), /inv_turn/u);
  } finally {
    console.log = previousLog;
  }
});
