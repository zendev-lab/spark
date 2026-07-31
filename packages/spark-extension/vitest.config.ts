import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(import.meta.dirname, "../..");
process.chdir(repositoryRoot);

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: "node",
    include: ["packages/spark-extension/src/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
