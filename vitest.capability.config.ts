import { defineConfig } from "vitest/config";

export const capabilitySentinelTestFiles = Object.freeze([
  "apps/spark-daemon/src/spark-tools-capability-sentinel.test.ts",
  "apps/spark-daemon/src/repro-owner.test.ts",
  "apps/spark-daemon/src/store/loop-cycle-review.test.ts",
  "apps/spark-daemon/src/spark/loop-goal-settlements.test.ts",
]);

export function capabilitySentinelCommand(vitestOptions: readonly string[] = []): string[] {
  return ["exec", "vp", "test", "run", "--config", "vitest.capability.config.ts", ...vitestOptions];
}

export default defineConfig({
  test: {
    environment: "node",
    env: { SPARK_CAPABILITY_SENTINEL: "1" },
    include: [...capabilitySentinelTestFiles],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
