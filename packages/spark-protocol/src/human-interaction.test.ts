import { describe, expect, it } from "vitest";

import {
  createAutonomousAskInteractionRequestId,
  matchesAutonomousAskInteractionRequestId,
} from "./human-interaction.ts";

describe("autonomous Ask interaction identity", () => {
  it("derives a stable protocol wire id from the evidence request hash", () => {
    const requestHash = `${"a".repeat(32)}${"b".repeat(32)}`;

    expect(createAutonomousAskInteractionRequestId(requestHash)).toBe(`ask_${"a".repeat(32)}`);
    expect(matchesAutonomousAskInteractionRequestId(`ask_${"a".repeat(32)}`, requestHash)).toBe(
      true,
    );
  });

  it("accepts the retired autonomous id only as a compatibility read", () => {
    const requestHash = "c".repeat(64);

    expect(matchesAutonomousAskInteractionRequestId(`ask_async:${requestHash}`, requestHash)).toBe(
      true,
    );
    expect(matchesAutonomousAskInteractionRequestId(`ask_${"d".repeat(32)}`, requestHash)).toBe(
      false,
    );
    expect(matchesAutonomousAskInteractionRequestId("ask_invalid", "not-a-hash")).toBe(false);
    expect(() => createAutonomousAskInteractionRequestId("not-a-hash")).toThrow(/SHA-256/u);
  });
});
