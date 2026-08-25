import { describe, expect, it, vi } from "vitest";
import type { SparkHostContext, ToolConfig } from "@zendev-lab/spark-invocation";

import { registerSparkAskActionTool } from "./action-tool.ts";

const questions = [
  {
    id: "decision",
    prompt: "Choose?",
    type: "single",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
];

function registerAsk(options: {
  request?: (method: string, params?: unknown) => Promise<unknown>;
  execute?: ToolConfig["execute"];
}) {
  const tools = new Map<string, ToolConfig>();
  const rawTool = {
    name: "ask_user",
    label: "Ask user",
    description: "test",
    parameters: {},
    execute:
      options.execute ??
      (async () => ({
        content: [{ type: "text", text: "pending" }],
        details: { status: "pending" },
      })),
  } as unknown as ToolConfig;
  registerSparkAskActionTool(
    {
      registerTool(config) {
        tools.set(config.name, config);
      },
    },
    {
      resolveTool: () => rawTool,
      ...(options.request ? { request: options.request } : {}),
    },
  );
  const ask = tools.get("ask");
  if (!ask) throw new Error("missing canonical ask tool");
  return ask;
}

function hostContext(): SparkHostContext {
  return {
    cwd: "/workspace",
    sessionId: "sess_peer",
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
  };
}

describe("canonical ask answer and session targeting", () => {
  it("rejects toSessionId combined with autoAnswer or evidence", async () => {
    const ask = registerAsk({});
    const ctx = hostContext();
    const signal = new AbortController().signal;
    await expect(
      ask.execute(
        "tool-session-auto",
        { toSessionId: "sess_peer", autoAnswer: true, questions },
        signal,
        () => undefined,
        ctx,
      ),
    ).rejects.toThrow(/cannot be combined with autoAnswer/u);
    await expect(
      ask.execute(
        "tool-session-evidence",
        { toSessionId: "sess_peer", recordAsEvidence: true, questions },
        signal,
        () => undefined,
        ctx,
      ),
    ).rejects.toThrow(/cannot be combined with recordAsEvidence/u);
  });

  it("answers a session-addressed ask through daemon RPC", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("human.interaction.respond");
      expect(params).toEqual({
        humanRequestId: "hreq-session",
        respondentSessionId: "sess_peer",
        status: "answered",
        provenance: "session",
        answers: { decision: { values: ["yes"] } },
      });
      return { outcome: "accepted" };
    });
    const ask = registerAsk({ request });
    const result = await ask.execute(
      "tool-answer",
      {
        action: "answer",
        humanRequestId: "hreq-session",
        answers: { decision: { values: ["yes"] } },
      },
      new AbortController().signal,
      () => undefined,
      hostContext(),
    );
    expect(result.details).toMatchObject({
      action: "answer",
      result: { outcome: "accepted" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed when answer has no daemon request or current Session", async () => {
    const ask = registerAsk({});
    const signal = new AbortController().signal;
    await expect(
      ask.execute(
        "tool-answer-missing-request",
        { action: "answer", humanRequestId: "hreq-session", answers: { decision: "yes" } },
        signal,
        () => undefined,
        hostContext(),
      ),
    ).rejects.toThrow(/requires a daemon request/u);
    const request = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const withRequest = registerAsk({ request });
    await expect(
      withRequest.execute(
        "tool-answer-missing-session",
        { action: "answer", humanRequestId: "hreq-session", answers: { decision: "yes" } },
        signal,
        () => undefined,
        { ...hostContext(), sessionId: undefined },
      ),
    ).rejects.toThrow(/requires a current Session/u);
    expect(request).not.toHaveBeenCalled();
  });
});
