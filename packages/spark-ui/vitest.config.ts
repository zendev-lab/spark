import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts"],
  },
});
