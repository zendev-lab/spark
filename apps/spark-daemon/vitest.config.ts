import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: [resolve(import.meta.dirname, "src/test-support/hermetic-env.ts")],
  },
});
