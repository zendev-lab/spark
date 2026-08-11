import axe from "axe-core";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { beforeAll, describe, expect, it } from "vitest";

import Catalog from "./Catalog.svelte";
import { catalogFixtures, catalogScenarioKey } from "./fixtures";

const darkTextScreenshotOptions = {
  comparatorName: "pixelmatch" as const,
  comparatorOptions: {
    // Chromium uses platform text rasterizers; dark antialiasing differs slightly by OS.
    allowedMismatchedPixelRatio: 0.06,
  },
};

beforeAll(async () => {
  await Promise.all([
    document.fonts.load('400 16px "Spark Catalog Inter"'),
    document.fonts.load('400 16px "Spark Catalog Geist Mono"'),
  ]);
});
const conversationFixtures = catalogFixtures.filter((fixture) => fixture.group === "conversation");
const workbenchFixtures = catalogFixtures.filter((fixture) => fixture.group === "workbench");
// Keep these below the Vitest runner frame so locator screenshots stay at a 1:1 scale.
const desktopViewport = { width: 1024, height: 560 } as const;
const mobileViewport = { width: 420, height: 560 } as const;

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

  it("keeps the light desktop conversation catalog visually stable", async () => {
    await page.viewport(desktopViewport.width, desktopViewport.height);
    const screen = await render(Catalog, {
      theme: "light",
      direction: "ltr",
      fixtures: conversationFixtures,
    });

    await expect(page.getByTestId("catalog-message-shell-success")).toMatchScreenshot(
      "catalog-message-shell-light-desktop",
    );
    await expect(page.getByTestId("catalog-composer-empty")).toMatchScreenshot(
      "catalog-composer-light-desktop",
    );
    await expect(page.getByTestId("catalog-attachments-success")).toMatchScreenshot(
      "catalog-attachments-light-desktop",
    );
    await expect(page.getByTestId("catalog-message-controls-disabled")).toMatchScreenshot(
      "catalog-message-controls-disabled-light-desktop",
    );
    await expect(page.getByTestId("catalog-model-selector-success")).toMatchScreenshot(
      "catalog-model-selector-light-desktop",
    );

    await screen.unmount();
  });

  it("keeps the light desktop workbench catalog visually stable", async () => {
    await page.viewport(desktopViewport.width, desktopViewport.height);
    const screen = await render(Catalog, {
      theme: "light",
      direction: "ltr",
      fixtures: workbenchFixtures,
    });

    await expect(page.getByTestId("catalog-tool-call-success")).toMatchScreenshot(
      "catalog-tool-call-light-desktop",
    );
    await expect(page.getByTestId("catalog-code-block-success")).toMatchScreenshot(
      "catalog-code-block-light-desktop",
    );
    await expect(page.getByTestId("catalog-diff-view-success")).toMatchScreenshot(
      "catalog-diff-view-light-desktop",
    );
    await expect(page.getByTestId("catalog-terminal-success")).toMatchScreenshot(
      "catalog-terminal-light-desktop",
    );

    await screen.unmount();
  });

  it("keeps the dark RTL mobile conversation catalog visually stable", async () => {
    await page.viewport(mobileViewport.width, mobileViewport.height);
    const screen = await render(Catalog, {
      theme: "dark",
      direction: "rtl",
      compact: true,
      fixtures: conversationFixtures,
    });

    await expect(page.getByTestId("catalog-message-shell-overflow")).toMatchScreenshot(
      "catalog-message-shell-dark-rtl-mobile",
      darkTextScreenshotOptions,
    );

    await screen.unmount();
  });

  it("keeps the dark RTL mobile workbench catalog visually stable", async () => {
    await page.viewport(mobileViewport.width, mobileViewport.height);
    const screen = await render(Catalog, {
      theme: "dark",
      direction: "rtl",
      compact: true,
      fixtures: workbenchFixtures,
    });

    await expect(page.getByTestId("catalog-tool-call-overflow")).toMatchScreenshot(
      "catalog-tool-call-dark-rtl-mobile",
    );

    await screen.unmount();
  });
});
