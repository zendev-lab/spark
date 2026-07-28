import {
  PROTOCOL_VERSION,
  client,
  methods,
  type RequestPermissionResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SparkTurnStreamPage } from "@zendev-lab/spark-protocol";
import { createSparkAcpAgent, type SparkAcpDaemon } from "./index.ts";

class FakeDaemon implements SparkAcpDaemon {
  readonly submitted: Array<{ sessionId: string; prompt: string; idempotencyKey: string }> = [];
  readonly cancellations: Array<{ invocationId: string; reason: string }> = [];
  readonly humanResponses: Record<string, unknown>[] = [];
  pages: SparkTurnStreamPage[] = [];
  status: "running" | "succeeded" | "failed" | "cancelled" = "succeeded";
  assistantText = "daemon answer";

  async createSession(_input: { cwd: string }) {
    return { sessionId: "sess_acp_canonical", createdAt: "2026-07-27T00:00:00.000Z" };
  }

  async submitTurn(input: { sessionId: string; prompt: string; idempotencyKey: string }) {
    this.submitted.push(input);
    return { invocationId: "inv_acp_canonical" };
  }

  async streamTurn(): Promise<SparkTurnStreamPage> {
    return (
      this.pages.shift() ?? {
        invocationId: "inv_acp_canonical",
        events: [],
        nextCursor: 0,
        hasMore: false,
      }
    );
  }

  async statusTurn() {
    return { invocationId: "inv_acp_canonical", status: this.status };
  }

  async resultTurn() {
    return {
      invocationId: "inv_acp_canonical",
      status: this.status,
      assistantText: this.assistantText,
    };
  }

  async cancelTurn(input: { invocationId: string; reason: string }) {
    this.cancellations.push(input);
    this.status = "cancelled";
  }

  async respondHuman(input: Record<string, unknown>) {
    this.humanResponses.push(input);
  }

  close() {}
}

function messagePage(): SparkTurnStreamPage {
  return {
    invocationId: "inv_acp_canonical",
    nextCursor: 1,
    hasMore: false,
    events: [
      {
        invocationId: "inv_acp_canonical",
        sequence: 1,
        kind: "daemon.view_event",
        createdAt: "2026-07-27T00:00:01.000Z",
        payload: {
          version: 1,
          type: "daemon.view_event",
          source: "daemon",
          metadata: {},
          view: {
            version: 1,
            type: "session.message",
            sessionId: "sess_acp_canonical",
            message: {
              version: 1,
              id: "assistant-1",
              role: "assistant",
              text: "daemon answer",
              status: "done",
              parts: [
                {
                  id: "assistant-1:tool-call",
                  type: "tool-call",
                  status: "complete",
                  toolCallId: "call-1",
                  toolName: "read",
                  summary: "Read file",
                  metadata: {},
                },
                {
                  id: "assistant-1:tool-result",
                  type: "tool-result",
                  status: "complete",
                  toolCallId: "call-1",
                  toolName: "read",
                  summary: "Read complete",
                  metadata: {},
                },
              ],
              metadata: {},
            },
          },
        },
      },
    ],
  };
}

function approvalPage(): SparkTurnStreamPage {
  return {
    invocationId: "inv_acp_canonical",
    nextCursor: 1,
    hasMore: false,
    events: [
      {
        invocationId: "inv_acp_canonical",
        sequence: 1,
        kind: "daemon.interaction.request",
        createdAt: "2026-07-27T00:00:01.000Z",
        payload: {
          version: 1,
          type: "daemon.interaction.request",
          source: "daemon",
          metadata: {},
          request: {
            version: 1,
            requestId: "approval-1",
            kind: "toolApproval",
            title: "Approve cue_exec",
            toolName: "cue_exec",
            toolCallId: "call-approval",
            approveLabel: "Approve",
            rejectLabel: "Reject",
            metadata: {},
          },
        },
      },
    ],
  };
}

function testClient(updates: SessionUpdate[], permission?: RequestPermissionResponse) {
  return client({ name: "spark-acp-test-client" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    .onRequest(
      methods.client.session.requestPermission,
      async () => permission ?? { outcome: { outcome: "selected", optionId: "approve" } },
    );
}

describe("spark-acp daemon adapter", () => {
  it("initializes conservatively and forwards a canonical daemon turn", async () => {
    const daemon = new FakeDaemon();
    daemon.pages = [messagePage()];
    const updates: SessionUpdate[] = [];
    const handle = createSparkAcpAgent({ name: "spark-acp-test", daemon, pollIntervalMs: 0 });

    await testClient(updates).connectWith(handle.app, async (agentCtx) => {
      const init = await agentCtx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "spark-acp-test-client", version: "0.0.0" },
      });
      expect(init.agentInfo?.name).toBe("spark-acp-test");
      expect(init.agentCapabilities?.loadSession).toBe(false);

      await agentCtx
        .buildSession({ cwd: "/tmp/spark-acp", mcpServers: [] })
        .withSession(async (session) => {
          expect(session.sessionId).toBe("sess_acp_canonical");
          const result = await session.prompt("hello from ACP client");
          expect(result.stopReason).toBe("end_turn");
        });
    });

    expect(daemon.submitted).toEqual([
      expect.objectContaining({
        sessionId: "sess_acp_canonical",
        prompt: "hello from ACP client",
        idempotencyKey: expect.stringMatching(/^acp:sess_acp_canonical:/u),
      }),
    ]);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
        expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "call-1" }),
        expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "call-1" }),
      ]),
    );
  });

  it.each([
    ["approve", true],
    ["reject", false],
  ] as const)(
    "maps ACP %s permission to the canonical approval answer",
    async (optionId, approved) => {
      const daemon = new FakeDaemon();
      daemon.pages = [approvalPage()];
      const handle = createSparkAcpAgent({ daemon, pollIntervalMs: 0 });
      const updates: SessionUpdate[] = [];

      await testClient(updates, {
        outcome: { outcome: "selected", optionId },
      }).connectWith(handle.app, async (agentCtx) => {
        await agentCtx.buildSession("/tmp/spark-acp").withSession(async (session) => {
          await expect(session.prompt("approve a tool")).resolves.toMatchObject({
            stopReason: "end_turn",
          });
        });
      });

      expect(daemon.humanResponses).toHaveLength(1);
      expect(daemon.humanResponses[0]).toMatchObject({
        interactionRequestId: "approval-1",
        sessionId: "sess_acp_canonical",
        invocationId: "inv_acp_canonical",
        status: "answered",
        answers: {
          approval: {
            values: [approved ? "approve" : "reject"],
          },
        },
      });
    },
  );

  it("maps cancelled permission without manufacturing an approval", async () => {
    const daemon = new FakeDaemon();
    daemon.pages = [approvalPage()];
    const handle = createSparkAcpAgent({ daemon, pollIntervalMs: 0 });

    await testClient([], { outcome: { outcome: "cancelled" } }).connectWith(
      handle.app,
      async (agentCtx) => {
        await agentCtx
          .buildSession("/tmp/spark-acp")
          .withSession((session) => session.prompt("cancel approval"));
      },
    );

    expect(daemon.humanResponses[0]).toMatchObject({ status: "cancelled", answers: {} });
  });

  it("fails closed for unknown sessions, empty text, and non-text content", async () => {
    const daemon = new FakeDaemon();
    const handle = createSparkAcpAgent({ daemon, pollIntervalMs: 0 });
    await testClient([]).connectWith(handle.app, async (agentCtx) => {
      await expect(
        agentCtx.request(methods.agent.session.prompt, {
          sessionId: "missing",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow(/unknown ACP session/u);
      const session = await agentCtx.buildSession("/tmp/spark-acp").start();
      await expect(
        agentCtx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "   " }],
        }),
      ).rejects.toThrow(/must not be empty/u);
      await expect(
        agentCtx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "image",
              data: "AA==",
              mimeType: "image/png",
            },
          ],
        }),
      ).rejects.toThrow(/text prompt blocks only/u);
      session.dispose();
    });
    expect(daemon.submitted).toEqual([]);
  });

  it("cancels only the active invocation for its ACP session", async () => {
    const daemon = new FakeDaemon();
    daemon.status = "running";
    const handle = createSparkAcpAgent({ daemon, pollIntervalMs: 1 });
    await testClient([]).connectWith(handle.app, async (agentCtx) => {
      const session = await agentCtx.buildSession("/tmp/spark-acp").start();
      const prompting = session.prompt("long turn");
      await vi.waitFor(() => expect(daemon.submitted).toHaveLength(1));
      await agentCtx.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
      await expect(prompting).resolves.toMatchObject({ stopReason: "cancelled" });
      session.dispose();
    });
    expect(daemon.cancellations).toEqual([
      expect.objectContaining({ invocationId: "inv_acp_canonical" }),
    ]);
  });
});
