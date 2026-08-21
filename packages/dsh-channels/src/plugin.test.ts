import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import { createChannelsPlugin } from "./plugin.ts";
import { FakeChannelTransport } from "./transport.ts";
import type { ChannelTransport } from "./types.ts";

describe("dsh-channels Cordis plugin", () => {
  it("runs each account in a child fiber and disposes every transport", async () => {
    const ctx = new Context();
    const transports = new Map([
      ["feishu-a", new FakeChannelTransport()],
      ["feishu-b", new FakeChannelTransport()],
    ]);
    const messages: string[] = [];
    ctx.on("channels/message", (message) => messages.push(message.text));
    await ctx.plugin(createChannelsPlugin({ createTransport: (id) => transports.get(id) }), {
      adapters: {
        "feishu-a": { type: "feishu", app_id: "cli_a", app_secret: "secret-a" },
        "feishu-b": { type: "feishu", app_id: "cli_b", app_secret: "secret-b" },
      },
      routes: {},
    });

    expect(ctx.channels.generationNumber).toBe(1);
    expect(ctx.channels.listAdapters().every((adapter) => adapter.running)).toBe(true);
    transports.get("feishu-a")?.emitInbound({
      chat_id: "oc_1",
      text: "hello",
      message_id: "om_1",
    });
    expect(messages).toEqual(["hello"]);

    await ctx.fiber.dispose();
    expect([...transports.values()].every((transport) => !transport.isRunning)).toBe(true);
  });

  it("keeps the old generation live when replacement startup fails", async () => {
    const ctx = new Context();
    const oldTransport = new FakeChannelTransport();
    const failingTransport: ChannelTransport = {
      async start() {
        throw new Error("new account refused connection");
      },
      async stop() {},
      async send() {},
      status: () => ({ state: "degraded", error: "new account refused connection" }),
    };
    await ctx.plugin(
      createChannelsPlugin({
        createTransport: (id) => (id === "old" ? oldTransport : failingTransport),
      }),
      {
        adapters: { old: { type: "feishu", app_id: "cli_old", app_secret: "old" } },
        routes: {},
      },
    );

    await expect(
      ctx.channels.reload({
        adapters: { replacement: { type: "feishu", app_id: "cli_new", app_secret: "new" } },
        routes: {},
      }),
    ).rejects.toThrow("new account refused connection");

    expect(ctx.channels.generationNumber).toBe(1);
    expect(ctx.channels.listAdapters().map((adapter) => adapter.id)).toEqual(["old"]);
    expect(oldTransport.isRunning).toBe(true);
    await ctx.fiber.dispose();
  });

  it("starts the replacement before atomically switching and stopping the old account", async () => {
    const ctx = new Context();
    const events: string[] = [];
    const transport = (id: string): ChannelTransport => {
      let running = false;
      return {
        async start() {
          running = true;
          events.push(`start:${id}`);
        },
        async stop() {
          running = false;
          events.push(`stop:${id}`);
        },
        async send() {},
        status: () => ({ state: running ? "connected" : "stopped" }),
      };
    };
    await ctx.plugin(createChannelsPlugin({ createTransport: (id) => transport(id) }), {
      adapters: { old: { type: "feishu", app_id: "cli_old", app_secret: "old" } },
      routes: {},
    });

    await ctx.channels.reload({
      adapters: { next: { type: "feishu", app_id: "cli_next", app_secret: "next" } },
      routes: {},
    });

    expect(events.slice(0, 3)).toEqual(["start:old", "start:next", "stop:old"]);
    expect(ctx.channels.generationNumber).toBe(2);
    expect(ctx.channels.listAdapters().map((adapter) => adapter.id)).toEqual(["next"]);
    await ctx.fiber.dispose();
  });

  it("keeps the old generation live when persistence before commit fails", async () => {
    const ctx = new Context();
    const oldTransport = new FakeChannelTransport();
    const replacementTransport = new FakeChannelTransport();
    let boundService = false;
    await ctx.plugin(
      createChannelsPlugin({
        createTransport: (id) => (id === "old" ? oldTransport : replacementTransport),
        onService: () => {
          boundService = true;
        },
      }),
      {
        adapters: { old: { type: "feishu", app_id: "cli_old", app_secret: "old" } },
        routes: {},
      },
    );

    expect(boundService).toBe(true);
    await expect(
      ctx.channels.reload(
        {
          adapters: { next: { type: "feishu", app_id: "cli_next", app_secret: "next" } },
          routes: {},
        },
        () => {
          throw new Error("config fsync failed");
        },
      ),
    ).rejects.toThrow("config fsync failed");

    expect(ctx.channels.listAdapters().map(({ id }) => id)).toEqual(["old"]);
    expect(oldTransport.isRunning).toBe(true);
    expect(replacementTransport.isRunning).toBe(false);
    await ctx.fiber.dispose();
  });
});
