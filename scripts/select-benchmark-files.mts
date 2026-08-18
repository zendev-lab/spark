import { execFile as execFileCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createVitest } from "vitest/node";

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkConfig = path.join(repositoryRoot, "benchmarks/vitest.config.ts");

export const WALLTIME_BENCHMARK_SUFFIX = ".walltime.bench.ts";
export type BenchmarkLane = "simulation" | "walltime";

const fullRunPaths = new Set<string>([
  ".github/actionlint.yaml",
  ".github/workflows/ci-benchmarks.yml",
  ".node-version",
  "benchmarks/vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/run-selected-benchmarks.mts",
  "scripts/select-benchmark-files.mts",
]);

function normalizeRepositoryPath(file: string): string {
  return file.replaceAll(path.sep, "/").replace(/^\.\//u, "");
}

export function parseBenchmarkLane(lane: string | undefined): BenchmarkLane {
  if (lane !== "simulation" && lane !== "walltime") {
    throw new Error(`Unsupported benchmark lane: ${lane}`);
  }
  return lane;
}

export function benchmarkLane(file: string): BenchmarkLane {
  return normalizeRepositoryPath(file).endsWith(WALLTIME_BENCHMARK_SUFFIX)
    ? "walltime"
    : "simulation";
}

export function selectBenchmarkLane(files: string[], lane: BenchmarkLane): string[] {
  return files
    .map(normalizeRepositoryPath)
    .filter((file) => benchmarkLane(file) === lane)
    .sort();
}

export function requiresFullBenchmarkRun(changedFiles: string[]): boolean {
  return changedFiles.some((file) => {
    const normalized = normalizeRepositoryPath(file);
    return (
      fullRunPaths.has(normalized) ||
      normalized.endsWith("/package.json") ||
      /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/u.test(normalized)
    );
  });
}

async function changedFilesSince(baseSha: string): Promise<string[]> {
  const { stdout } = await execFile(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${baseSha}...HEAD`],
    { cwd: repositoryRoot },
  );
  return stdout.split("\n").filter(Boolean).map(normalizeRepositoryPath);
}

function specificationFiles(specifications: Array<{ moduleId: string }>): string[] {
  return specifications.map((specification) => {
    const relative = normalizeRepositoryPath(path.relative(repositoryRoot, specification.moduleId));
    if (relative.startsWith("../") || path.isAbsolute(relative)) {
      throw new Error(`Benchmark resolved outside the repository: ${specification.moduleId}`);
    }
    return relative;
  });
}

async function discoverBenchmarks({
  all,
  baseSha,
}: {
  all: boolean;
  baseSha: string | undefined;
}): Promise<string[]> {
  const vitest = await createVitest("benchmark", {
    changed: all ? false : baseSha,
    config: benchmarkConfig,
    root: repositoryRoot,
    watch: false,
  });
  try {
    const specifications = all
      ? await vitest.globTestSpecifications()
      : await vitest.getRelevantTestSpecifications();
    return specificationFiles(specifications);
  } finally {
    await vitest.close();
  }
}

async function main(): Promise<void> {
  const lane = parseBenchmarkLane(process.env.BENCHMARK_LANE);
  const baseSha = process.env.BENCHMARK_BASE_SHA;
  let all = process.env.BENCHMARK_ALL === "true";
  let changedFiles: string[] = [];

  if (!all) {
    if (!baseSha) {
      throw new Error("BENCHMARK_BASE_SHA is required for a partial benchmark run");
    }
    changedFiles = await changedFilesSince(baseSha);
    all = requiresFullBenchmarkRun(changedFiles);
  }

  const files = selectBenchmarkLane(await discoverBenchmarks({ all, baseSha }), lane);
  const result = {
    all,
    baseSha: all ? null : baseSha,
    changedFiles,
    files,
    lane,
  };

  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `has_benchmarks=${files.length > 0}\nfiles=${JSON.stringify(files)}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
