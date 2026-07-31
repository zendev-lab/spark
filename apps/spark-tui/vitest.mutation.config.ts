import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(import.meta.dirname);
process.chdir(packageRoot);

export default defineConfig({
  root: packageRoot,
  test: {
    environment: "node",
    include: ["src/__tests__/spark-model-control-client.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
