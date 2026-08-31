import { resolve } from "node:path";

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import * as dshToolSubagent from "@deepseek-ai/dsh-tool-subagent";
import type { SparkDshToolPolicyMetadata, SparkHostAPI } from "@zendev-lab/spark-invocation";
import { sparkMemoryDirectIntentReceiptSchema } from "@zendev-lab/spark-protocol";

import * as dshCuePlugin from "@zendev-lab/dsh-tool-cue";
import * as dshFusionPlugin from "@zendev-lab/dsh-tool-fusion";
import * as dshWebPlugin from "@zendev-lab/dsh-tool-web";
import sparkAskCapability, { type SparkAskDaemonRequest } from "@zendev-lab/spark-ask/extension";
import sparkArtifactsCapability from "@zendev-lab/spark-artifacts/extension";
import { CUE_TOOL_NAMES, type CueToolName } from "@zendev-lab/dsh-cue/operations";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import sparkFilesCapability from "@zendev-lab/spark-files/extension";
import sparkModelsCapability from "@zendev-lab/spark-llm-providers/models-extension";
import sparkMemoryCapability, {
  type SparkMemoryExtensionApi,
} from "@zendev-lab/spark-memory/extension";
import sparkRolesCapability from "@zendev-lab/spark-roles/extension";
import sparkSessionCapability from "@zendev-lab/spark-session/extension";
import { encodeSparkAuxiliaryModelRoute } from "./agent-runtime/agent-loop.ts";

import registerSparkProductPolicy from "../policy/index.ts";
import { createAskBackedMemoryApprovalVerifier } from "../policy/memory-approval-verifier.ts";

declare module "@deepseek-ai/dsh-tools" {
  interface ToolDefinition {
    /** Product policy is attached by Spark composition, never by the reusable DSH tool. */
    readonly sparkPolicy?: SparkDshToolPolicyMetadata;
  }
}

const SPARK_FUSION_POLICY = Object.freeze({
  effect: "read",
  executionMode: "sequential",
  domains: ["models", "deliberation"],
  approval: "required",
  reconcile: "none",
} as const satisfies SparkDshToolPolicyMetadata);

const SPARK_WEB_POLICIES = Object.freeze({
  web_search: Object.freeze({
    effect: "network_read",
    executionMode: "parallel",
    domains: ["web", "search"],
    approval: "none",
    reconcile: "none",
  }),
  web_fetch: Object.freeze({
    effect: "network_read",
    executionMode: "parallel",
    domains: ["web", "fetch"],
    approval: "none",
    reconcile: "none",
  }),
  get_search_content: Object.freeze({
    effect: "read",
    executionMode: "parallel",
    domains: ["web", "cache"],
    approval: "none",
    reconcile: "none",
  }),
} as const satisfies Readonly<Record<string, SparkDshToolPolicyMetadata>>);

type SparkWebToolName = keyof typeof SPARK_WEB_POLICIES;

const SPARK_CUE_EXECUTION_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "execution"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_JOBS_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "jobs"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_RESOURCES_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "resources"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_SCHEDULE_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "schedules"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_SCOPE_POLICY = {
  effect: "external_write",
  executionMode: "sequential",
  domains: ["cue", "scope"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_HISTORY_POLICY = {
  effect: "read",
  executionMode: "parallel",
  domains: ["cue", "history"],
  approval: "none",
} as const satisfies Omit<SparkDshToolPolicyMetadata, "reconcile">;

const SPARK_CUE_POLICIES: Readonly<Record<CueToolName, SparkDshToolPolicyMetadata>> = {
  cue_exec: withDshReconciliation(SPARK_CUE_EXECUTION_POLICY),
  cue_run: withDshReconciliation(SPARK_CUE_EXECUTION_POLICY),
  cue_script: withDshReconciliation(SPARK_CUE_EXECUTION_POLICY),
  script_run: withDshReconciliation(SPARK_CUE_EXECUTION_POLICY),
  script_eval: withDshReconciliation(SPARK_CUE_EXECUTION_POLICY),
  cue_jobs: withDshReconciliation(SPARK_CUE_JOBS_POLICY),
  cue_resources: withDshReconciliation(SPARK_CUE_RESOURCES_POLICY),
  cue_schedule: withDshReconciliation(SPARK_CUE_SCHEDULE_POLICY),
  cue_scope: withDshReconciliation(SPARK_CUE_SCOPE_POLICY),
  cue_history: withDshReconciliation(SPARK_CUE_HISTORY_POLICY),
};

const SPARK_CUE_TOOL_PLUGIN: Plugin = {
  name: dshCuePlugin.name,
  inject: dshCuePlugin.inject,
  apply(ctx: Context) {
    dshCuePlugin.apply(ctx);
    attachSparkCuePolicies(ctx);
  },
};

const SPARK_FUSION_PLUGIN: Plugin = {
  name: dshFusionPlugin.name,
  inject: dshFusionPlugin.inject,
  apply(ctx: Context) {
    ctx.tools.register({
      ...dshFusionPlugin.createDshFusionTool(ctx, {
        resolveModel(override, fallback) {
          if (!override) return fallback;
          if (!fallback) return undefined;
          const separator = override.indexOf("/");
          const provider = separator > 0 ? override.slice(0, separator).trim() : undefined;
          const model = (separator > 0 ? override.slice(separator + 1) : override).trim();
          if (!model) return undefined;
          return {
            provider: fallback.provider,
            model: encodeSparkAuxiliaryModelRoute(model, provider),
          };
        },
      }),
      sparkPolicy: SPARK_FUSION_POLICY,
    });
    ctx.systemPrompt.section({
      name: "tool:fusion",
      order: 120,
      text: dshFusionPlugin.FUSION_TOOL_GUIDANCE.join(" "),
    });
  },
};

const SPARK_WEB_PLUGIN: Plugin = {
  name: dshWebPlugin.name,
  inject: dshWebPlugin.inject,
  apply(ctx: Context) {
    dshWebPlugin.apply(ctx);
    attachSparkWebPolicies(ctx);
  },
};

export type SparkProductCapabilityName =
  | "@zendev-lab/spark-ask"
  | "@zendev-lab/spark-artifacts"
  | "@zendev-lab/spark-files"
  | "@zendev-lab/spark-llm-providers"
  | "@zendev-lab/spark-memory"
  | "@zendev-lab/spark-roles"
  | "@zendev-lab/spark-session"
  | "spark";

export type SparkProductCapabilityFactory = (api: SparkHostAPI) => void | Promise<void>;

export interface SparkProductCapability {
  name: SparkProductCapabilityName;
  register: SparkProductCapabilityFactory;
}

const SPARK_PRODUCT_CAPABILITIES: readonly SparkProductCapability[] = [
  {
    name: "@zendev-lab/spark-ask",
    register: (api) =>
      sparkAskCapability(api, {
        request: requestSparkDaemon as unknown as SparkAskDaemonRequest,
      }),
  },
  {
    name: "@zendev-lab/spark-artifacts",
    register: sparkArtifactsCapability as SparkProductCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-files",
    register: sparkFilesCapability as SparkProductCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-llm-providers",
    register: sparkModelsCapability as SparkProductCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-memory",
    register: registerSparkMemoryCapability,
  },
  {
    name: "@zendev-lab/spark-roles",
    register: sparkRolesCapability as SparkProductCapabilityFactory,
  },
  {
    name: "@zendev-lab/spark-session",
    register: sparkSessionCapability as SparkProductCapabilityFactory,
  },
  {
    name: "spark",
    register: registerSparkProductPolicy as SparkProductCapabilityFactory,
  },
];

export async function registerSparkProductCapabilities(api: SparkHostAPI): Promise<void> {
  for (const capability of SPARK_PRODUCT_CAPABILITIES) {
    await capability.register(api);
  }
}

export function loadSparkProductCapabilities(): SparkProductCapability[] {
  return SPARK_PRODUCT_CAPABILITIES.map((capability) => ({ ...capability }));
}

export function loadSparkProductAgentPlugins(options?: {
  subagentModels: Array<{ provider: string; model: string }>;
}): Plugin[] {
  const base = [SPARK_CUE_TOOL_PLUGIN, SPARK_FUSION_PLUGIN, SPARK_WEB_PLUGIN];
  if (!options) return base;
  const routes = options.subagentModels.map((route) => ({ ...route }));
  const modelSelection = routes.length > 0;
  const policy: Plugin = {
    name: "spark-subagent-model-selection-policy",
    apply(ctx) {
      if (!modelSelection) return;
      const agent = ctx.agent;
      if (!agent) throw new Error("Spark subagent model policy requires an Agent scope");
      if (agent.session.events.some((event) => event.type === "subagent/model-selection-policy")) {
        return;
      }
      agent.session.append("subagent/model-selection-policy", { allowedModels: routes });
    },
  };
  const subagent = (provider: "spawn" | "fork", toolName: string, selectable: boolean): Plugin => ({
    name: `spark-tool-subagent-${provider}`,
    inject: dshToolSubagent.inject,
    apply(ctx) {
      dshToolSubagent.apply(ctx, {
        provider,
        toolName,
        backgroundMode: "one-shot",
        maxDepth: 3,
        ...(modelSelection && selectable ? { modelSelectionSettings: true } : {}),
      });
    },
  });
  return [
    ...base,
    policy,
    subagent("spawn", "subagent", true),
    // DSH exposes one shared list_subagent_models tool per Agent scope. Forks
    // retain the parent route to preserve inherited-prefix reuse.
    subagent("fork", "subagent_fork", false),
  ];
}

export interface SparkProductDshToolSurface {
  config: ToolDefinition;
  policy: SparkDshToolPolicyMetadata;
}

/** Load the exact static DSH tool schemas for architecture-surface inspection. */
export async function loadSparkProductDshToolSurfaces(): Promise<SparkProductDshToolSurface[]> {
  const definitions = new Map<string, ToolDefinition>();
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        definitions.set(definition.name, definition);
      },
    },
  } as unknown as Context;
  const inspectionRuntime = {
    async execute(): Promise<never> {
      throw new Error("DSH tool-surface inspection does not execute Cue operations");
    },
  } as Parameters<typeof dshCuePlugin.registerCueToolDefinitions>[1];
  dshCuePlugin.registerCueToolDefinitions(ctx, inspectionRuntime);
  definitions.set("fusion", dshFusionPlugin.createDshFusionTool(ctx));
  for (const definition of dshWebPlugin.createDshWebToolDefinitions(ctx)) {
    definitions.set(definition.name, definition);
  }
  return [...CUE_TOOL_NAMES, "fusion", ...Object.keys(SPARK_WEB_POLICIES)].map((name) => {
    const config = definitions.get(name);
    if (!config) throw new Error(`Spark product DSH tool is missing: ${name}`);
    const policy =
      name === "fusion"
        ? SPARK_FUSION_POLICY
        : name in SPARK_WEB_POLICIES
          ? SPARK_WEB_POLICIES[name as SparkWebToolName]
          : SPARK_CUE_POLICIES[name as CueToolName];
    return { config: { ...config, sparkPolicy: policy }, policy };
  });
}

function attachSparkCuePolicies(ctx: Context): void {
  for (const name of CUE_TOOL_NAMES) {
    const definition = ctx.tools.get(name, ctx.agent);
    if (!definition) throw new Error(`Spark daemon failed to register DSH Cue tool: ${name}`);
    Object.assign(definition, { sparkPolicy: SPARK_CUE_POLICIES[name] });
  }
}

function attachSparkWebPolicies(ctx: Context): void {
  for (const name of Object.keys(SPARK_WEB_POLICIES) as SparkWebToolName[]) {
    const definition = ctx.tools.get(name, ctx.agent);
    if (!definition) throw new Error(`Spark daemon failed to register DSH Web tool: ${name}`);
    Object.assign(definition, { sparkPolicy: SPARK_WEB_POLICIES[name] });
  }
}

function withDshReconciliation(
  policy: Omit<SparkDshToolPolicyMetadata, "reconcile">,
): SparkDshToolPolicyMetadata {
  return Object.freeze({ ...policy, reconcile: "none" });
}

async function registerSparkMemoryCapability(api: SparkHostAPI): Promise<void> {
  if (!api.registerTool) throw new Error("Spark host does not support tool registration");
  const memoryApi: SparkMemoryExtensionApi = {
    registerTool: (config) => api.registerTool!(config),
    ...(api.getAllTools ? { getAllTools: () => api.getAllTools!() } : {}),
    ...(api.on
      ? { on: (event, handler) => api.on!(event, (payload, ctx) => handler(payload, ctx)) }
      : {}),
    ...(api.sendMessage
      ? { sendMessage: (message, options) => api.sendMessage!(message, options) }
      : {}),
  };
  sparkMemoryCapability(memoryApi, {
    createApprovalVerifier: (cwd, ctx) => createAskBackedMemoryApprovalVerifier(cwd, ctx),
    workspaceId: (cwd, ctx) => {
      const directIntent = sparkMemoryDirectIntentReceiptSchema.safeParse(ctx.memoryDirectIntent);
      return directIntent.success
        ? directIntent.data.workspaceId
        : (ctx.sessionLease?.()?.workspaceId ?? resolve(cwd));
    },
  });
}
