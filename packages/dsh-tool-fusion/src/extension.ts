import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool, type ParameterSchemaSpec, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";

import { deliberateSparkFusion } from "./deliberate.ts";
import {
  assertFusionToolParameters,
  FUSION_TOOL_DESCRIPTION,
  FUSION_TOOL_GUIDANCE,
  fusionToolRequest,
} from "./tool-contract.ts";
import type { FusionModelCallRequest, FusionModelCallResult, FusionModelRef } from "./types.ts";

export { FUSION_TOOL_GUIDANCE } from "./tool-contract.ts";

export const name = "dsh-tool-fusion";
export const inject = ["llm", "tools", "systemPrompt"];

export interface Config {
  /** Fallback for diagnostics or direct ToolRuntime use without an Agent. */
  defaultModel?: FusionModelRef;
  /** Host route mapping for private or scoped provider namespaces. */
  resolveModel?: (
    override: string | undefined,
    fallback: FusionModelRef | undefined,
  ) => FusionModelRef | undefined;
}

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

export function createDshFusionTool(ctx: Context, config: Config = {}): ToolDefinition {
  return defineTool({
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
      const agentModel = exec.agent?.options;
      const sessionModel =
        nonEmpty(agentModel?.provider) && nonEmpty(agentModel?.model)
          ? { provider: agentModel.provider, model: agentModel.model }
          : config.defaultModel;
      const result = await deliberateSparkFusion(
        fusionToolRequest(args, exec.signal, sessionModel),
        {
          runLeaf: (request) => runDshModelCall(ctx, request, config.resolveModel),
        },
      );
      if (result.status === "failed") throw new Error(JSON.stringify(result, null, 2));
      return result as unknown as JsonValue;
    },
  });
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.tools.register(createDshFusionTool(ctx, config));
  ctx.systemPrompt.section({
    name: "tool:fusion",
    order: 120,
    text: FUSION_TOOL_GUIDANCE.join(" "),
  });
}

async function runDshModelCall(
  ctx: Context,
  request: FusionModelCallRequest,
  resolver: Config["resolveModel"],
): Promise<FusionModelCallResult> {
  const selected = resolver
    ? resolver(request.model, request.sessionModel)
    : resolveModel(request.model, request.sessionModel);
  if (!selected) return { degraded: true, text: "", reasonCode: "no-model" };
  const model = `${selected.provider}/${selected.model}`;
  const assembler = new BlockAssembler();
  try {
    for await (const chunk of ctx.llm.stream({
      provider: selected.provider,
      model: selected.model,
      system: request.brief,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: request.input }],
          source: { kind: "user" },
        }),
      ],
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    })) {
      assembler.push(chunk);
    }
  } catch {
    return {
      degraded: true,
      text: "",
      model,
      reasonCode: request.signal?.aborted ? "aborted" : "model-call-failed",
    };
  }
  const finish = assembler.finish;
  if (finish.kind === "aborted") {
    return { degraded: true, text: "", model, reasonCode: "aborted" };
  }
  if (finish.kind === "error") {
    return {
      degraded: true,
      text: "",
      model,
      reasonCode: finish.failure.code === "NO_ADAPTER" ? "route-unavailable" : "model-call-failed",
    };
  }
  const text = assembler
    .blocks()
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  return { degraded: false, text, model };
}

function resolveModel(
  override: string | undefined,
  fallback: FusionModelRef | undefined,
): FusionModelRef | undefined {
  if (!override) return fallback;
  const separator = override.indexOf("/");
  if (separator < 1) return fallback ? { provider: fallback.provider, model: override } : undefined;
  const provider = override.slice(0, separator).trim();
  const model = override.slice(separator + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
