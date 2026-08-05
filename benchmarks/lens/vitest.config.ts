import codspeedPlugin from "@codspeed/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [codspeedPlugin()],
  resolve: {
    alias: {
      "@zendev-lab/spark-lens": new URL("../../packages/spark-lens/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "node",
    include: ["benchmarks/lens/**/*.bench.ts"],
    benchmark: {
      include: ["benchmarks/lens/**/*.bench.ts"],
    },
  },
});
