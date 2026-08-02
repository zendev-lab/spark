import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  runSparkManagedInstallCommand,
  runSparkUpdateCommand,
  runSparkVersionCommand,
  type SparkUpdateCliIo,
} from "./cli.ts";

export async function runSparkUpdateCli(
  argv: string[] = process.argv.slice(2),
  io: SparkUpdateCliIo = {},
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "version":
      return await runSparkVersionCommand(rest, io);
    case "install":
      if (!rest.includes("--managed")) {
        (io.stderr ?? process.stderr).write('spark install requires "--managed"\n');
        return 2;
      }
      return await runSparkManagedInstallCommand(rest, io);
    case "update":
      return await runSparkUpdateCommand(rest, io);
    default:
      (io.stderr ?? process.stderr).write(
        `Unknown spark-update command: ${command ?? "<none>"}\nUsage: spark-update version|install|update [args...]\n`,
      );
      return 2;
  }
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
