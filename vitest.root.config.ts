import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Root integration suite under test/. The direct-memory protocol conformance is
 * the one explicit owner-test exception because it proves one normalized vector
 * across TUI, Hub, and channel surfaces.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "packages/spark-protocol/src/memory-approval.test.ts"],
    exclude: ["test/process/**/*.test.ts", "test/journey/**/*.test.ts"],
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 2,
    setupFiles: [resolve(import.meta.dirname, "test/support/hermetic-env.ts")],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
