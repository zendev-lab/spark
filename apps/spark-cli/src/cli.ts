import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sparkCliDispatcherStrings } from "@zendev-lab/spark-i18n/cli";
import { resolveSparkPaths, resolveSparkUserPaths } from "@zendev-lab/spark-system";

const dispatcherStrings = sparkCliDispatcherStrings();

export type SparkDispatcherTarget = "tui" | "daemon" | "hub" | "acp" | "update";

export type SparkDispatcherCommand =
  | {
      kind: "dispatch";
      target: SparkDispatcherTarget;
      argv: string[];
      autoSessionPrefix?: string;
    }
  | { kind: "help" }
  | { kind: "paths"; json: boolean }
  | { kind: "error"; message: string };

type SparkDispatcherOutput = Pick<NodeJS.WriteStream, "write"> & { isTTY?: boolean };
type SparkDispatcherInput = { isTTY?: boolean };

export interface SparkDispatcherIo {
  stdin?: SparkDispatcherInput;
  stdout?: SparkDispatcherOutput;
  stderr?: SparkDispatcherOutput;
}

export interface SparkDispatcherLauncher {
  run(target: SparkDispatcherTarget, argv: string[], options: SpawnOptions): Promise<number>;
}

export function parseSparkDispatcherArgs(argv: string[]): SparkDispatcherCommand {
  const [first, ...rest] = argv;
  if (!first) return { kind: "dispatch", target: "tui", argv: [] };
  switch (first) {
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "version":
      return { kind: "dispatch", target: "update", argv: ["version", ...rest] };
    case "--version":
    case "-v":
      return { kind: "dispatch", target: "update", argv: ["version"] };
    case "install":
      return { kind: "dispatch", target: "update", argv: ["install", ...rest] };
    case "update":
      return { kind: "dispatch", target: "update", argv: ["update", ...rest] };
    case "paths":
      return parseSparkPathsCommand(rest);
    case "run":
      return parseSparkRunCommand(rest);
    case "bg":
      return parseSparkBackgroundCommand(rest);
    case "doctor":
      return { kind: "dispatch", target: "daemon", argv: ["doctor", ...rest] };
    case "tui":
      return rest.some(
        (arg) => arg === "--print" || arg === "-p" || arg === "--mode" || arg === "--list-models",
      )
        ? errorCommand(
            'Legacy TUI flags were removed. Use "spark run", "spark acp", or "spark-daemon model list".',
          )
        : { kind: "dispatch", target: "tui", argv: rest };
    case "daemon":
      return { kind: "dispatch", target: "daemon", argv: rest };
    case "server":
      return errorCommand('The "spark server" namespace was removed. Use "spark hub" instead.');
    case "hub":
      return { kind: "dispatch", target: "hub", argv: rest };
    case "acp":
      return { kind: "dispatch", target: "acp", argv: rest };
    default:
      return errorCommand(dispatcherStrings.unknownSubcommand(first, argv));
  }
}

export async function runSparkDispatcher(
  argv: string[] = process.argv.slice(2),
  io: SparkDispatcherIo = {},
  launcher: SparkDispatcherLauncher = defaultLauncher,
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const command = parseSparkDispatcherArgs(argv);
  switch (command.kind) {
    case "help":
      stdout.write(helpText());
      return 0;
    case "paths": {
      const payload = {
        sparkHome: process.env.SPARK_HOME?.trim() ?? null,
        user: resolveSparkUserPaths(),
        hub: publicSparkPaths(resolveSparkPaths({ app: "cockpit" })),
        daemon: publicSparkPaths(resolveSparkPaths({ app: "daemon" })),
      };
      stdout.write(
        command.json ? `${JSON.stringify(payload, null, 2)}\n` : formatSparkPaths(payload),
      );
      return 0;
    }
    case "error":
      stderr.write(`${command.message}\n`);
      return 2;
    case "dispatch": {
      const dispatchArgv = command.autoSessionPrefix
        ? withGeneratedSession(command.argv, command.autoSessionPrefix)
        : command.argv;
      if (
        command.target === "tui" &&
        !isSparkTuiHeadlessCompatibilityCommand(dispatchArgv) &&
        !isInteractiveTerminal(io)
      ) {
        stderr.write(`${dispatcherStrings.tuiRequiresTty}\n`);
        return 2;
      }
      return await launcher.run(command.target, dispatchArgv, { stdio: "inherit" });
    }
  }
}

export function helpText(): string {
  return dispatcherStrings.helpText;
}

function parseSparkRunCommand(argv: string[]): SparkDispatcherCommand {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--resume") {
      const session = argv[++index];
      if (!session) return errorCommand("spark run --resume requires a session id");
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const session = arg.slice("--resume=".length);
      if (!session) return errorCommand("spark run --resume requires a session id");
    }
  }
  return { kind: "dispatch", target: "tui", argv: ["run", ...argv] };
}

function parseSparkBackgroundCommand(argv: string[]): SparkDispatcherCommand {
  const mapped = ["submit"];
  let hasSession = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      mapped.push(...argv.slice(index));
      break;
    }
    if (arg === "--resume" || arg === "--session" || arg === "-s") {
      const session = argv[++index];
      if (!session) return errorCommand(`spark bg ${arg} requires a session id`);
      mapped.push("--session", session);
      hasSession = true;
      continue;
    }
    if (arg === "--session-id") {
      const session = argv[++index];
      if (!session) return errorCommand("spark bg --session-id requires a session id");
      mapped.push("--session", session);
      hasSession = true;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const session = arg.slice("--resume=".length);
      if (!session) return errorCommand("spark bg --resume requires a session id");
      mapped.push(`--session=${session}`);
      hasSession = true;
      continue;
    }
    if (arg.startsWith("--session=") || arg.startsWith("--session-id=")) {
      const session = arg.slice(arg.indexOf("=") + 1);
      if (!session) return errorCommand("spark bg --session requires a session id");
      mapped.push(`--session=${session}`);
      hasSession = true;
      continue;
    }
    mapped.push(arg);
  }
  return {
    kind: "dispatch",
    target: "daemon",
    argv: mapped,
    ...(hasSession ? {} : { autoSessionPrefix: "spark-bg" }),
  };
}

function parseSparkPathsCommand(argv: string[]): SparkDispatcherCommand {
  if (argv.length === 0) return { kind: "paths", json: false };
  if (argv.length === 1 && argv[0] === "--json") return { kind: "paths", json: true };
  return errorCommand('spark paths accepts only the optional "--json" flag');
}

function formatSparkPaths(payload: {
  sparkHome: string | null;
  user: ReturnType<typeof resolveSparkUserPaths>;
  hub: Omit<ReturnType<typeof resolveSparkPaths>, "piAgentDir">;
  daemon: Omit<ReturnType<typeof resolveSparkPaths>, "piAgentDir">;
}): string {
  const lines = [`SPARK_HOME=${payload.sparkHome ?? "<unset>"}`, "", "user:"];
  for (const [key, value] of Object.entries(payload.user)) lines.push(`  ${key}=${value}`);
  for (const [label, paths] of [
    ["hub", payload.hub],
    ["daemon", payload.daemon],
  ] as const) {
    lines.push("", `${label}:`);
    for (const [key, value] of Object.entries(paths)) lines.push(`  ${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function errorCommand(message: string): SparkDispatcherCommand {
  return { kind: "error", message };
}

function withGeneratedSession(argv: string[], prefix: string): string[] {
  const sessionId = generatedSessionId(prefix);
  if (argv[0] === "submit") return [argv[0], "--session", sessionId, ...argv.slice(1)];
  return ["--session", sessionId, ...argv];
}

function generatedSessionId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSparkTuiHeadlessCompatibilityCommand(argv: readonly string[]): boolean {
  return argv[0] === "run" || argv.includes("--help") || argv.includes("-h");
}

function publicSparkPaths(
  paths: ReturnType<typeof resolveSparkPaths>,
): Omit<ReturnType<typeof resolveSparkPaths>, "piAgentDir"> {
  const { piAgentDir: _piAgentDir, ...publicPaths } = paths;
  return publicPaths;
}

function isInteractiveTerminal(io: SparkDispatcherIo): boolean {
  return Boolean(
    (io.stdin?.isTTY ?? process.stdin.isTTY) && (io.stdout?.isTTY ?? process.stdout.isTTY),
  );
}

const defaultLauncher: SparkDispatcherLauncher = {
  run(target, argv, options) {
    return new Promise((resolve) => {
      const command = resolveTargetCommand(target);
      const child = spawn(command.command, [...command.args, ...argv], options);
      child.on("error", (error: NodeJS.ErrnoException) => {
        const detail = error.code === "ENOENT" ? "executable was not found on PATH" : error.message;
        process.stderr.write(`${dispatcherStrings.dispatchFailure(command.label, detail)}\n`);
        resolve(error.code === "ENOENT" ? 127 : 1);
      });
      child.on("close", (code, signal) => {
        if (signal) {
          process.stderr.write(`${dispatcherStrings.signalExit(command.label, signal)}\n`);
          resolve(1);
          return;
        }
        resolve(code ?? 1);
      });
    });
  },
};

export function resolveTargetCommand(target: SparkDispatcherTarget): {
  command: string;
  args: string[];
  label: string;
} {
  const local = localTargetCommand(target);
  return {
    command: local ?? targetExecutable(target),
    args: [],
    label: targetLabel(target),
  };
}

function targetLabel(target: SparkDispatcherTarget): string {
  return dispatcherStrings.targetLabel(target);
}

function localTargetCommand(target: SparkDispatcherTarget): string | undefined {
  const configured = packagedTargetCommand(target);
  if (configured && existsSync(configured)) return realpathSync(configured);
  const adjacent = adjacentTargetCommand(target);
  if (adjacent && existsSync(adjacent)) return realpathSync(adjacent);
  const sourceExecutable = sourceCheckoutTargetCommand(target);
  return sourceExecutable && existsSync(sourceExecutable)
    ? realpathSync(sourceExecutable)
    : undefined;
}

function packagedTargetCommand(target: SparkDispatcherTarget): string | undefined {
  const variableByTarget: Partial<Record<SparkDispatcherTarget, string>> = {
    daemon: "SPARK_DAEMON_COMMAND",
    hub: "SPARK_HUB_COMMAND",
    tui: "SPARK_TUI_COMMAND",
  };
  const variable = variableByTarget[target];
  return variable ? process.env[variable]?.trim() : undefined;
}

function adjacentTargetCommand(target: SparkDispatcherTarget): string | undefined {
  const argvEntry = process.argv[1];
  if (!argvEntry) return undefined;
  try {
    return resolve(dirname(realpathSync(argvEntry)), targetExecutable(target));
  } catch {
    return undefined;
  }
}

function sourceCheckoutTargetCommand(target: SparkDispatcherTarget): string | undefined {
  const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entryByTarget: Record<SparkDispatcherTarget, string> = {
    tui: "../spark-tui/bin/spark-tui",
    daemon: "../spark-daemon/bin/spark-daemon",
    hub: "../spark-cockpit/bin/spark-hub",
    acp: "../../packages/spark-acp/scripts/stdio.ts",
    update: "../../packages/spark-update/bin/spark-update",
  };
  return resolve(cliRoot, entryByTarget[target]);
}

function targetExecutable(target: SparkDispatcherTarget): string {
  return `spark-${target}`;
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
  runSparkDispatcher()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 1;
    });
}
