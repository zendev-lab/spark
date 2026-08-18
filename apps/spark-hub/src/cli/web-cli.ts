import { object, or } from "@optique/core/constructs";
import { formatMessage, message } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import { parse } from "@optique/core/parser";
import { command, constant, flag, option, passThrough } from "@optique/core/primitives";
import type { ValueParser } from "@optique/core/valueparser";

import {
  formatHubWebStatus,
  getHubWebStatus,
  readHubWebLogs,
  runHubWebService,
  startHubWebService,
  stopHubWebService,
} from "./web-service.ts";

const remainingArgv = () => passThrough({ format: "greedy" });
const helpFlag = () => withDefault(flag("-h", "--help"), false);
const jsonFlag = () => withDefault(flag("--json"), false);

const nonNegativeInteger: ValueParser<"sync", number> = {
  mode: "sync",
  metavar: "COUNT",
  placeholder: 100,
  parse(input) {
    const value = Number(input);
    return Number.isSafeInteger(value) && value >= 0
      ? { success: true, value }
      : { success: false, error: message`Expected a non-negative integer.` };
  },
  format: String,
};

function serviceCommand<const TKind extends "run" | "start" | "status" | "stop">(kind: TKind) {
  return command(
    kind,
    map(object({ help: helpFlag(), json: jsonFlag() }), (value) =>
      value.help ? ({ kind: "help" as const } as const) : ({ kind, json: value.json } as const),
    ),
  );
}

const sparkHubWebParser = or(
  command("help", object({ kind: constant("help" as const), argv: remainingArgv() })),
  command("--help", object({ kind: constant("help" as const), argv: remainingArgv() })),
  command("-h", object({ kind: constant("help" as const), argv: remainingArgv() })),
  serviceCommand("run"),
  serviceCommand("start"),
  serviceCommand("status"),
  serviceCommand("stop"),
  command(
    "logs",
    map(
      object({
        help: helpFlag(),
        json: jsonFlag(),
        lines: optional(
          option("-n", "--lines", nonNegativeInteger, {
            errors: {
              endOfInput: message`Invalid --lines value. Pass a non-negative integer.`,
              invalidValue: message`Invalid --lines value. Pass a non-negative integer.`,
            },
          }),
        ),
      }),
      (value) =>
        value.help
          ? ({ kind: "help" as const } as const)
          : ({ kind: "logs" as const, json: value.json, lines: value.lines ?? 100 } as const),
    ),
  ),
  object({ kind: constant("empty" as const) }),
);

/** Handle `spark hub web …` after the surface dispatcher peels off `web`. */
export async function runHubWebCli(argv: string[]): Promise<number> {
  const classified = classifySparkHubWebCommand(argv);
  switch (classified.kind) {
    case "help":
      process.stdout.write(hubWebHelpText());
      return 0;
    case "empty":
      process.stdout.write(`${formatHubWebStatus(getHubWebStatus(), false)}\n`);
      return 0;
    case "status":
      process.stdout.write(`${formatHubWebStatus(getHubWebStatus(), classified.json)}\n`);
      return 0;
    case "run":
      await runHubWebService();
      return typeof process.exitCode === "number" ? process.exitCode : 0;
    case "start": {
      const result = await startHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, classified.json)}\n`);
      return 0;
    }
    case "stop": {
      const result = await stopHubWebService();
      process.stdout.write(`${formatHubWebStatus(result.status, classified.json)}\n`);
      return 0;
    }
    case "logs": {
      const result = readHubWebLogs(process.env, classified.lines);
      if (classified.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const commandName = argv[0] ?? "";
  if (!["help", "--help", "-h", "run", "start", "status", "stop", "logs"].includes(commandName)) {
    return { kind: "unknown" as const, command: commandName };
  }
  throw new Error(formatMessage(result.error));
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
