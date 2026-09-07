import "@zendev-lab/spark-ui/tokens.css";
import type { ComponentProps } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { getDictionary } from "$lib/i18n";
import SettingsPage from "./+page.svelte";

const { webRpc } = vi.hoisted(() => ({ webRpc: vi.fn() }));
vi.mock("$lib/web-rpc", () => ({ webRpc }));

function settingsData(): ComponentProps<typeof SettingsPage>["data"] {
  return {
    locale: "zh-CN",
    navigation: { workspaces: [], sessions: [], unavailable: false },
    messages: getDictionary("zh-CN"),
    catalog: {
      providers: [
        {
          providerName: "kimi-coding",
          label: "Kimi For Coding",
          auth: { providerName: "kimi-coding", kind: "api_key", configured: false },
          models: [],
        },
        {
          providerName: "openai-codex",
          label: "OpenAI Codex",
          auth: { providerName: "openai-codex", kind: "oauth", configured: true },
          models: [],
        },
        {
          providerName: "github-copilot",
          label: "GitHub Copilot",
          auth: { providerName: "github-copilot", kind: "oauth", configured: false },
          models: [],
        },
      ],
      diagnostics: [],
      enabledModels: [],
    },
    daemon: {
      servers: [],
      invocationHealth: {},
      lifecycle: { state: "running" },
      invocations: { running: 0, queued: 0, failed: 0, succeeded: 0, cancelled: 0 },
      observedAt: "2026-09-06T00:00:00Z",
    },
  };
}

describe("provider settings layout", () => {
  it.each([1280, 860, 390])(
    "keeps authentication actions aligned and unstretched at %ipx",
    async (width) => {
      await page.viewport(width, 844);
      const screen = await render(SettingsPage, { data: settingsData() });
      try {
        const rows = [...screen.container.querySelectorAll<HTMLElement>(".provider-row")];
        const buttons = [
          ...screen.container.querySelectorAll<HTMLElement>(".provider-actions .ui-button"),
        ];
        const heights = buttons.map((button) => button.getBoundingClientRect().height);
        expect(buttons).toHaveLength(4);
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
        expect(Math.max(...heights)).toBeLessThanOrEqual(48);
        expect(new Set(buttons.map((button) => getComputedStyle(button).borderRadius)).size).toBe(
          1,
        );
        for (const row of rows) {
          const bounds = row.getBoundingClientRect();
          const controls = row
            .querySelector<HTMLElement>(".provider-controls")!
            .getBoundingClientRect();
          expect(controls.left).toBeGreaterThanOrEqual(bounds.left);
          expect(controls.right).toBeLessThanOrEqual(bounds.right + 1);
          expect(bounds.right).toBeLessThanOrEqual(width);
        }
      } finally {
        await screen.unmount();
        await page.viewport(1280, 720);
      }
    },
  );

  it("submits the key from its associated action and keeps OAuth navigation", async () => {
    const data = settingsData();
    webRpc.mockResolvedValue(data.catalog);
    const screen = await render(SettingsPage, { data });
    await screen.getByLabelText("API 密钥", { exact: true }).fill("test-key");
    await screen.getByRole("button", { name: "保存密钥", exact: true }).click();
    expect(webRpc).toHaveBeenCalledWith("provider.auth.api-key.set", {
      providerName: "kimi-coding",
      apiKey: "test-key",
    });
    const links = [...screen.container.querySelectorAll<HTMLAnchorElement>(".provider-actions a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/oauth/openai-codex",
      "/settings/oauth/github-copilot",
    ]);
    await screen.unmount();
  });
});
