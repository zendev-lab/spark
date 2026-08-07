import { describe, expect, it, vi } from "vitest";
import type { SparkHostContext, ToolConfig } from "@zendev-lab/spark-core";

import { registerSparkAskActionTool } from "./action-tool.ts";
import { registerSparkAskFlowTool } from "./flow.ts";
import { registerSparkAskTools } from "./index.ts";

function autonomousContext(): SparkHostContext {
  return {
    cwd: "/workspace",
    sessionId: "session:owner",
    sparkAutonomousAsk: {
      modeScope: "goal",
      goalOrReproId: "goal:active",
      ownerSessionId: "session:owner",
      resolveBinding: () => ({
        planRevision: 1,
        ownerStepOrUnresolvedId: "unresolved:decision",
        stepDefinitionDigest: "definition",
      }),
    },
  };
}

describe("autonomous canonical Ask", () => {
  it("injects a revision-fenced binding and changes request identity across revisions", async () => {
    const tools = new Map<string, ToolConfig>();
    const forwarded: Array<{
      params: Record<string, unknown>;
      canonicalDispatch: unknown;
    }> = [];
    const rawTool = {
      name: "ask_user",
      label: "Ask user",
      description: "test",
      parameters: {},
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal,
        _onUpdate: unknown,
        ctx: SparkHostContext,
      ) => {
        forwarded.push({
          params,
          canonicalDispatch: (ctx as SparkHostContext & { sparkCanonicalAskDispatch?: unknown })
            .sparkCanonicalAskDispatch,
        });
        return { status: "pending" };
      },
    } as unknown as ToolConfig;
    registerSparkAskActionTool(
      {
        registerTool(config) {
          tools.set(config.name, config);
        },
      },
      { resolveTool: () => rawTool },
    );
    const ask = tools.get("ask");
    if (!ask) throw new Error("missing canonical ask tool");
    const params = {
      delivery: "async",
      title: "Choose",
      mode: "decision",
      questions: [
        {
          id: "choice",
          prompt: "Choose?",
          type: "single",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    };
    const firstCtx = autonomousContext();
    await ask.execute("tool-call", params, new AbortController().signal, () => undefined, firstCtx);
    const secondCtx = autonomousContext();
    secondCtx.sparkAutonomousAsk = {
      ...secondCtx.sparkAutonomousAsk!,
      resolveBinding: () => ({
        planRevision: 2,
        ownerStepOrUnresolvedId: "unresolved:decision",
        stepDefinitionDigest: "definition",
      }),
    };
    await ask.execute(
      "tool-call",
      params,
      new AbortController().signal,
      () => undefined,
      secondCtx,
    );

    expect(forwarded).toHaveLength(2);
    const first = forwarded[0]?.params;
    const second = forwarded[1]?.params;
    expect(forwarded.map((entry) => entry.canonicalDispatch)).toEqual([true, true]);
    expect(first?.interactionRequestId).toMatch(/^ask_async:[a-f0-9]{64}$/u);
    expect(first?.evidenceRequest).toMatchObject({
      schema: "spark.evidence-request/v1",
      askRef: expect.stringMatching(/^ask:[a-f0-9]{64}$/u),
      ownerSessionId: "session:owner",
      goalOrReproId: "goal:active",
      modeScope: "goal",
      planRevision: 1,
      ownerStepOrUnresolvedId: "unresolved:decision",
      stepDefinitionDigest: "definition",
      requestHash: String(first?.interactionRequestId).slice("ask_async:".length),
      expectedAnswerKind: "single",
    });
    expect(second?.interactionRequestId).not.toBe(first?.interactionRequestId);
  });

  it("rejects omitted/blocking delivery and reviewer fallback before raw dispatch", async () => {
    const execute = vi.fn(async () => ({ status: "pending" }));
    let ask: ToolConfig | undefined;
    registerSparkAskActionTool(
      { registerTool: (tool) => (ask = tool) },
      {
        resolveTool: () =>
          ({
            name: "ask_user",
            label: "Ask user",
            description: "test",
            parameters: {},
            execute,
          }) as unknown as ToolConfig,
      },
    );
    const base = {
      mode: "decision",
      questions: [{ id: "choice", prompt: "Choose?", type: "single" }],
    };
    for (const params of [base, { ...base, delivery: "blocking" }, { ...base, autoAnswer: true }]) {
      await expect(
        ask!.execute(
          "tool-call",
          params,
          new AbortController().signal,
          () => undefined,
          autonomousContext(),
        ),
      ).rejects.toThrow(/AUTONOMOUS_ASYNC_ONLY/u);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("autonomous Ask alias guard", () => {
  it("rejects ask_user and ask_flow before either can invoke UI", async () => {
    const tools = new Map<string, ToolConfig>();
    const api = {
      registerTool(config: ToolConfig) {
        tools.set(config.name, config);
      },
    };
    registerSparkAskTools(api as never);
    registerSparkAskFlowTool(api as never);
    const interaction = vi.fn(async () => {
      throw new Error("UI must not be invoked");
    });
    const ctx = { ...autonomousContext(), ui: { interaction } };
    const params = {
      delivery: "async",
      title: "Choose",
      mode: "decision",
      questions: [
        {
          id: "choice",
          prompt: "Choose?",
          type: "single",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      ],
    };

    for (const name of ["ask_user", "ask_flow"] as const) {
      const tool = tools.get(name);
      expect(tool).toBeDefined();
      await expect(
        tool!.execute("tool-call", params, new AbortController().signal, () => undefined, ctx),
      ).rejects.toThrow(/AUTONOMOUS_ASYNC_ONLY/u);
    }
    expect(interaction).not.toHaveBeenCalled();
  });
});
