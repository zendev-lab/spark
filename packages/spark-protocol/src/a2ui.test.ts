import { describe, expect, it } from "vitest";

import { normalizeSparkA2uiDocument, sparkWorkbenchActionRequestSchema } from "./a2ui.ts";

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
    expect(document.diagnostics.join("\n")).toContain("unsupported catalog");
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
    expect(document.diagnostics.join("\n")).toContain("total component count capped at 500");
  });

  it("accepts only the closed Workbench action set and requires stop confirmation", () => {
    const base = {
      version: "v0.9.1",
      action: {
        name: "spark.loop.control",
        surfaceId: "workbench",
        sourceComponentId: "pause",
        timestamp: "2026-08-04T00:00:00.000Z",
        context: {
          actionId: "pause",
          artifactRef: "artifact:workbench",
          revision: 2,
          loopId: "loop-1",
          generation: 4,
          idempotencyKey: "action-1",
        },
      },
    };
    expect(sparkWorkbenchActionRequestSchema.parse(base).action.context.actionId).toBe("pause");
    expect(() =>
      sparkWorkbenchActionRequestSchema.parse({
        ...base,
        action: { ...base.action, context: { ...base.action.context, actionId: "stop" } },
      }),
    ).toThrow("stop requires explicit confirmation");
    expect(() =>
      sparkWorkbenchActionRequestSchema.parse({
        ...base,
        action: { ...base.action, context: { ...base.action.context, actionId: "complete" } },
      }),
    ).toThrow();
  });
});
