import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";
import { formatSparkCliError, SparkCliError } from "@zendev-lab/spark-i18n/cli";

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
        (io.stderr ?? process.stderr).write(
          formatSparkCliError(
            new SparkCliError({
              code: "INVALID_ARGUMENT",
              title: 'spark install requires "--managed"',
              hints: ['Run "spark install --managed --help" for usage.'],
              exitCode: 2,
            }),
          ),
        );
        return 2;
      }
      return await runSparkManagedInstallCommand(classified.argv, io);
    case "update":
      return await runSparkUpdateCommand(classified.argv, io);
    case "unknown":
      (io.stderr ?? process.stderr).write(
        formatSparkCliError(
          new SparkCliError({
            code: "UNKNOWN_COMMAND",
            title: `Unknown spark-update command: ${classified.command}`,
            hints: ["Usage: spark-update version|install|update [args...]"],
            exitCode: 2,
          }),
        ),
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
