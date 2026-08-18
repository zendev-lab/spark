import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkLane, parseBenchmarkLane } from "./select-benchmark-files.mts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSelectedBenchmarks(serialized: string, rawLane: string | undefined): string[] {
  const lane = parseBenchmarkLane(rawLane);

  const files: unknown = JSON.parse(serialized);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("SPARK_BENCHMARK_FILES must be a non-empty JSON array");
  }

  for (const file of files as unknown[]) {
    if (
      typeof file !== "string" ||
      !file.startsWith("benchmarks/") ||
      !file.endsWith(".bench.ts") ||
      file.split("/").includes("..") ||
      benchmarkLane(file) !== lane
    ) {
      throw new Error(`Invalid ${lane} benchmark path: ${String(file)}`);
    }
  }
  return files as string[];
}

function main(): void {
  const files = parseSelectedBenchmarks(
    process.env.SPARK_BENCHMARK_FILES ?? "",
    process.env.BENCHMARK_LANE,
  );
  const result = spawnSync(
    "pnpm",
    ["exec", "vp", "test", "bench", ...files, "--config", "benchmarks/vitest.config.ts", "--run"],
    { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
  );

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Benchmark process terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
