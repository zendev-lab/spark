import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: [resolve(import.meta.dirname, "src/test-support/hermetic-env.ts")],
  },
});
