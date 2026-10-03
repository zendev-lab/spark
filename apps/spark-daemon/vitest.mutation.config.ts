import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(import.meta.dirname);
process.chdir(packageRoot);

export default defineConfig({
  root: packageRoot,
  test: {
    environment: "node",
    include: [
      "src/product/policy/spark-finish-task-tool-registration.test.ts",
      "src/product/policy/spark-release-task-claim-tool-registration.test.ts",
      "src/product/policy/spark-todo-tool-registration.test.ts",
      "src/product/policy/task-tool-contract.test.ts",
      "src/product/policy/task-tool-contracts.test.ts",
    ],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
