import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/*.md", "packages/spark-i18n/src/paraglide/**", "prek.toml", "_typos.toml"],
  },
  lint: {
    plugins: ["typescript"],
    rules: {
      "typescript/no-explicit-any": "error",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    // NOTE (Phase 1): Oxlint exposes cyclomatic `complexity` and `max-lines` (not
    // Sonar `cognitive-complexity`). Enabling them as warn across the repo floods
    // stdout and makes `vp check --fix` abort (Vite+ panic: EAGAIN on stdout).
    // Keep them off the default lint path; `pnpm run report:hygiene` enables
    // only those two rules through CLI overrides for an advisory hotspot scan.
    overrides: [
      {
        files: [
          "packages/**/*.ts",
          "apps/spark-cli/**/*.ts",
          "apps/spark-tui/**/*.ts",
          "test/**/*.ts",
        ],
        env: { node: true },
      },
      {
        files: ["**/*.test.ts", "**/*.spec.ts"],
        plugins: ["typescript", "vitest"],
        rules: {
          "vitest/expect-expect": "off",
          "vitest/hoisted-apis-on-top": "error",
          "vitest/no-conditional-expect": "off",
          "vitest/no-conditional-tests": "error",
          "vitest/no-disabled-tests": "error",
          "vitest/no-duplicate-hooks": "error",
          "vitest/no-focused-tests": "error",
          "vitest/prefer-snapshot-hint": "error",
          "vitest/require-awaited-expect-poll": "error",
          "vitest/require-local-test-context-for-concurrent-snapshots": "error",
          "vitest/require-mock-type-parameters": "off",
          "vitest/require-to-throw-message": "off",
          "vitest/valid-describe-callback": "error",
          "vitest/valid-expect": ["error", { maxArgs: 2 }],
          "vitest/valid-expect-in-promise": "error",
          "vitest/valid-title": "off",
          "vitest/warn-todo": "off",
        },
      },
    ],
  },
});
