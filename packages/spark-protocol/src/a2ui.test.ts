import { describe, expect, it } from "vitest";

import { normalizeSparkA2uiDocument } from "./a2ui.ts";

describe("A2UI v0.9.1 protocol", () => {
  it("normalizes official surface messages and applies JSON pointer updates", () => {
    const document = normalizeSparkA2uiDocument(
      JSON.stringify({
        messages: [
          {
            version: "v0.9.1",
            createSurface: {
              surfaceId: "workbench",
              catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
            },
          },
          {
            version: "v0.9.1",
            updateComponents: {
              surfaceId: "workbench",
              components: [{ id: "root", component: "Text", text: { path: "/title" } }],
            },
          },
          {
            version: "v0.9.1",
            updateDataModel: {
              surfaceId: "workbench",
              path: "/",
              value: { title: "Repro" },
            },
          },
        ],
      }),
    );

    expect(document.diagnostics).toEqual([]);
    expect(document.latestSurfaceId).toBe("workbench");
    expect(document.surfaces[0]).toMatchObject({
      surfaceId: "workbench",
      dataModel: { title: "Repro" },
      components: { root: { id: "root", component: "Text" } },
    });
  });

  it("fails closed for unknown catalogs and prototype-polluting paths", () => {
    const document = normalizeSparkA2uiDocument(
      [
        JSON.stringify({
          version: "v0.9.1",
          createSurface: {
            surfaceId: "bad",
            catalogId:
              "https://evil.example/a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
          },
        }),
        JSON.stringify({
          version: "v0.9.1",
          updateDataModel: { surfaceId: "bad", path: "/__proto__/polluted", value: true },
        }),
      ].join("\n"),
    );

    expect(document.surfaces).toEqual([]);
    expect(document.diagnostics).toEqual([
      "surface bad: unsupported catalog https://evil.example/a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
      "message 2: unknown surface bad",
    ]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("caps components across the complete surface rather than each update", () => {
    const components = (prefix: string) =>
      Array.from({ length: 300 }, (_, index) => ({
        id: `${prefix}-${index}`,
        component: "Text",
        text: `${prefix} ${index}`,
      }));
    const document = normalizeSparkA2uiDocument(
      JSON.stringify({
        messages: [
          {
            version: "v0.9.1",
            createSurface: {
              surfaceId: "bounded",
              catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
            },
          },
          {
            version: "v0.9.1",
            updateComponents: { surfaceId: "bounded", components: components("first") },
          },
          {
            version: "v0.9.1",
            updateComponents: { surfaceId: "bounded", components: components("second") },
          },
        ],
      }),
    );

    expect(Object.keys(document.surfaces[0]!.components)).toHaveLength(500);
    expect(document.diagnostics).toEqual(["surface bounded: total component count capped at 500"]);
  });
});
