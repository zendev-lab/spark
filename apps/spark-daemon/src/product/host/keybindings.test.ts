import { describe, expect, it } from "vitest";

import { SparkKeybindings } from "./keybindings.ts";

describe("SparkKeybindings active key resolution", () => {
  it("recognizes a user override before dispatch", async () => {
    let calls = 0;
    const keybindings = new SparkKeybindings({
      defaults: [
        {
          id: "app.toggleTools",
          defaultKey: "ctrl+o",
          description: "toggle tools",
          handler: () => {
            calls += 1;
          },
        },
      ],
      overrides: { "app.toggleTools": "ctrl+y" },
    });

    expect(keybindings.canExecuteKey("ctrl+y", {})).toBe(true);
    expect(keybindings.canExecuteKey("ctrl+o", {})).toBe(false);
    await expect(keybindings.executeKey("ctrl+y", {})).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("does not reserve a key whose only binding is inactive", () => {
    const keybindings = new SparkKeybindings({
      defaults: [
        {
          id: "app.toggleTools",
          defaultKey: "ctrl+y",
          description: "toggle tools",
          handler: () => undefined,
          isActive: () => false,
        },
      ],
    });

    expect(keybindings.canExecuteKey("ctrl+y", {})).toBe(false);
  });
});
