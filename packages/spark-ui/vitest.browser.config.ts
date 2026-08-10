import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const config = {
  plugins: [svelte()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["bits-ui > svelte-toolbelt > style-to-object"],
  },
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
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
