import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import Catalog from "./Catalog.svelte";
import { catalogFixtures, catalogScenarioKey } from "./fixtures";

describe("Catalog SSR", () => {
  it("renders every declared component state as a concrete scenario", () => {
    const { body } = render(Catalog, { props: { fixtures: catalogFixtures } });

    for (const fixture of catalogFixtures) {
      for (const scenario of fixture.scenarios) {
        expect(body).toContain(`data-catalog-scenario="${catalogScenarioKey(fixture, scenario)}"`);
        expect(body).toContain(`data-preview="${catalogScenarioKey(fixture, scenario)}"`);
        expect(body).toContain(`data-catalog-rendered="${catalogScenarioKey(fixture, scenario)}"`);
      }
    }
  });
});
