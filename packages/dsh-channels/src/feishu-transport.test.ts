import { describe, expect, it, vi } from "vitest";

import {
  createFeishuTransport,
  normalizeFeishuMessageEvent,
  type FeishuSdkRuntime,
} from "./feishu-transport.ts";
import type { ChannelTransportStatus } from "./types.ts";

describe("Feishu production transport", () => {
  it("waits for runtime readiness, normalizes inbound, and returns provider receipts", async () => {
    let emit:
      | ((message: Parameters<Parameters<FeishuSdkRuntime["start"]>[0]>[0]) => void)
      | undefined;
    let state: ChannelTransportStatus = { state: "stopped" };
    const send = vi.fn(async () => ({ messageId: "om_sent" }));
    const runtime: FeishuSdkRuntime = {
      async start(onMessage) {
        emit = onMessage;
        state = { state: "connected" };
      },
      stop() {
        state = { state: "stopped" };
      },
      send,
      status: () => state,
    };
    const transport = createFeishuTransport(
      { type: "feishu", app_id: "cli_0000000000000000", app_secret: "secret" },
      { createRuntime: () => runtime },
    );
    const inbound: unknown[] = [];

    await transport.start((message) => inbound.push(message));
    emit?.({ chat_id: "oc_1", sender_id: "ou_1", text: "hello", message_id: "om_1" });
    const delivery = await transport.send("oc_1", "reply", "delivery-1");

    expect(inbound).toEqual([
      { chat_id: "oc_1", sender_id: "ou_1", text: "hello", message_id: "om_1" },
    ]);
    expect(send).toHaveBeenCalledWith("oc_1", "reply", "delivery-1");
    expect(delivery).toEqual({
      replaySafety: "deduplicated",
      receipt: { messageId: "om_sent" },
    });
    expect(transport.status?.()).toEqual({ state: "connected" });

    await transport.stop();
    expect(transport.status?.()).toEqual({ state: "stopped" });
  });

  it("normalizes only text message events and preserves parent provenance", () => {
    expect(
      normalizeFeishuMessageEvent({
        sender: { sender_id: { open_id: "ou_sender" } },
        message: {
          chat_id: "oc_chat",
          message_id: "om_reply",
          parent_id: "om_parent",
          message_type: "text",
          content: JSON.stringify({ text: "follow up" }),
        },
      }),
    ).toEqual({
      chat_id: "oc_chat",
      sender_id: "ou_sender",
      text: "follow up",
      message_id: "om_reply",
      message_reference: { messageId: "om_parent", source: "unknown" },
    });
    expect(
      normalizeFeishuMessageEvent({
        message: {
          chat_id: "oc_chat",
          message_id: "om_image",
          message_type: "image",
          content: "{}",
        },
      }),
    ).toBeUndefined();
  });
});
