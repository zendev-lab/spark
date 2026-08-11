import { defineConfig } from "vitest/config";

const includeReproRecovery = process.env.SPARK_INCLUDE_REPRO_RECOVERY === "1";

/** Real-process source-distribution contracts. Keep separate from unit/integration tests. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/process/**/*.test.ts"],
    exclude: includeReproRecovery ? [] : ["test/process/repro-golden-journey-recovery.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
