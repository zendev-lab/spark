import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const repositoryRoot = resolve(import.meta.dirname, "../..");
process.chdir(repositoryRoot);

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: "node",
    include: ["test/task-todo-store-atomic.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
