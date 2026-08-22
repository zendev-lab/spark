import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  DEFAULT_FUSION_TIMEOUT_MS,
  DEFAULT_JUDGE_MAX_TOKENS,
  DEFAULT_PANEL_MAX_TOKENS,
  MAX_FUSION_PANELS,
  MIN_FUSION_PANELS,
} from "./deliberate.ts";
import type { FusionModelRef, FusionPanelInput, SparkFusionDeliberationRequest } from "./types.ts";

export const FUSION_TOOL_DESCRIPTION =
  "Run bounded independent model opinions and a structured comparison; the active model remains the final writer.";

export const FUSION_TOOL_GUIDANCE = [
  "Use fusion selectively for consequential ambiguity, competing hypotheses, or work that benefits from genuinely independent model perspectives; skip it for simple or already-settled tasks.",
  "Treat Fusion as advisory. Read its panel evidence, contradictions, blind spots, and answer outline, then verify important claims before writing the final answer yourself.",
  "Prefer the default same-session perspectives unless model diversity materially helps and the user-approved provider/data-egress policy permits explicit model overrides.",
  "A partial or failed result is not consensus. Preserve uncertainty and continue mechanically instead of inventing a synthesis.",
] as const;

const FUSION_TOOL_PARAMETERS = Type.Object(
  {
    action: Type.Literal("deliberate"),
    question: Type.String({
      minLength: 1,
      maxLength: 12_000,
      description: "The exact question or decision for the panel to analyze.",
    }),
    context: Type.Optional(
      Type.String({
        maxLength: 48_000,
        description: "Bounded evidence or context shared with every panel and the judge.",
      }),
    ),
    panels: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
            perspective: Type.String({ minLength: 1, maxLength: 2_000 }),
            model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        { minItems: MIN_FUSION_PANELS, maxItems: MAX_FUSION_PANELS },
      ),
    ),
    judgeModel: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    panelMaxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 8_192 })),
    judgeMaxTokens: Type.Optional(Type.Integer({ minimum: 128, maximum: 8_192 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 600_000 })),
  },
  { additionalProperties: false },
);

export type FusionToolParameters = Static<typeof FUSION_TOOL_PARAMETERS>;

export function assertFusionToolParameters(value: unknown): asserts value is FusionToolParameters {
  if (Value.Check(FUSION_TOOL_PARAMETERS, value)) return;
  const detail = [...Value.Errors(FUSION_TOOL_PARAMETERS, value)]
    .map((error) => error.message)
    .join("; ");
  throw new Error(`invalid fusion arguments: ${detail}`);
}

export function fusionToolRequest(
  params: FusionToolParameters,
  signal: AbortSignal,
  model: FusionModelRef | undefined,
): SparkFusionDeliberationRequest {
  return {
    question: params.question,
    ...(params.context !== undefined ? { context: params.context } : {}),
    ...(params.panels !== undefined ? { panels: params.panels as FusionPanelInput[] } : {}),
    ...(params.judgeModel !== undefined ? { judgeModel: params.judgeModel } : {}),
    panelMaxTokens: params.panelMaxTokens ?? DEFAULT_PANEL_MAX_TOKENS,
    judgeMaxTokens: params.judgeMaxTokens ?? DEFAULT_JUDGE_MAX_TOKENS,
    timeoutMs: params.timeoutMs ?? DEFAULT_FUSION_TIMEOUT_MS,
    ...(model ? { sessionModel: model } : {}),
    signal,
  };
}
