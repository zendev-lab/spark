import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";

import {
  formatHubWebStatus,
  getHubWebStatus,
  readHubWebLogs,
  runHubWebService,
  startHubWebService,
  stopHubWebService,
} from "./web-service.ts";
import { helpFlagRequested } from "./shared.ts";

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkHubWebParser = or(
  command("run", object({ kind: constant("run" as const), argv: remainingArgv() })),
  command("start", object({ kind: constant("start" as const), argv: remainingArgv() })),
  command("status", object({ kind: constant("status" as const), argv: remainingArgv() })),
  command("stop", object({ kind: constant("stop" as const), argv: remainingArgv() })),
  command("logs", object({ kind: constant("logs" as const), argv: remainingArgv() })),
  object({ kind: constant("empty" as const) }),
);

/** Handle `spark hub web …` after the surface dispatcher peels off `web`. */
export async function runHubWebCli(argv: string[]): Promise<number> {
  if (helpFlagRequested(argv)) {
    process.stdout.write(hubWebHelpText());
    return 0;
  }

  const classified = classifySparkHubWebCommand(argv);
  const json = argv.includes("--json");
  switch (classified.kind) {
    case "empty":
    case "status":
      process.stdout.write(`${formatHubWebStatus(getHubWebStatus(), json)}\n`);
      return 0;
    case "run":
      await runHubWebService();
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    case "start": {
      const result = await startHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "stop": {
      const result = await stopHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, json)}\n`);
      return 0;
    }
    case "logs": {
      const linesIndex = argv.findIndex((arg) => arg === "--lines" || arg === "-n");
      const lines = linesIndex < 0 ? 100 : Number(argv[linesIndex + 1]);
      const result = readHubWebLogs(process.env, lines);
      if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else if (result.text) process.stdout.write(result.text);
      else process.stdout.write(`no logs yet: ${result.logFile}\n`);
      return 0;
    }
    case "unknown":
      throw new Error(`Unknown spark hub web command: ${classified.command}`);
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
}

function classifySparkHubWebCommand(argv: string[]) {
  const result = parse(sparkHubWebParser, argv);
  if (result.success) return result.value;
  return { kind: "unknown" as const, command: argv[0] ?? "" };
}

function hubWebHelpText(): string {
  return `spark hub web - manage the background Hub Web service

Usage:
  spark hub web start [--json]
  spark hub web status [--json]
  spark hub web stop [--json]
  spark hub web logs [--lines <n>] [--json]
  spark hub web --help
`;
}
