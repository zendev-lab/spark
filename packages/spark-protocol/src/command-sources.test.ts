import { describe, expect, it } from "vitest";
import {
  isSparkCommandPayloadSource,
  sparkAgentsHubSource,
  sparkCommandPayloadSourceOptions,
} from "./command-sources.ts";

describe("Spark command payload sources", () => {
  it("keeps the historical agents source value behind the Hub-named API", () => {
    expect(sparkAgentsHubSource).toBe("agents-cockpit");
    expect(sparkCommandPayloadSourceOptions).toEqual(["agents-cockpit"]);
    expect(isSparkCommandPayloadSource("agents-cockpit")).toBe(true);
    expect(isSparkCommandPayloadSource("agents-hub")).toBe(false);
    expect(isSparkCommandPayloadSource("project-chat")).toBe(false);
  });
});
