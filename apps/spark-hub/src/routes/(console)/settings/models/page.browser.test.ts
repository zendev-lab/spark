import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";

import Page from "./+page.svelte";
import type { PageData } from "./$types";

const model = { providerName: "openai", modelId: "gpt-5", modelLabel: "GPT-5" };

function pageData(enabledModels?: (typeof model)[]): PageData {
  return {
    locale: "en",
    messages: getHubDictionary("en"),
    activeWorkspace: {
      id: "ws_demo",
      slug: "demo",
      name: "Demo",
      localPath: null,
    },
    workspaces: [],
    daemons: [],
    sessions: [],
    sessionsAvailable: true,
    isGlobalConsole: false,
    hasControlPlaneAccess: true,
    control: {
      available: true,
      snapshot: {
        providers: [
          {
            providerName: "openai",
            label: "OpenAI",
            auth: { providerName: "openai", kind: "none" as const, configured: true },
            models: [
              {
                model,
                reasoning: true,
                input: ["text" as const],
                available: true,
              },
            ],
          },
        ],
        diagnostics: [],
        ...(enabledModels === undefined ? {} : { enabledModels }),
      },
    },
    flow: null,
    flowError: null,
    workspaceId: "ws_demo",
    workspaceSlug: "demo",
  };
}

describe("model settings scope rendering", () => {
  it("fails closed when a browser projection omits enabledModels", async () => {
    const messages = getHubDictionary("en");
    const screen = await render(Page, { data: pageData(), form: null });

    await expect.element(screen.getByText(messages.modelSettings.noAvailableModels)).toBeVisible();
    expect(screen.container.querySelector('form[action="?/setDefaultModel"]')).toBeNull();
    await screen.unmount();
  });

  it("renders only a model admitted by enabledModels", async () => {
    const screen = await render(Page, { data: pageData([model]), form: null });

    expect(screen.container.querySelector('form[action="?/setDefaultModel"]')).not.toBeNull();
    await expect.element(screen.getByText("GPT-5")).toBeVisible();
    await screen.unmount();
  });
});
