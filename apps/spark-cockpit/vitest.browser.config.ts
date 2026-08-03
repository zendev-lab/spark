import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Browser project for Cockpit interaction and DOM behavior.
 * Requires: `pnpm exec playwright install chromium`
 * Run from the repository root: `pnpm run test:browser:cockpit`
 */
const plugins = await sveltekit();

const config = {
  plugins,
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["bits-ui > svelte-toolbelt > style-to-object"],
  },
  resolve: {
    conditions: ["browser"],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.ts"],
    setupFiles: ["vitest-browser-svelte"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
} as unknown as ViteUserConfig;

export default defineConfig(config);
