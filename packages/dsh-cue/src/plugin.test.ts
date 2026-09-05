import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";

import * as plugin from "./plugin.ts";

describe("dsh-cue Cordis service", () => {
  it("provides one Cue service and disposes it with the plugin fiber", async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(plugin, { autoStartLocal: false });

    expect(ctx.cue).toBeInstanceOf(plugin.CueService);
    expect(ctx.cue).toBe(ctx.cue);

    await fiber.dispose();
    await ctx.fiber.dispose();
  });
});
