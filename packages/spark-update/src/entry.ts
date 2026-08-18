import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";

import {
  runSparkManagedInstallCommand,
  runSparkUpdateCommand,
  runSparkVersionCommand,
  type SparkUpdateCliIo,
} from "./cli.ts";

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkUpdateCliParser = or(
  command("version", object({ kind: constant("version" as const), argv: remainingArgv() })),
  command("install", object({ kind: constant("install" as const), argv: remainingArgv() })),
  command("update", object({ kind: constant("update" as const), argv: remainingArgv() })),
);

export async function runSparkUpdateCli(
  argv: string[] = process.argv.slice(2),
  io: SparkUpdateCliIo = {},
): Promise<number> {
  const classified = classifySparkUpdateCli(argv);
  switch (classified.kind) {
    case "version":
      return await runSparkVersionCommand(classified.argv, io);
    case "install":
      if (!classified.argv.includes("--managed")) {
        (io.stderr ?? process.stderr).write('spark install requires "--managed"\n');
        return 2;
      }
      return await runSparkManagedInstallCommand(classified.argv, io);
    case "update":
      return await runSparkUpdateCommand(classified.argv, io);
    case "unknown":
      (io.stderr ?? process.stderr).write(
        `Unknown spark-update command: ${classified.command}\nUsage: spark-update version|install|update [args...]\n`,
      );
      return 2;
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
}

function classifySparkUpdateCli(argv: string[]) {
  const result = parse(sparkUpdateCliParser, argv);
  if (result.success) return { ...result.value, argv: [...result.value.argv] };
  return { kind: "unknown" as const, command: argv[0] ?? "<none>" };
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await runSparkUpdateCli();
}
