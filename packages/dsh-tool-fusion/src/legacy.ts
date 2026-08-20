import type {
  SparkHostContext,
  ToolConfig,
  ToolRenderComponent,
  ToolRenderTheme,
} from "@zendev-lab/spark-core";
import { callLeafOrDegrade } from "@zendev-lab/spark-core";
import { deliberateSparkFusion } from "./deliberate.ts";
import {
  assertFusionToolParameters,
  FUSION_TOOL_DESCRIPTION,
  FUSION_TOOL_GUIDANCE,
  FUSION_TOOL_PARAMETERS,
  fusionToolRequest,
} from "./tool-contract.ts";

/** @deprecated Stack-internal SparkHostAPI bridge; remove with the legacy loader. */
export interface SparkFusionExtensionApi {
  registerTool(config: ToolConfig): void;
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;
  private readonly style: ((text: string) => string) | undefined;

  constructor(text: string, style?: (text: string) => string) {
    this.text = text;
    this.style = style;
  }

  render(width: number): string[] {
    const maxWidth = Math.max(1, width);
    const line =
      this.text.length > maxWidth ? `${this.text.slice(0, Math.max(0, maxWidth - 1))}…` : this.text;
    return [this.style ? this.style(line) : line];
  }
}

export function createSparkFusionTool(): ToolConfig {
  return {
    name: "fusion",
    label: "Fusion",
    description: FUSION_TOOL_DESCRIPTION,
    promptGuidelines: [...FUSION_TOOL_GUIDANCE],
    policy: {
      effect: "read",
      executionMode: "sequential",
      domains: ["models", "deliberation"],
      modes: ["plan", "execute"],
      approval: "required",
    },
    parameters: FUSION_TOOL_PARAMETERS,
    renderCall(args, theme) {
      const panelCount = Array.isArray(args.panels) ? args.panels.length : 3;
      return renderCall(theme, `fusion action=deliberate panels=${panelCount}`);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertFusionToolParameters(params);
      const request = fusionToolRequest(params, signal, (ctx as SparkHostContext).model);
      const result = await deliberateSparkFusion(request, {
        runLeaf: (leafRequest) => callLeafOrDegrade(ctx as SparkHostContext, leafRequest),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { ...result },
        ...(result.status === "failed" ? { isError: true } : {}),
      };
    },
  };
}

export function registerSparkFusionTool(api: SparkFusionExtensionApi): void {
  api.registerTool(createSparkFusionTool());
}

/** @deprecated Stack-internal SparkHostAPI bridge; use the Cordis plugin root. */
export default function sparkFusionExtension(api: SparkFusionExtensionApi): void {
  registerSparkFusionTool(api);
}

function renderCall(theme: ToolRenderTheme, text: string): ToolCallText {
  // Fusion labels are controlled ASCII; apply ANSI styling only after width truncation.
  return new ToolCallText(text, theme.bold);
}
