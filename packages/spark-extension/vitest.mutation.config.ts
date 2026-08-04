import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packageRoot = resolve(import.meta.dirname);
process.chdir(packageRoot);

export default defineConfig({
  root: packageRoot,
  test: {
    environment: "node",
    include: [
      "src/extension/spark-finish-task-tool-registration.test.ts",
      "src/extension/spark-release-task-claim-tool-registration.test.ts",
      "src/extension/spark-todo-tool-registration.test.ts",
      "src/extension/task-tool-contract.test.ts",
    ],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
