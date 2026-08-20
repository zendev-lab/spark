import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type JsonValue,
  type ParameterSchemaSpec,
  type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import {
  callLeafOrDegrade,
  type SparkDshToolPolicyMetadata,
  type SparkExecutionService,
} from "@zendev-lab/spark-core";

import { deliberateSparkFusion } from "./deliberate.ts";
import {
  assertFusionToolParameters,
  FUSION_TOOL_DESCRIPTION,
  FUSION_TOOL_GUIDANCE,
  fusionToolRequest,
} from "./tool-contract.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sparkExecution: SparkExecutionService;
  }
}

declare module "@deepseek-ai/dsh-tools" {
  interface ToolDefinition {
    /** Spark's fail-closed execution policy, omitted from the model schema. */
    readonly sparkPolicy?: SparkDshToolPolicyMetadata;
  }
}

export const name = "dsh-tool-fusion";
export const inject = ["tools", "systemPrompt", "sparkExecution"];

const FUSION_DSH_PARAMETERS = {
  action: { type: "string", const: "deliberate", required: true },
  question: {
    type: "string",
    required: true,
    description: "Question for the panel (1-12000 characters).",
  },
  context: { type: "string", description: "Shared evidence (at most 48000 characters)." },
  panels: {
    type: "array",
    description: "Two to four independent panel definitions.",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Optional stable panel id (1-64 characters)." },
        perspective: {
          type: "string",
          required: true,
          description: "Independent perspective (1-2000 characters).",
        },
        model: { type: "string", description: "Optional provider/model override." },
      },
    },
  },
  judgeModel: { type: "string", description: "Optional provider/model judge override." },
  panelMaxTokens: { type: "integer", description: "Per-panel output limit (128-8192)." },
  judgeMaxTokens: { type: "integer", description: "Judge output limit (128-8192)." },
  timeoutMs: { type: "integer", description: "Overall timeout in milliseconds (1000-600000)." },
} as const satisfies ParameterSchemaSpec;

const FUSION_POLICY = Object.freeze({
  effect: "read",
  executionMode: "sequential",
  domains: ["models", "deliberation"],
  modes: ["plan", "execute"],
  approval: "required",
  reconcile: "none",
} as const satisfies SparkDshToolPolicyMetadata);

export function createDshFusionTool(ctx: Context): ToolDefinition {
  const definition = defineTool({
    name: "fusion",
    description: FUSION_TOOL_DESCRIPTION,
    parameters: FUSION_DSH_PARAMETERS,
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertFusionToolParameters(args);
      const execution = ctx.get("sparkExecution");
      if (!execution) throw new Error("fusion requires invocation-scoped ctx.sparkExecution");
      const result = await deliberateSparkFusion(
        fusionToolRequest(args, exec.signal, execution.model),
        {
          runLeaf: (request) => callLeafOrDegrade(execution, request),
        },
      );
      if (result.status === "failed") throw new Error(JSON.stringify(result, null, 2));
      return result as unknown as JsonValue;
    },
  });
  return { ...definition, sparkPolicy: FUSION_POLICY };
}

export function apply(ctx: Context): void {
  ctx.tools.register(createDshFusionTool(ctx));
  ctx.systemPrompt.section({
    name: "tool:fusion",
    order: 120,
    text: FUSION_TOOL_GUIDANCE.join(" "),
  });
}
