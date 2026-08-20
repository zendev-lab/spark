import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  optimizeDeps: {
    exclude: ["@lucide/svelte", "bits-ui", "svelte-streamdown"],
    include: ["@zendev-lab/spark-ui > bits-ui > svelte-toolbelt > style-to-object"],
  },
  resolve: {
    dedupe: ["svelte"],
  },
  ssr: {
    noExternal: ["@zendev-lab/spark-ui", "@lucide/svelte", "bits-ui", "svelte-streamdown"],
  },
});
