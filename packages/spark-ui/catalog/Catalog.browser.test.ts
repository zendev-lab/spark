import axe from "axe-core";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { beforeAll, describe, expect, it } from "vitest";

import Catalog from "./Catalog.svelte";
import { catalogFixtures, catalogScenarioKey } from "./fixtures";

beforeAll(async () => {
  await document.fonts.load('400 16px "Spark Catalog Inter"');
});

describe("Spark UI component catalog", () => {
  it("has no automatically detectable WCAG A or AA violations", async () => {
    const screen = await render(Catalog, { theme: "light", direction: "ltr" });
    for (const fixture of catalogFixtures) {
      for (const scenario of fixture.scenarios) {
        await expect
          .element(page.getByTestId(`catalog-${fixture.id}-${scenario.id}`), {
            message: catalogScenarioKey(fixture, scenario),
          })
          .toBeVisible();
      }
    }
    const results = await axe.run(screen.container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
    });

    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      })),
    ).toEqual([]);

    await screen.unmount();
  });

  it("keeps the light desktop catalog visually stable", async () => {
    await page.viewport(1440, 2000);
    const screen = await render(Catalog, {
      theme: "light",
      direction: "ltr",
      wide: true,
    });

    await expect(page.getByTestId("catalog-message-shell-success")).toMatchScreenshot(
      "catalog-message-shell-light-desktop",
    );
    await expect(page.getByTestId("catalog-composer-empty")).toMatchScreenshot(
      "catalog-composer-light-desktop",
    );
    await expect(page.getByTestId("catalog-tool-call-success")).toMatchScreenshot(
      "catalog-tool-call-light-desktop",
    );

    await screen.unmount();
  });

  it("keeps the dark RTL mobile catalog visually stable", async () => {
    await page.viewport(420, 900);
    const screen = await render(Catalog, {
      theme: "dark",
      direction: "rtl",
      compact: true,
    });

    await expect(page.getByTestId("catalog-message-shell-overflow")).toMatchScreenshot(
      "catalog-message-shell-dark-rtl-mobile",
    );

    await screen.unmount();
  });
});
