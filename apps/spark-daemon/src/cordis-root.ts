/**
 * Process-local Cordis root for daemon stores and the shared DSH runtime.
 *
 * Invocation, channel, loop, and retry data authority stays in Spark SQLite.
 * Live sessions are `ctx.sessions`; JSONL durability is dsh-session-persistence
 * with Spark's PersistenceBackend. Official `dsh-subagent` owns `ctx.subagents`;
 * spark-session registers Role-bound spawn/fork providers when a durable host
 * is passed. One-shot `start()` maps onto createChild + session.send. Agent
 * handles remain invocation-owned and are mounted only after transcript
 * migration makes their surface native DSH.
 */
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Context, type Plugin } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LocalAttachmentStore from "@deepseek-ai/dsh-attachment-local";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import * as ScheduleRuntime from "@deepseek-ai/dsh-schedule";
import { SessionStore } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import * as ShellEnv from "@deepseek-ai/dsh-shell-env";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import * as SkillFileSystem from "@deepseek-ai/dsh-skill-filesystem";
import SubagentRuntime from "@deepseek-ai/dsh-subagent";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import * as SkillTool from "@deepseek-ai/dsh-tool-skill";
import SubagentModelSelectionSettings from "@deepseek-ai/dsh-tool-subagent/model-selection-settings";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import WebRuntime from "@deepseek-ai/dsh-web";
import { cueSkillsRoot } from "@zendev-lab/cue";
import DshWebProvider from "@zendev-lab/dsh-tool-web/provider";
import * as DshCueService from "@zendev-lab/dsh-cue/plugin";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkDshToolPolicyMetadata } from "@zendev-lab/spark-invocation";
import sparkSessionSubagentPlugin, {
  type SparkSubagentHost,
} from "@zendev-lab/spark-session/subagent";
import { DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS } from "./product/host/agent-runtime/agent-loop.ts";

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
  /** Override for the root containing the package-owned `cue` Skill directory. */
  cueSkillRoot?: string;
  /** Reuse the process root opened before daemon adapters are constructed. */
  ctx?: Context;
  subagentHost?: SparkSubagentHost;
}

export interface SparkDaemonHeadlessCordisRootOptions {
  dshHome: string;
  /** Override for the root containing the package-owned `cue` Skill directory. */
  cueSkillRoot?: string;
  /** Test-only reuse seam. Production workers open their own process root. */
  ctx?: Context;
}

const CUE_SKILL_NAME = "cue";
const SPARK_DAEMON_SKILL_PROVIDER = "spark-daemon";
const SPARK_SKILL_TOOL_POLICY = Object.freeze({
  effect: "read",
  executionMode: "sequential",
  domains: ["skills"],
  approval: "none",
  reconcile: "none",
} as const satisfies SparkDshToolPolicyMetadata);

const SPARK_SKILL_TOOL_PLUGIN: Plugin = {
  name: SkillTool.name,
  inject: SkillTool.inject,
  apply(ctx: Context) {
    SkillTool.apply(ctx);
    const definition = ctx.tools.get("skill");
    if (!definition) throw new Error("Spark daemon failed to register the DSH skill tool");
    Object.assign(definition, { sparkPolicy: SPARK_SKILL_TOOL_POLICY });
  },
};

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
      cueSkillRoot: resolveCueSkillRoot(options.cueSkillRoot),
    });
    await ctx.plugin(SubagentRuntime);
    await ctx.plugin(SubagentModelSelectionSettings, { enabled: false, allowedModels: [] });
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
    await mountSparkDshRuntime(ctx, {
      dshHome: options.dshHome,
      cueSkillRoot: resolveCueSkillRoot(options.cueSkillRoot),
    });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return { ctx, dispose };
}

async function mountSparkDshRuntime(
  ctx: Context,
  options: { dshHome: string; sessionsRoot?: string; cueSkillRoot: string },
): Promise<void> {
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  if (options.sessionsRoot) {
    await mountSparkDaemonSessionPersistence(ctx, options.sessionsRoot);
  }
  await ctx.plugin(LocalAttachmentStore, { dshHome: options.dshHome });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(WebRuntime);
  await ctx.plugin(DshWebProvider, {});
  await ctx.plugin(DshCueService);
  await ctx.plugin(SandboxPolicy, {
    mode: "danger-full-access",
    workspaceRoot: process.cwd(),
  });
  await ctx.plugin(ShellEnv, { dshHome: options.dshHome });
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(SkillFileSystem, {
    providerName: SPARK_DAEMON_SKILL_PROVIDER,
    includeDefaultRoots: false,
    bundledSkillDir: options.cueSkillRoot,
    dshHome: options.dshHome,
    watch: false,
  });
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SPARK_SKILL_TOOL_PLUGIN);
  await ctx.plugin(AgentLoop, {
    agents: [],
    maxParallelToolCalls: DEFAULT_SPARK_AGENT_LOOP_MAX_PARALLEL_TOOL_CALLS,
  });
  // Native schedules require daemon-owned Session persistence.
  if (options.sessionsRoot) await ctx.plugin(ScheduleRuntime);
}

export function resolveCueSkillRoot(explicitRoot?: string): string {
  const root = explicitRoot ? resolve(explicitRoot) : cueSkillsRoot;
  try {
    const skillFile = lstatSync(join(root, CUE_SKILL_NAME, "SKILL.md"));
    if (skillFile.isFile() && !skillFile.isSymbolicLink()) return root;
  } catch {
    // Report the package or explicit override path below.
  }
  throw new Error(
    `Spark daemon could not find the package-owned ${CUE_SKILL_NAME} Skill under: ${root}`,
  );
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
