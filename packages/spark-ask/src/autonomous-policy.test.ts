import { describe, expect, it, vi } from "vitest";
import type { SparkHostContext, ToolConfig } from "@zendev-lab/spark-core";

import { registerSparkAskActionTool } from "./action-tool.ts";
import { registerSparkAskFlowTool } from "./flow.ts";
import { registerSparkAskTools } from "./index.ts";

function autonomousContext(): SparkHostContext {
  return {
    cwd: "/workspace",
    sessionId: "session:owner",
    ui: {
      interactionCapabilities: {
        version: 1,
        askFlow: {
          deliveries: ["blocking", "async"],
          timeout: true,
          responseCorrelation: "request_id",
          asyncAcknowledgement: "pending_with_human_request_id",
        },
      },
      interaction: async (request) => ({
        kind: "askFlow",
        requestId: request.requestId,
        humanRequestId: "hreq:test",
        status: "pending",
      }),
    },
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
    const firstEvidenceRequest = first?.evidenceRequest as
      | { askRef?: string; requestHash?: string }
      | undefined;
    expect(forwarded.map((entry) => entry.canonicalDispatch)).toEqual([true, true]);
    expect(first?.interactionRequestId).toMatch(/^ask_[a-f0-9]{32}$/u);
    expect(first?.interactionRequestId).toBe(
      `ask_${String(firstEvidenceRequest?.requestHash).slice(0, 32)}`,
    );
    expect(first?.evidenceRequest).toMatchObject({
      schema: "spark.evidence-request/v1",
      askRef: `ask:${firstEvidenceRequest?.requestHash}`,
      ownerSessionId: "session:owner",
      goalOrReproId: "goal:active",
      modeScope: "goal",
      planRevision: 1,
      ownerStepOrUnresolvedId: "unresolved:decision",
      stepDefinitionDigest: "definition",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      ownerQuestionId: "choice",
      expectedAnswerKind: "single",
    });
    expect(second?.interactionRequestId).not.toBe(first?.interactionRequestId);
  });

  it("rejects omitted/blocking delivery before raw dispatch when auto-answer is disabled", async () => {
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
    for (const params of [base, { ...base, delivery: "blocking" }]) {
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

  it("allows revision-bound autonomous reviewer auto-answer", async () => {
    const execute = vi.fn(
      async (
        _toolCallId: string,
        _params: Record<string, unknown>,
        _signal: AbortSignal,
        _onUpdate: unknown,
        ctx: SparkHostContext,
      ) =>
        (ctx as SparkHostContext & { askAnswerSource?: string }).askAnswerSource === "reviewer"
          ? {
              details: {
                result: {
                  status: "answered",
                  answerSource: "reviewer",
                  answers: { choice: { values: ["a"], labels: ["A"] } },
                },
              },
            }
          : { details: { result: { status: "pending", timedOut: true } } },
    );
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
        autoAnswer: async () => ({
          answers: { choice: { values: ["a"] } },
          reason: "delegated unattended decision",
        }),
      },
    );

    const ctx = autonomousContext() as SparkHostContext & { askAutoAnswer?: boolean };
    ctx.askAutoAnswer = true;
    const result = await ask!.execute(
      "tool-call",
      {
        autoAnswer: true,
        delivery: "blocking",
        mode: "decision",
        context: "bound",
        questions: [
          {
            id: "choice",
            prompt: "Choose?",
            type: "single",
            required: true,
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      },
      new AbortController().signal,
      () => undefined,
      ctx,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ autoAnswered: true, answerSource: "reviewer" });
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
