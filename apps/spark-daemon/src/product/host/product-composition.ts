import { resolve } from "node:path";

import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { SparkDshToolPolicyMetadata, SparkHostAPI } from "@zendev-lab/spark-core";
import { sparkMemoryDirectIntentReceiptSchema } from "@zendev-lab/spark-protocol";

import * as dshCuePlugin from "@zendev-lab/dsh-tool-cue";
import * as dshFusionPlugin from "@zendev-lab/dsh-tool-fusion";
import sparkAskCapability, { type SparkAskDaemonRequest } from "@zendev-lab/spark-ask/extension";
import sparkArtifactsCapability from "@zendev-lab/spark-artifacts/extension";
import {
  CUE_EXECUTION_TOOL_POLICY,
  CUE_HISTORY_TOOL_POLICY,
  CUE_JOBS_TOOL_POLICY,
  CUE_RESOURCES_TOOL_POLICY,
  CUE_SCHEDULE_TOOL_POLICY,
  CUE_SCOPE_TOOL_POLICY,
  CUE_TOOL_NAMES,
  type CueToolName,
} from "@zendev-lab/spark-cue/operations";
import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
import sparkFilesCapability from "@zendev-lab/spark-files/extension";
import sparkModelsCapability from "@zendev-lab/spark-llm/models-extension";
import sparkMemoryCapability, {
  type SparkMemoryExtensionApi,
} from "@zendev-lab/spark-memory/extension";
import sparkRolesCapability from "@zendev-lab/spark-roles/extension";
import sparkSessionCapability from "@zendev-lab/spark-session/extension";
import sparkWebCapability from "@zendev-lab/spark-tool-web/extension";
import { encodeSparkAuxiliaryModelRoute } from "@zendev-lab/spark-turn";

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
  modes: ["plan", "execute"],
  approval: "required",
  reconcile: "none",
} as const satisfies SparkDshToolPolicyMetadata);

const SPARK_CUE_POLICIES: Readonly<Record<CueToolName, SparkDshToolPolicyMetadata>> = {
  cue_exec: withDshReconciliation(CUE_EXECUTION_TOOL_POLICY),
  cue_run: withDshReconciliation(CUE_EXECUTION_TOOL_POLICY),
  cue_script: withDshReconciliation(CUE_EXECUTION_TOOL_POLICY),
  script_run: withDshReconciliation(CUE_EXECUTION_TOOL_POLICY),
  script_eval: withDshReconciliation(CUE_EXECUTION_TOOL_POLICY),
  cue_jobs: withDshReconciliation(CUE_JOBS_TOOL_POLICY),
  cue_resources: withDshReconciliation(CUE_RESOURCES_TOOL_POLICY),
  cue_schedule: withDshReconciliation(CUE_SCHEDULE_TOOL_POLICY),
  cue_scope: withDshReconciliation(CUE_SCOPE_TOOL_POLICY),
  cue_history: withDshReconciliation(CUE_HISTORY_TOOL_POLICY),
};

const SPARK_CUE_PLUGIN: Plugin = {
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

export type SparkProductCapabilityName =
  | "@zendev-lab/spark-ask"
  | "@zendev-lab/spark-artifacts"
  | "@zendev-lab/spark-files"
  | "@zendev-lab/spark-llm"
  | "@zendev-lab/spark-memory"
  | "@zendev-lab/spark-roles"
  | "@zendev-lab/spark-session"
  | "@zendev-lab/spark-tool-web"
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
    name: "@zendev-lab/spark-llm",
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
    name: "@zendev-lab/spark-tool-web",
    register: sparkWebCapability as SparkProductCapabilityFactory,
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

export function loadSparkProductAgentPlugins(): Plugin[] {
  return [SPARK_CUE_PLUGIN, SPARK_FUSION_PLUGIN];
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
  return [...CUE_TOOL_NAMES, "fusion"].map((name) => {
    const config = definitions.get(name);
    if (!config) throw new Error(`Spark product DSH tool is missing: ${name}`);
    const policy =
      name === "fusion" ? SPARK_FUSION_POLICY : SPARK_CUE_POLICIES[name as CueToolName];
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
