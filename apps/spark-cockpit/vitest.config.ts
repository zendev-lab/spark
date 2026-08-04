import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

/**
 * Node unit/integration tests stay the default fast path.
 * Browser interaction tests run separately through `pnpm run test:browser:cockpit`.
 */
export default defineConfig({
  plugins: [sveltekit()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@zendev-lab/spark-ui", "@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.browser.test.ts"],
  },
});
