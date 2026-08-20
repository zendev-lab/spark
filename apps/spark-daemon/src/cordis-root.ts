/**
 * Process-local Cordis root for daemon store composition.
 *
 * Invocation, channel, loop, and retry data authority stays in Spark SQLite.
 * This module only mounts already-constructed stores as services and owns
 * fiber dispose. It does not replace Session transcripts or the LLM island.
 */
import { Context } from "@deepseek-ai/cordis";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";

import { ChannelReplyDeliveryStore } from "./channels/reply-delivery.ts";
import { SparkDaemonInvocationRegistry } from "./core/index.ts";
import { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import { ExecutionAttemptStore } from "./execution/state.ts";
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
): Promise<SparkDaemonCordisRoot> {
  const ctx = openSparkDaemonCordisContext();
  const dispose = createSparkDaemonCordisDispose(ctx);
  try {
    await mountSparkDaemonStorePlugin(ctx, stores);
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
