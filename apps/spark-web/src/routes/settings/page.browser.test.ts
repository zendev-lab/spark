import { render } from "vitest-browser-svelte";
import { expect, test, vi } from "vitest";
import type { ComponentProps } from "svelte";
const mocks = vi.hoisted(() => ({ webRpc: vi.fn() }));
vi.mock("$lib/web-rpc", () => ({ webRpc: mocks.webRpc }));
import { getDictionary } from "$lib/i18n";
import Settings from "./+page.svelte";

const model = {
  providerName: "baidu-oneapi",
  modelId: "gpt-6-astra-尝鲜",
  modelLabel: "GPT-6 Astra",
};
const catalog = {
  providers: [
    {
      providerName: "baidu-oneapi",
      label: "Baidu OneAPI",
      auth: { providerName: "baidu-oneapi", kind: "api_key", configured: true },
      models: [{ model, reasoning: true, input: ["text"], available: true }],
    },
  ],
  enabledModels: [model],
  enabledModelPatterns: ["baidu-oneapi/gpt-*"],
  diagnostics: [],
};

test("settings retain editable wildcard rules and save exact model selections only explicitly", async () => {
  mocks.webRpc.mockImplementation(async (_method, input) => ({
    ...catalog,
    enabledModelPatterns:
      input.patterns ??
      input.models.map((item: typeof model) => `${item.providerName}/${item.modelId}`),
  }));
  const data = {
    locale: "en",
    messages: getDictionary("en"),
    catalog,
    daemon: { lifecycle: { state: "running" }, invocations: { running: 0, queued: 0, failed: 0 } },
  } as unknown as ComponentProps<typeof Settings>["data"];
  const screen = await render(Settings, { data });
  const rules = screen.getByRole("textbox", { name: "Model selection rules" });
  await expect.element(rules).toHaveValue("baidu-oneapi/gpt-*");
  expect(mocks.webRpc).not.toHaveBeenCalled();
  await rules.fill("baidu-oneapi/gpt-6-*\nopenai-codex/gpt-*");
  await screen.getByRole("button", { name: "Save rules", exact: true }).click();
  expect(mocks.webRpc).toHaveBeenCalledWith("model.enabled.set", {
    models: [],
    patterns: ["baidu-oneapi/gpt-6-*", "openai-codex/gpt-*"],
    intent: { kind: "user-initiated", via: "settings-ui" },
  });
  await screen.getByRole("button", { name: "Save enabled models", exact: true }).click();
  await expect.element(rules).toHaveValue("baidu-oneapi/gpt-6-astra-尝鲜");
});
