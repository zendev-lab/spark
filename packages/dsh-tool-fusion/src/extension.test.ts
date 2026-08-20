import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, {
  CallId,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

import * as FusionPlugin from "./extension.ts";

function opinion(): string {
  return JSON.stringify({
    version: 1,
    conclusion: "Run the bounded probe.",
    keyPoints: ["It separates the candidate boundaries."],
    evidenceRefs: [],
    assumptions: [],
    uncertainties: [],
  });
}

function analysis(): string {
  return JSON.stringify({
    version: 1,
    consensus: ["Run the bounded probe."],
    contradictions: [],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
    answerOutline: ["State the next falsifiable experiment."],
    confidence: "medium",
  });
}

describe("dsh-tool-fusion", () => {
  it("runs bounded calls through the native DSH LLM service", async () => {
    const ctx = new Context();
    const requests: GenerateOptions[] = [];
    try {
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      ctx.llm.registerAdapter(
        ["test"],
        new (class extends LlmAdapter {
          async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
            requests.push(options);
            const text = requests.length === 3 ? analysis() : opinion();
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text };
            yield { type: "block-end", index: 0, block: { type: "text", text } };
            yield { type: "finish", reason: { kind: "stop" } };
          }
        })(),
      );
      await ctx.plugin(FusionPlugin, { defaultModel: { provider: "test", model: "model" } });

      const definition = ctx.tools.get("fusion");
      expect(definition).toBeDefined();
      expect(definition).not.toHaveProperty("sparkPolicy");
      const result = await ctx.tools.execute({
        callId: CallId("fusion-call"),
        name: "fusion",
        arguments: {
          action: "deliberate",
          question: "Which probe should run?",
          panels: [
            { perspective: "Find the smallest discriminator." },
            { perspective: "Challenge the likely false positive." },
          ],
        },
        signal: new AbortController().signal,
      });

      expect(result.isError).toBe(false);
      if (result.isError) throw new Error(result.error.message);
      expect(result.value).toMatchObject({ status: "complete" });
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.provider === "test")).toBe(true);
      expect(requests[0]).toMatchObject({ model: "model", maxTokens: 2048 });
      expect(requests[0]?.system).toContain("independent panelist");
      expect(requests[2]?.system).toContain("comparison judge");
      expect((await ctx.systemPrompt.assemble()).sections).toContainEqual(
        expect.objectContaining({ name: "tool:fusion" }),
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("keeps the legacy parameter bounds fail-closed", async () => {
    const ctx = new Context();
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      await ctx.plugin(LlmRuntime);
      await ctx.plugin(FusionPlugin);
      const result = await ctx.tools.execute({
        callId: CallId("fusion-invalid"),
        name: "fusion",
        arguments: { action: "deliberate", question: "" },
        signal: new AbortController().signal,
      });
      expect(result.isError).toBe(true);
      if (!result.isError) throw new Error("expected an invalid-argument failure");
      expect(result.error.message).toContain("invalid fusion arguments");
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
