import { describe, expect, it } from "vitest";
import { resolveRenamedEnvironmentVariable } from "./environment.js";

const names = { canonical: "SPARK_HUB_PUBLIC_URL", legacy: "SPARK_COCKPIT_PUBLIC_URL" };

describe("renamed environment variables", () => {
  it("prefers the canonical value and accepts a matching legacy alias", () => {
    expect(
      resolveRenamedEnvironmentVariable({ SPARK_HUB_PUBLIC_URL: " https://hub.test " }, names),
    ).toBe("https://hub.test");
    expect(
      resolveRenamedEnvironmentVariable(
        {
          SPARK_HUB_PUBLIC_URL: "https://hub.test",
          SPARK_COCKPIT_PUBLIC_URL: "https://hub.test",
        },
        names,
      ),
    ).toBe("https://hub.test");
  });

  it("reads the retired alias when the canonical variable is absent", () => {
    expect(
      resolveRenamedEnvironmentVariable({ SPARK_COCKPIT_PUBLIC_URL: "https://legacy.test" }, names),
    ).toBe("https://legacy.test");
  });

  it("fails closed when both names specify different values", () => {
    expect(() =>
      resolveRenamedEnvironmentVariable(
        {
          SPARK_HUB_PUBLIC_URL: "https://hub.test",
          SPARK_COCKPIT_PUBLIC_URL: "https://legacy.test",
        },
        names,
      ),
    ).toThrow(/conflicts with retired SPARK_COCKPIT_PUBLIC_URL/u);
  });
});
