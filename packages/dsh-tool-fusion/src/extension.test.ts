import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import type { LeafCapabilityRequest, SparkExecutionService } from "@zendev-lab/spark-core";

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
  it("registers a policy-bearing DSH tool over ctx.sparkExecution", async () => {
    const ctx = new Context();
    let calls = 0;
    try {
      await ctx.plugin(SystemPrompt);
      await ctx.plugin(ToolRuntime);
      const execution: SparkExecutionService = {
        cwd: "/tmp/dsh-tool-fusion",
        sessionId: "session-fusion",
        model: { provider: "test", id: "model" },
        async runLeaf(_request: LeafCapabilityRequest) {
          calls += 1;
          return {
            degraded: false,
            text: calls === 3 ? analysis() : opinion(),
            model: "test/model",
          };
        },
      };
      ctx.provide("sparkExecution", execution);
      await ctx.plugin(FusionPlugin);

      const definition = ctx.tools.get("fusion");
      expect(definition?.sparkPolicy).toEqual({
        effect: "read",
        executionMode: "sequential",
        domains: ["models", "deliberation"],
        modes: ["plan", "execute"],
        approval: "required",
        reconcile: "none",
      });
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
      expect(calls).toBe(3);
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
      ctx.provide("sparkExecution", {
        cwd: "/tmp/dsh-tool-fusion",
        sessionId: "session-fusion-invalid",
      } satisfies SparkExecutionService);
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
