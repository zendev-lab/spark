import { describe, expect, it } from "vitest";
import {
  isSparkCommandPayloadSource,
  sparkAgentsHubSource,
  sparkCommandPayloadSourceOptions,
} from "./command-sources.ts";

describe("Spark command payload sources", () => {
  it("uses the Hub-named wire value and rejects the retired Cockpit source", () => {
    expect(sparkAgentsHubSource).toBe("agents-hub");
    expect(sparkCommandPayloadSourceOptions).toEqual(["agents-hub"]);
    expect(isSparkCommandPayloadSource("agents-hub")).toBe(true);
    expect(isSparkCommandPayloadSource("agents-cockpit")).toBe(false);
    expect(isSparkCommandPayloadSource("project-chat")).toBe(false);
  });
});
