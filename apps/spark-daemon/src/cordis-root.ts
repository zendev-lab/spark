/**
 * Process-local Cordis root for daemon stores and the shared DSH runtime.
 *
 * Invocation, channel, loop, and retry data authority stays in Spark SQLite.
 * Live sessions are `ctx.sessions`; JSONL durability is dsh-session-persistence
 * with Spark's PersistenceBackend. Official `dsh-subagent` owns `ctx.subagents`;
 * spark-session registers Role-bound spawn/fork providers when a durable host
 * is passed. Agent handles remain invocation-owned and are mounted only after
 * transcript migration makes their surface native DSH.
 */
import { dirname } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LocalAttachmentStore from "@deepseek-ai/dsh-attachment-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as ScheduleRuntime from "@deepseek-ai/dsh-schedule";
import { SessionStore } from "@deepseek-ai/dsh-session";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import sparkSessionSubagentPlugin, {
  type SparkSubagentHost,
} from "@zendev-lab/spark-session/subagent";
import { DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS } from "@zendev-lab/spark-turn";

import { ChannelReplyDeliveryStore } from "./channels/reply-delivery.ts";
import { SparkDaemonInvocationRegistry } from "./core/index.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { ExecutionAttemptStore } from "./execution/state.ts";
import { mountSparkDaemonSessionPersistence } from "./session-persistence.ts";
import { SparkChannelDeliveryStore } from "./store/channel-deliveries.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { SparkLoopStore } from "./store/loops.ts";
import { SessionRequestCompletionDeliveryStore } from "./store/session-request-completion-deliveries.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sparkInvocations: SparkInvocationStore;
    sparkLoops: SparkLoopStore;
    sparkChannelDeliveries: SparkChannelDeliveryStore;
    sparkChannelReplyDeliveries: ChannelReplyDeliveryStore;
    sparkExecutionAttempts: ExecutionAttemptStore;
    sparkSessionMail: SparkSessionMailStore;
    sparkHumanWaits: SparkDaemonHumanWaitRegistry;
    sparkSessionCompletions: SessionRequestCompletionDeliveryStore;
    sparkInvocationRegistry: SparkDaemonInvocationRegistry;
  }
}

export interface SparkDaemonStoreServices {
  sparkInvocations: SparkInvocationStore;
  sparkLoops: SparkLoopStore;
  sparkChannelDeliveries: SparkChannelDeliveryStore;
  sparkChannelReplyDeliveries: ChannelReplyDeliveryStore;
  sparkExecutionAttempts: ExecutionAttemptStore;
  sparkSessionMail: SparkSessionMailStore;
  sparkHumanWaits: SparkDaemonHumanWaitRegistry;
  sparkSessionCompletions: SessionRequestCompletionDeliveryStore;
  sparkInvocationRegistry: SparkDaemonInvocationRegistry;
}

export interface SparkDaemonCordisRoot {
  ctx: Context;
  dispose(): Promise<void>;
}

export interface SparkDaemonCordisRootOptions {
  sessionsRoot: string;
  /** Reuse the process root opened before daemon adapters are constructed. */
  ctx?: Context;
  subagentHost?: SparkSubagentHost;
}

export interface SparkDaemonHeadlessCordisRootOptions {
  dshHome: string;
  /** Test-only reuse seam. Production workers open their own process root. */
  ctx?: Context;
}

const STORE_NAMES = [
  "sparkInvocations",
  "sparkLoops",
  "sparkChannelDeliveries",
  "sparkChannelReplyDeliveries",
  "sparkExecutionAttempts",
  "sparkSessionMail",
  "sparkHumanWaits",
  "sparkSessionCompletions",
  "sparkInvocationRegistry",
] as const satisfies readonly (keyof SparkDaemonStoreServices)[];

export function openSparkDaemonCordisContext(): Context {
  return new Context();
}

export function createSparkDaemonCordisDispose(ctx: Context): () => Promise<void> {
  let disposeDone: Promise<void> | undefined;
  return () => {
    disposeDone ??= ctx.fiber.dispose();
    return disposeDone;
  };
}

export async function mountSparkDaemonStorePlugin(
  ctx: Context,
  stores: SparkDaemonStoreServices,
): Promise<void> {
  await ctx.plugin((inner) => {
    for (const name of STORE_NAMES) {
      inner.provide(name, stores[name]);
    }
  });
}

export async function createSparkDaemonCordisRoot(
  stores: SparkDaemonStoreServices,
  options: SparkDaemonCordisRootOptions,
): Promise<SparkDaemonCordisRoot> {
  const ctx = options.ctx ?? openSparkDaemonCordisContext();
  const dispose = createSparkDaemonCordisDispose(ctx);
  try {
    await mountSparkDaemonStorePlugin(ctx, stores);
    await mountSparkDshRuntime(ctx, {
      dshHome: dirname(options.sessionsRoot),
      sessionsRoot: options.sessionsRoot,
    });
    await ctx.plugin(SubagentRuntime);
    if (options.subagentHost) {
      await ctx.plugin(sparkSessionSubagentPlugin, { host: options.subagentHost });
    }
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return { ctx, dispose };
}

/**
 * Process root for the isolated daemon-native compatibility worker.
 *
 * A worker cannot borrow the daemon Context across the worker-thread boundary,
 * so the daemon composition owner mounts the same execution services without a
 * second durable Session writer. The worker is one request and always disposes
 * this root before it exits.
 */
export async function createSparkDaemonHeadlessCordisRoot(
  options: SparkDaemonHeadlessCordisRootOptions,
): Promise<SparkDaemonCordisRoot> {
  const ctx = options.ctx ?? openSparkDaemonCordisContext();
  const dispose = createSparkDaemonCordisDispose(ctx);
  try {
    await mountSparkDshRuntime(ctx, { dshHome: options.dshHome });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return { ctx, dispose };
}

async function mountSparkDshRuntime(
  ctx: Context,
  options: { dshHome: string; sessionsRoot?: string },
): Promise<void> {
  await ctx.plugin(SessionStore);
  if (options.sessionsRoot) {
    await mountSparkDaemonSessionPersistence(ctx, options.sessionsRoot);
  }
  await ctx.plugin(LocalAttachmentStore, { dshHome: options.dshHome });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, {
    agents: [],
    maxParallelToolCalls: DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS,
  });
  // Schedule must observe future root Agent creation after Session persistence,
  // tools, the registry, and the concrete loop factory are all available. Its
  // timer state remains a disposable projection of native `schedule/change`
  // events; Spark does not mirror reminders in SQLite.
  if (options.sessionsRoot) await ctx.plugin(ScheduleRuntime);
}

export function sparkDaemonStoresFromContext(ctx: Context): SparkDaemonStoreServices {
  return {
    sparkInvocations: requireStore(ctx, "sparkInvocations"),
    sparkLoops: requireStore(ctx, "sparkLoops"),
    sparkChannelDeliveries: requireStore(ctx, "sparkChannelDeliveries"),
    sparkChannelReplyDeliveries: requireStore(ctx, "sparkChannelReplyDeliveries"),
    sparkExecutionAttempts: requireStore(ctx, "sparkExecutionAttempts"),
    sparkSessionMail: requireStore(ctx, "sparkSessionMail"),
    sparkHumanWaits: requireStore(ctx, "sparkHumanWaits"),
    sparkSessionCompletions: requireStore(ctx, "sparkSessionCompletions"),
    sparkInvocationRegistry: requireStore(ctx, "sparkInvocationRegistry"),
  };
}

function requireStore<K extends keyof SparkDaemonStoreServices>(
  ctx: Context,
  name: K,
): SparkDaemonStoreServices[K] {
  const value = ctx.get(name);
  if (value === undefined) {
    throw new Error(`Spark daemon Cordis root is missing service ${name}`);
  }
  return value;
}
