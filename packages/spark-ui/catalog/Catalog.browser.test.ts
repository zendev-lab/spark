import axe from "axe-core";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";

import Catalog from "./Catalog.svelte";

describe("Spark UI component catalog", () => {
  it("has no automatically detectable WCAG A or AA violations", async () => {
    const screen = await render(Catalog, { theme: "light", direction: "ltr" });
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
    const screen = await render(Catalog, {
      theme: "light",
      direction: "ltr",
      wide: true,
    });

    await expect(page.getByTestId("catalog-gallery")).toMatchScreenshot("catalog-light-desktop");

    await screen.unmount();
  });

  it("keeps the dark RTL mobile catalog visually stable", async () => {
    await page.viewport(420, 900);
    const screen = await render(Catalog, {
      theme: "dark",
      direction: "rtl",
      compact: true,
    });

    await expect(page.getByTestId("catalog-message-shell")).toMatchScreenshot(
      "catalog-dark-rtl-mobile",
    );

    await screen.unmount();
  });
});
