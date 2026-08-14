import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReproWorkbench from "./ReproWorkbench.svelte";

const binding = {
  artifactRef: "artifact:workbench-current",
  revision: 7,
  lifecycle: "live" as const,
  loopId: "loop:repro",
  generation: 3,
};

const labels = {
  aria: "Repro Workbench",
  loading: "Loading Workbench",
  syncing: "Workbench is syncing",
  pendingTitle: "Workbench unavailable",
  pendingBody: "No current projection",
  unavailable: "Current projection unavailable",
  retry: "Retry",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Repro Workbench projection fence", () => {
  it("rejects a stale artifact projection instead of rendering its lane content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ready",
          artifactId: "artifact:stale",
          binding: { ...binding, revision: binding.revision - 1 },
          content: staleLaneContent(),
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const screen = await render(ReproWorkbench, {
      sessionId: "session:repro",
      binding,
      canControl: false,
      labels,
    });

    await expect.element(screen.getByRole("status")).toHaveTextContent(labels.unavailable);
    expect(screen.container.textContent).not.toContain("stale-lane-item");
  });
});

function staleLaneContent(): string {
  return JSON.stringify({
    messages: [
      {
        version: "v0.9.1",
        createSurface: {
          surfaceId: "spark-repro-stale",
          catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
        },
      },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "spark-repro-stale",
          components: [{ id: "root", component: "Text", text: "stale-lane-item" }],
        },
      },
    ],
  });
}
