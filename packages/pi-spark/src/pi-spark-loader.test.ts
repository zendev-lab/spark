import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

const PI_SPARK_EXTENSION = fileURLToPath(new URL("./extension.ts", import.meta.url));
const PI_NATIVE_FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

test("the production Pi loader exposes only additive compatibility capabilities", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "spark-pi-spark-files-"));
  try {
    const loaded = await discoverAndLoadExtensions([PI_SPARK_EXTENSION], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    const registeredTools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    const registeredFileTools = registeredTools.filter((name) => PI_NATIVE_FILE_TOOLS.has(name));
    assert.deepEqual(registeredFileTools, []);
    assert.ok(registeredTools.includes("cue_exec"));
    assert.equal(registeredTools.includes("goal"), false);
    assert.equal(registeredTools.includes("repro"), false);

    const registeredCommands = loaded.extensions.flatMap((extension) => [
      ...extension.commands.keys(),
    ]);
    assert.equal(registeredCommands.includes("goal"), false);
    assert.equal(registeredCommands.includes("repro"), false);
    assert.equal(registeredCommands.includes("loop"), false);

    const registeredHandlers = new Set(
      loaded.extensions.flatMap((extension) => [...extension.handlers.keys()]),
    );
    assert.equal(registeredHandlers.has("before_agent_start"), false);
    assert.equal(registeredHandlers.has("turn_start"), false);
    assert.equal(registeredHandlers.has("agent_end"), false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("the production Pi loader resolves the Spark-native Baidu provider through pi-spark", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "spark-pi-spark-provider-"));
  try {
    const loaded = await discoverAndLoadExtensions([PI_SPARK_EXTENSION], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(
      loaded.runtime.pendingProviderRegistrations.filter(
        (registration) => registration.name === "baidu-oneapi",
      ).length,
      1,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("the production Pi loader executes both Baidu OneAPI lazy transports through pi-spark", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "spark-pi-spark-loader-"));
  const previousBaiduApiKey = process.env.BAIDU_ONEAPI_API_KEY;
  const previousOpenAiLog = process.env.OPENAI_LOG;
  const previousFetch = globalThis.fetch;
  delete process.env.BAIDU_ONEAPI_API_KEY;
  process.env.OPENAI_LOG = "debug";
  let requests = 0;
  let openAiLogDuringRequest: string | undefined;
  globalThis.fetch = (async () => {
    requests += 1;
    openAiLogDuringRequest = process.env.OPENAI_LOG;
    return completedResponsesResponse();
  }) as typeof fetch;

  try {
    const loaded = await discoverAndLoadExtensions([PI_SPARK_EXTENSION], process.cwd(), agentDir);
    assert.deepEqual(loaded.errors, []);

    const registrations = loaded.runtime.pendingProviderRegistrations.filter(
      (registration) => registration.name === "baidu-oneapi",
    );
    assert.equal(registrations.length, 1);
    const config = registrations[0]?.config;
    assert.ok(config?.streamSimple);

    const claude = modelFromConfig(config, "claude-opus-5");
    const claudeStream = config.streamSimple(
      claude,
      { messages: [], tools: [] },
      { apiKey: "", maxRetries: 0, maxRetryDelayMs: 1 },
    );
    for await (const _event of claudeStream) void _event;
    const claudeResult = await claudeStream.result();
    assert.equal(claudeResult.stopReason, "error");
    assert.match(claudeResult.errorMessage ?? "", /No API key for provider: baidu-oneapi/u);

    const gpt = modelFromConfig(config, "gpt-5.6-sol");
    const gptStream = config.streamSimple(
      gpt,
      { messages: [], tools: [] },
      { apiKey: "test-key", maxRetries: 0, maxRetryDelayMs: 1 },
    );
    for await (const _event of gptStream) void _event;
    const gptResult = await gptStream.result();

    assert.equal(gptResult.stopReason, "stop");
    assert.equal(gptResult.api, "baidu-oneapi");
    assert.equal(gptResult.provider, "baidu-oneapi");
    assert.equal(requests, 1);
    assert.equal(openAiLogDuringRequest, "off");
    assert.equal(process.env.OPENAI_LOG, "debug");
    assert.doesNotMatch(gptResult.errorMessage ?? "", /compat\.js\/api|Cannot find module/u);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaiduApiKey === undefined) delete process.env.BAIDU_ONEAPI_API_KEY;
    else process.env.BAIDU_ONEAPI_API_KEY = previousBaiduApiKey;
    if (previousOpenAiLog === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousOpenAiLog;
    await rm(agentDir, { recursive: true, force: true });
  }
});

function modelFromConfig(
  config: NonNullable<
    Awaited<
      ReturnType<typeof discoverAndLoadExtensions>
    >["runtime"]["pendingProviderRegistrations"][number]
  >["config"],
  modelId: string,
) {
  const definition = config.models?.find((model) => model.id === modelId);
  assert.ok(definition, `missing ${modelId} from the compatibility provider`);
  return {
    ...definition,
    api: "baidu-oneapi" as const,
    provider: "baidu-oneapi",
    baseUrl: definition.baseUrl ?? config.baseUrl ?? "https://oneapi-comate.baidu-int.com",
  };
}

function completedResponsesResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_loader_contract",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
