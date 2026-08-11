import { describe, expect, it } from "vitest";

import { catalogFixtures, catalogScenarioKey } from "./fixtures";

describe("catalog fixture contract", () => {
  it("uses unique fixture and scenario identities", () => {
    const fixtureIds = catalogFixtures.map((fixture) => fixture.id);
    const scenarioKeys = catalogFixtures.flatMap((fixture) =>
      fixture.scenarios.map((scenario) => catalogScenarioKey(fixture, scenario)),
    );

    expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    expect(new Set(scenarioKeys).size).toBe(scenarioKeys.length);
  });

  it("declares at least one concrete scenario per component", () => {
    for (const fixture of catalogFixtures) {
      expect(fixture.scenarios.length, fixture.id).toBeGreaterThan(0);
      for (const scenario of fixture.scenarios) {
        expect(scenario.id, `${fixture.id} scenario id`).not.toBe("");
        expect(scenario.title, `${fixture.id}:${scenario.id} title`).not.toBe("");
      }
    }
  });
});
