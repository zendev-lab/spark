import { describe, expect, it } from "vitest";
import { sanitizeHubReturnPath } from "./navigation";

describe("Hub return paths", () => {
  it("keeps canonical same-origin destinations", () => {
    expect(sanitizeHubReturnPath("/settings?tab=models#active", "https://hub.test")).toBe(
      "/settings?tab=models#active",
    );
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/%5Cevil.example/",
    "/%5cevil.example/",
    "/settings\nLocation: https://evil.example/",
  ])("rejects non-local or ambiguous destination %s", (value) => {
    expect(sanitizeHubReturnPath(value, "https://hub.test")).toBe("/");
  });
});
