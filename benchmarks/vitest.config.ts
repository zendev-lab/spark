import codspeedPlugin from "@codspeed/vitest-plugin";
import { defineConfig } from "vitest/config";

const benchmarkFiles = ["benchmarks/**/*.bench.ts"];

export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    environment: "node",
    include: [],
    testTimeout: 60_000,
    benchmark: {
      include: benchmarkFiles,
    },
  },
});
