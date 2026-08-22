import { sveltekit } from "@sveltejs/kit/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, type ViteUserConfig } from "vitest/config";

const config = {
  plugins: [sveltekit()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["@zendev-lab/spark-ui > bits-ui > svelte-toolbelt > style-to-object"],
  },
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@zendev-lab/spark-ui", "@lucide/svelte", "bits-ui", "svelte-streamdown"],
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
