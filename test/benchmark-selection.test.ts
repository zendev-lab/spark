import { describe, expect, it } from "vitest";

import {
  benchmarkLane,
  requiresFullBenchmarkRun,
  selectBenchmarkLane,
} from "../scripts/select-benchmark-files.mts";
import { parseSelectedBenchmarks } from "../scripts/run-selected-benchmarks.mts";

describe("CodSpeed benchmark selection", () => {
  it("routes file I/O benchmarks to walltime and CPU benchmarks to simulation", () => {
    expect(benchmarkLane("benchmarks/daemon/orpc-capacity.walltime.bench.ts")).toBe("walltime");
    expect(benchmarkLane("benchmarks/session/hot-paths.walltime.bench.ts")).toBe("walltime");
    expect(benchmarkLane("benchmarks/lens/hot-paths.bench.ts")).toBe("simulation");
    expect(
      selectBenchmarkLane(
        ["benchmarks/session/hot-paths.walltime.bench.ts", "benchmarks/lens/hot-paths.bench.ts"],
        "walltime",
      ),
    ).toEqual(["benchmarks/session/hot-paths.walltime.bench.ts"]);
  });

  it("uses a full run for benchmark harness and workspace dependency changes", () => {
    expect(requiresFullBenchmarkRun(["pnpm-lock.yaml"])).toBe(true);
    expect(requiresFullBenchmarkRun(["packages/spark-session/package.json"])).toBe(true);
    expect(requiresFullBenchmarkRun(["packages/spark-session/tsconfig.json"])).toBe(true);
    expect(requiresFullBenchmarkRun([".github/actionlint.yaml"])).toBe(true);
    expect(requiresFullBenchmarkRun(["scripts/select-benchmark-files.mts"])).toBe(true);
    expect(requiresFullBenchmarkRun(["packages/spark-session/src/index.ts"])).toBe(false);
    expect(requiresFullBenchmarkRun(["apps/spark-docs/src/content/docs/index.mdx"])).toBe(false);
  });

  it("rejects empty, escaping, and cross-lane benchmark selections", () => {
    expect(() => parseSelectedBenchmarks("[]", "simulation")).toThrow(/non-empty/u);
    expect(() =>
      parseSelectedBenchmarks('["benchmarks/../package.json.bench.ts"]', "simulation"),
    ).toThrow(/Invalid/u);
    expect(() =>
      parseSelectedBenchmarks('["benchmarks/session/hot-paths.walltime.bench.ts"]', "simulation"),
    ).toThrow(/Invalid/u);
  });
});
