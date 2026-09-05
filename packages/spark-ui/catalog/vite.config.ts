import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const catalogRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: catalogRoot,
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
    dedupe: ["svelte"],
  },
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["bits-ui > svelte-toolbelt > style-to-object"],
  },
  build: {
    outDir: path.resolve(catalogRoot, "../node_modules/.cache/spark-ui-catalog"),
    emptyOutDir: true,
  },
});
