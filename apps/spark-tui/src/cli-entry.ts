import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSparkCliCommand } from "./cli/args.ts";
import {
  SPARK_TUI_RELOAD_EXIT_CODE,
  SPARK_TUI_WORKER_ARG,
  installSparkTuiWorkerSupervisorGuard,
  runSparkTuiProcessSupervisor,
  sendSparkTuiReloadHandoff,
} from "./cli/process-supervisor.ts";

type SparkCliApplicationModule = typeof import("./cli.ts");

async function loadSparkCliApplication(): Promise<SparkCliApplicationModule> {
  const sourceEntry = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(sourceEntry ? "./cli.ts" : "./spark-tui-worker.js", import.meta.url);
  return (await import(moduleUrl.href)) as SparkCliApplicationModule;
}

export async function runSparkTuiEntrypoint(argv: string[]): Promise<number> {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("Spark TUI process entrypoint is unavailable.");
  const workerRequested = argv[0] === SPARK_TUI_WORKER_ARG;
  const isWorker =
    workerRequested && process.connected === true && typeof process.send === "function";
  if (workerRequested && !isWorker) {
    throw new Error("The Spark TUI worker argument is reserved for the process supervisor.");
  }

  if (isWorker) {
    const supervisorGuard = installSparkTuiWorkerSupervisorGuard();
    try {
      const { runSparkCli } = await loadSparkCliApplication();
      const code = await runSparkCli(argv.slice(1), { onReload: sendSparkTuiReloadHandoff });
      if (supervisorGuard.disconnected) process.exit(1);
      return code;
    } finally {
      supervisorGuard.dispose();
      if (process.connected && typeof process.disconnect === "function") process.disconnect();
    }
  }

  if (parseSparkCliCommand(argv).kind !== "tui") {
    const { runSparkCli } = await loadSparkCliApplication();
    return await runSparkCli(argv);
  }
  return await runSparkTuiProcessSupervisor({
    entrypoint: realpathSync(entrypoint),
    argv,
    cwd: process.cwd(),
  });
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
  const argv = process.argv.slice(2);
  const isWorker = argv[0] === SPARK_TUI_WORKER_ARG;
  runSparkTuiEntrypoint(argv)
    .then((code) => {
      if (isWorker && code === SPARK_TUI_RELOAD_EXIT_CODE) process.exit(code);
      process.exitCode = code;
    })
    .catch(async (error: unknown) => {
      const { formatSparkCliFailure } = await loadSparkCliApplication();
      console.error(formatSparkCliFailure(error, argv));
      process.exitCode = 1;
    });
}
