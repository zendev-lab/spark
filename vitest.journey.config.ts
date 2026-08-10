import { defineConfig } from "vitest/config";

/** Complete product journeys with explicit native runtime prerequisites. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/journey/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
