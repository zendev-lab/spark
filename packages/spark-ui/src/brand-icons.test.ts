import { describe, expect, it } from "vitest";

import { brandIconForModelProvider, brandIconMap } from "./brand-icons";

describe("brand icons", () => {
  it.each([
    ["anthropic", "anthropic"],
    ["google-vertex", "google"],
    ["moonshotai-cn", "moonshot-ai"],
    ["qwen-token-plan-individual", "qwen"],
    ["xiaomi-token-plan-sgp", "xiaomi"],
  ] as const)("maps model provider %s to %s", (providerName, brandIcon) => {
    expect(brandIconForModelProvider(providerName)).toBe(brandIcon);
  });

  it("falls back when a provider has no curated brand artwork", () => {
    expect(brandIconMap.qq.slug).toBe("qq");
    expect(brandIconForModelProvider("openai")).toBeUndefined();
    expect(brandIconForModelProvider("custom-provider")).toBeUndefined();
  });
});
