import { describe, expect, it } from "vitest";
import {
  renderInfoflowMessageContextPrompt,
  resolveInfoflowCustomSystemPrompt,
} from "./infoflow-prompts.ts";
import type { InfoflowAdapterConfig } from "./types.ts";

const base: InfoflowAdapterConfig = { type: "infoflow" };

describe("infoflow prompts", () => {
  it("treats blank custom system_prompt as absent", () => {
    expect(resolveInfoflowCustomSystemPrompt(base)).toBeUndefined();
    expect(resolveInfoflowCustomSystemPrompt({ ...base, system_prompt: "  " })).toBeUndefined();
    expect(resolveInfoflowCustomSystemPrompt({ ...base, system_prompt: " 如流助手 " })).toBe(
      "如流助手",
    );
  });

  it("omits an empty per-message context", () => {
    expect(
      renderInfoflowMessageContextPrompt({ externalKey: "infoflow:user:anonymous" }),
    ).toBeUndefined();
  });
});
