import { describe, expect, test } from "vitest";

import {
  DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE,
  resolveSparkHeadlessExecutorSpecifier,
} from "./headless-module.ts";

describe("headless executor module resolution", () => {
  test("keeps the product headless executor as the default", () => {
    expect(DEFAULT_SPARK_HEADLESS_EXECUTOR_MODULE).toBe(
      "@zendev-lab/spark-daemon/headless-role-executor",
    );
  });

  test("dereferences an installed workspace package to a file URL", () => {
    expect(
      resolveSparkHeadlessExecutorSpecifier("@zendev-lab/spark-system/headless-module"),
    ).toMatch(/^file:/);
  });

  test.each(["/tmp/spark-headless-executor.mjs", "file:///tmp/spark-headless-executor.mjs"])(
    "preserves an explicit filesystem specifier: %s",
    (specifier) => {
      expect(resolveSparkHeadlessExecutorSpecifier(specifier)).toBe(specifier);
    },
  );

  test("preserves an unresolved package specifier for the caller's importer", () => {
    const specifier = "@zendev-lab/does-not-exist/headless-executor";
    expect(resolveSparkHeadlessExecutorSpecifier(specifier)).toBe(specifier);
  });
});
