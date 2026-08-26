import assert from "node:assert/strict";

import { SparkHostRuntime } from "../runtime.ts";
import { describe, test } from "vitest";

import {
  SparkAgentLoop,
  SparkTurnRestartYieldError,
  type Message,
  type SparkBeforeToolCallsCheckpoint,
  type ToolCall,
  type ToolResultMessage,
} from "./agent-loop.ts";
import {
  createSparkScriptedProvider,
  sparkScriptedAssistant,
  sparkScriptedTextAssistant,
  sparkScriptedToolCall,
  SPARK_SCRIPTED_PROVIDER_MODEL,
  type SparkScriptedProvider,
  type SparkScriptedProviderRequest,
} from "./testing/scripted-provider.ts";

describe("scripted provider protocol", () => {
  test("correlates one tool result into the exact follow-up provider request", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-single-tool" });
    let executions = 0;
    host.registerTool({
      name: "scripted_echo",
      description: "Return the supplied value",
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute(toolCallId, parameters) {
        executions += 1;
        return {
          content: [
            {
              type: "text",
              text: `${toolCallId}:${String((parameters as { value?: unknown }).value)}`,
            },
          ],
        };
      },
    });

    const call = sparkScriptedToolCall("call-echo-1", "scripted_echo", { value: "ping" });
    const provider = createSparkScriptedProvider([
      {
        label: "request echo",
        inspectRequest(request) {
          assert.deepEqual(
            request.messages.map((message) => message.role),
            ["user"],
          );
          assert.deepEqual(
            request.tools.map((tool) => tool.name),
            ["scripted_echo"],
          );
          assert.equal(request.model.id, SPARK_SCRIPTED_PROVIDER_MODEL.id);
          assert.equal(request.options.signalAborted, false);
        },
        message: sparkScriptedAssistant([call], { stopReason: "toolUse" }),
      },
      {
        label: "consume echo result",
        inspectRequest(request) {
          assert.deepEqual(
            request.messages.map((message) => message.role),
            ["user", "assistant", "toolResult"],
          );
          const result = requireToolResult(request, "call-echo-1");
          assert.equal(result.toolName, "scripted_echo");
          assert.equal(result.isError, false);
          assert.equal(toolResultText(result), "call-echo-1:ping");
        },
        message: sparkScriptedTextAssistant("echo complete"),
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });

    const outcome = await loop.submitWithOutcome("run the scripted echo");

    provider.assertExhausted();
    assert.equal(outcome.status, "completed", trace(provider));
    assert.equal(outcome.roundtrips, 2, trace(provider));
    assert.equal(executions, 1, trace(provider));
    assert.equal(provider.requests.length, 2, trace(provider));
    assert.equal(outcome.assistant.usage.totalTokens, 0);
    assert.equal(loop.getMessages().filter((message) => message.role === "toolResult").length, 1);
  });

  test("runs safe reads concurrently but commits tool results in assistant source order", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-parallel-tools" });
    const started: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, () => void>();
    for (const name of ["scripted_read_alpha", "scripted_read_beta"]) {
      host.registerTool({
        name,
        description: name,
        parameters: { type: "object" },
        policy: { effect: "read", executionMode: "parallel", approval: "none" },
        async execute(toolCallId) {
          started.push(toolCallId);
          await new Promise<void>((resolve) => {
            releases.set(toolCallId, () => {
              completed.push(toolCallId);
              resolve();
            });
          });
          return { content: [{ type: "text", text: `result:${toolCallId}` }] };
        },
      });
    }

    const calls = [
      sparkScriptedToolCall("call-alpha", "scripted_read_alpha"),
      sparkScriptedToolCall("call-beta", "scripted_read_beta"),
    ];
    const provider = createSparkScriptedProvider([
      {
        label: "request parallel reads",
        message: sparkScriptedAssistant(calls, { stopReason: "toolUse" }),
      },
      {
        label: "consume ordered read results",
        inspectRequest(request) {
          const results = request.messages.filter(isToolResult);
          assert.deepEqual(
            results.map((result) => result.toolCallId),
            ["call-alpha", "call-beta"],
          );
          assert.deepEqual(results.map(toolResultText), ["result:call-alpha", "result:call-beta"]);
        },
        message: sparkScriptedTextAssistant("parallel reads complete"),
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
      maxParallelToolCalls: 2,
    });

    const run = loop.submitWithOutcome("read alpha and beta");
    await waitFor(() => started.length === 2, "both read calls should start concurrently");
    releases.get("call-beta")?.();
    await waitFor(() => completed.length === 1, "beta should complete before alpha");
    releases.get("call-alpha")?.();
    const outcome = await run;

    provider.assertExhausted();
    assert.equal(outcome.status, "completed", trace(provider));
    assert.deepEqual(started, ["call-alpha", "call-beta"]);
    assert.deepEqual(completed, ["call-beta", "call-alpha"]);
  });

  test("fails a disconnected partial stream without dispatching its pending tool call", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-disconnect" });
    let executions = 0;
    host.registerTool({
      name: "must_not_run",
      description: "Must remain pending when the provider disconnects",
      parameters: { type: "object" },
      policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
      },
    });
    const call = sparkScriptedToolCall("call-disconnected", "must_not_run");
    const partial = sparkScriptedAssistant([call], { stopReason: "toolUse" });
    const provider = createSparkScriptedProvider([
      {
        kind: "throw",
        label: "disconnect after tool delta",
        error: new Error("scripted provider disconnected"),
        events: [
          { type: "start", partial },
          {
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: call,
            partial,
          },
        ],
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });

    const outcome = await loop.submitWithOutcome("do not replay a partial tool call");

    provider.assertExhausted();
    assert.equal(outcome.status, "failed", trace(provider));
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /provider disconnected/u);
    assert.equal(executions, 0, trace(provider));
    assert.equal(provider.requests.length, 1, trace(provider));
    assert.equal(
      loop.getMessages().some((message) => message.role === "toolResult"),
      false,
    );
  });

  test("preserves a provider error envelope as one terminal failed outcome", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-error-envelope" });
    const provider = createSparkScriptedProvider([
      {
        label: "provider error",
        message: sparkScriptedAssistant([], {
          stopReason: "error",
          errorMessage: "scripted upstream unavailable",
        }),
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });

    const outcome = await loop.submitWithOutcome("surface the provider error");

    provider.assertExhausted();
    assert.equal(outcome.status, "failed", trace(provider));
    assert.equal(
      outcome.status === "failed" ? outcome.errorMessage : undefined,
      "scripted upstream unavailable",
    );
    assert.equal(outcome.roundtrips, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(loop.getLastOutcome()?.status, "failed");
  });

  test("rejects duplicate tool-call IDs before either tool can execute", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-duplicate-call" });
    let executions = 0;
    for (const name of ["duplicate_alpha", "duplicate_beta"]) {
      host.registerTool({
        name,
        description: name,
        parameters: { type: "object" },
        policy: { effect: "read", executionMode: "parallel", approval: "none" },
        async execute() {
          executions += 1;
          return { content: [{ type: "text", text: "must not run" }] };
        },
      });
    }
    const duplicateCalls: ToolCall[] = [
      sparkScriptedToolCall("duplicate-call", "duplicate_alpha"),
      sparkScriptedToolCall("duplicate-call", "duplicate_beta"),
    ];
    const provider = createSparkScriptedProvider([
      {
        label: "duplicate tool call IDs",
        message: sparkScriptedAssistant(duplicateCalls, { stopReason: "toolUse" }),
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });

    const outcome = await loop.submitWithOutcome("reject ambiguous tool correlation");

    provider.assertExhausted();
    assert.equal(outcome.status, "failed", trace(provider));
    assert.match(
      outcome.status === "failed" ? outcome.errorMessage : "",
      /duplicate tool call id: duplicate-call/u,
    );
    assert.equal(executions, 0, trace(provider));
    assert.equal(
      loop.getMessages().some((message) => message.role === "toolResult"),
      false,
    );
  });

  test("resumes checkpointed tool calls exactly once without asking the provider to recreate them", async () => {
    const call = sparkScriptedToolCall("call-resume-once", "resume_once", { value: 42 });
    const predecessorHost = new SparkHostRuntime({
      cwd: "/tmp/spark-scripted-provider-restart-predecessor",
    });
    let executions = 0;
    predecessorHost.registerTool({
      name: "resume_once",
      description: "Execute once after restart",
      parameters: { type: "object" },
      policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: "unexpected predecessor execution" }] };
      },
    });
    const predecessorProvider = createSparkScriptedProvider([
      {
        label: "checkpoint tool call",
        message: sparkScriptedAssistant([call], { stopReason: "toolUse" }),
      },
    ]);
    const predecessor = new SparkAgentLoop({
      host: predecessorHost,
      llm: predecessorProvider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });
    let checkpoint: SparkBeforeToolCallsCheckpoint | undefined;

    await assert.rejects(
      predecessor.submitWithOutcome("checkpoint before dispatch", {
        beforeToolCalls(candidate) {
          checkpoint = candidate;
          throw new SparkTurnRestartYieldError();
        },
      }),
      (error: unknown) => error instanceof SparkTurnRestartYieldError,
    );
    predecessorProvider.assertExhausted();
    assert.equal(executions, 0, trace(predecessorProvider));
    assert.ok(checkpoint);

    const successorHost = new SparkHostRuntime({
      cwd: "/tmp/spark-scripted-provider-restart-successor",
    });
    successorHost.registerTool({
      name: "resume_once",
      description: "Execute once after restart",
      parameters: { type: "object" },
      policy: { effect: "local_write", executionMode: "sequential", approval: "none" },
      async execute(_toolCallId, parameters) {
        executions += 1;
        return {
          content: [
            {
              type: "text",
              text: `resumed:${String((parameters as { value?: unknown }).value)}`,
            },
          ],
        };
      },
    });
    const successorProvider = createSparkScriptedProvider([
      {
        label: "continue after exact tool result",
        inspectRequest(request) {
          assert.equal(requireToolResult(request, call.id).toolName, "resume_once");
          assert.equal(toolResultText(requireToolResult(request, call.id)), "resumed:42");
        },
        message: sparkScriptedTextAssistant("restart continuation complete"),
      },
    ]);
    const successor = new SparkAgentLoop({
      host: successorHost,
      llm: successorProvider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });
    successor.replacePromptItems(checkpoint.promptItems);

    const outcome = await successor.resumeToolCallsWithOutcome(checkpoint.toolCalls);

    successorProvider.assertExhausted();
    assert.equal(outcome.status, "completed", trace(successorProvider));
    assert.equal(executions, 1, trace(successorProvider));
    assert.deepEqual(
      successor.getMessages().map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
  });

  test("turns an unconfigured provider follow-up into a failed outcome instead of hanging", async () => {
    const host = new SparkHostRuntime({ cwd: "/tmp/spark-scripted-provider-exhaustion" });
    let executions = 0;
    host.registerTool({
      name: "one_round_only",
      description: "Force one provider follow-up",
      parameters: { type: "object" },
      policy: { effect: "read", executionMode: "parallel", approval: "none" },
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const provider = createSparkScriptedProvider([
      {
        label: "only configured round",
        message: sparkScriptedAssistant(
          [sparkScriptedToolCall("call-one-round", "one_round_only")],
          { stopReason: "toolUse" },
        ),
      },
    ]);
    const loop = new SparkAgentLoop({
      host,
      llm: provider.llm,
      getModel: () => SPARK_SCRIPTED_PROVIDER_MODEL,
      streamIdleTimeoutMs: 0,
    });

    const outcome = await loop.submitWithOutcome("require an unconfigured second request");

    assert.equal(outcome.status, "failed", trace(provider));
    assert.match(outcome.status === "failed" ? outcome.errorMessage : "", /unexpected request 2/u);
    assert.equal(executions, 1, trace(provider));
    assert.equal(provider.requests.length, 1, trace(provider));
  });
});

function requireToolResult(
  request: SparkScriptedProviderRequest,
  toolCallId: string,
): ToolResultMessage {
  const result = request.messages.find(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );
  assert.ok(result, `missing tool result ${toolCallId}`);
  return result;
}

function isToolResult(message: Message): message is ToolResultMessage {
  return message.role === "toolResult";
}

function toolResultText(message: ToolResultMessage): string {
  return message.content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function trace(provider: SparkScriptedProvider): string {
  return JSON.stringify(provider.trace, null, 2);
}
