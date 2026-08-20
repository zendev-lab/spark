/**
 * Process-local Cordis root for daemon store composition and session persistence.
 *
 * Invocation, channel, loop, and retry data authority stays in Spark SQLite.
 * Live sessions are `ctx.sessions`; JSONL durability is dsh-session-persistence
 * with Spark's PersistenceBackend. This module does not own the LLM island.
 */
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";

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
  const ctx = openSparkDaemonCordisContext();
  const dispose = createSparkDaemonCordisDispose(ctx);
  try {
    await mountSparkDaemonStorePlugin(ctx, stores);
    await ctx.plugin(SessionStore);
    await mountSparkDaemonSessionPersistence(ctx, options.sessionsRoot);
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return { ctx, dispose };
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
