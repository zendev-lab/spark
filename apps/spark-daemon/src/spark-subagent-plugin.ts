/** Daemon adapter for official DSH one-shot subagent runs. */
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type {
  SparkSubagentHost,
  SparkSubagentHostRun,
  SparkSubagentHostTerminal,
} from "@zendev-lab/spark-session/subagent";

import type { SparkDaemonModelControl } from "./model-control.ts";
import { createManagedChildSession } from "./session-child.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { SparkInvocationStore, type SparkInvocationRecord } from "./store/invocations.ts";

export function createSparkDaemonSubagentHost(input: {
  db: DatabaseSync;
  registry: DaemonSessionRegistry;
  modelControl: SparkDaemonModelControl;
  sparkHome: string;
  send: (request: {
    parentSessionId: string;
    sessionId: string;
    body: string;
  }) => Promise<{ sessionId: string; invocationId?: string }>;
  cancel: (invocationId: string, reason: string) => void | Promise<void>;
  waitForSessionIdle: (sessionId: string) => Promise<void>;
}): SparkSubagentHost {
  return {
    agentOptions: true,
    async start(request): Promise<SparkSubagentHostRun> {
      request.signal.throwIfAborted();
      if (!input.modelControl.resolveSubagentOptions) {
        throw new Error("Spark daemon model control cannot resolve subagent AgentOptions");
      }
      const profile = await input.modelControl.resolveSubagentOptions(
        request.parentSessionId,
        request.agentOptions,
      );
      request.signal.throwIfAborted();
      const session = await createManagedChildSession({
        db: input.db,
        registry: input.registry,
        sparkHome: input.sparkHome,
        supervisorSessionId: request.parentSessionId,
        roleRef: request.roleRef,
        seed: request.mode === "fork" ? "fork" : "fresh",
        ...(request.name ? { name: request.name } : {}),
        model: profile.model,
        thinkingLevel: profile.thinkingLevel,
        ...(profile.maxOutputTokens ? { maxOutputTokens: profile.maxOutputTokens } : {}),
        subagentDescriptor: request.descriptor,
        subagentModels: profile.enabledModels,
        delegationDepth: request.delegationDepth,
      });
      request.signal.throwIfAborted();
      const sent = await input.send({
        parentSessionId: request.parentSessionId,
        sessionId: session.sessionId,
        body: promptText(request.prompt),
      });
      if (!sent.invocationId) {
        throw new Error(`Subagent ${session.sessionId} did not receive an Invocation`);
      }
      const invocationId = sent.invocationId;
      const abort = () => {
        void input.cancel(invocationId, abortReason(request.signal));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
      const result = waitForTerminal(input.db, invocationId).finally(() => {
        request.signal.removeEventListener("abort", abort);
      });
      return {
        sessionId: session.sessionId,
        result,
        cancel: async (reason) => await input.cancel(invocationId, reason),
        waitForIdle: async () => await input.waitForSessionIdle(session.sessionId),
      };
    },
  };
}

async function waitForTerminal(
  db: DatabaseSync,
  invocationId: string,
): Promise<SparkSubagentHostTerminal> {
  const store = new SparkInvocationStore(db);
  for (;;) {
    const invocation = store.require(invocationId);
    if (invocation.status === "succeeded") return successfulTerminal(invocation);
    if (invocation.status === "failed") {
      return {
        output: assistantOutput(invocation),
        diagnostic: invocation.errorMessage ?? "Subagent invocation failed",
        stopReason: "error",
      };
    }
    if (invocation.status === "cancelled") {
      return {
        output: assistantOutput(invocation),
        ...(invocation.cancelReason ? { diagnostic: invocation.cancelReason } : {}),
        stopReason: "aborted",
      };
    }
    await delay(10);
  }
}

function successfulTerminal(invocation: SparkInvocationRecord): SparkSubagentHostTerminal {
  const result = recordValue(invocation.result);
  const stopReason =
    result.stopReason === "length"
      ? "max-tokens"
      : result.stopReason === "refusal"
        ? "refusal"
        : "completed";
  return {
    output: assistantOutput(invocation),
    ...(result.structured !== undefined ? { structured: result.structured } : {}),
    stopReason,
  };
}

function assistantOutput(invocation: SparkInvocationRecord): ContentBlock[] {
  const text = recordValue(invocation.result).assistantText;
  return typeof text === "string" && text.trim() ? [{ type: "text", text: text.trim() }] : [];
}

function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      throw new Error(`Spark daemon subagent prompt does not support ${block.type} content`);
    }
    if (block.text.trim()) parts.push(block.text.trim());
  }
  const prompt = parts.join("\n");
  if (!prompt) throw new Error("Spark daemon subagent prompt is empty");
  return prompt;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "DSH subagent request cancelled");
}
