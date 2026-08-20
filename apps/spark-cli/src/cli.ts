import { spawn, type ChildProcess, type Serializable, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { object, or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { parse } from "@optique/core/parser";
import { command, constant, option, passThrough } from "@optique/core/primitives";
import { sparkCliDispatcherStrings } from "@zendev-lab/spark-i18n/cli";
import { resolveSparkPaths, resolveSparkUserPaths } from "@zendev-lab/spark-system";

const dispatcherStrings = sparkCliDispatcherStrings();

export type SparkDispatcherTarget = "daemon" | "hub" | "acp" | "mcp" | "update" | "web" | "web-dsh";

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

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkDispatcherParser = or(
  or(
    command("help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("--help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("-h", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("version", object({ kind: constant("version" as const), argv: remainingArgv() })),
    command("--version", object({ kind: constant("versionFlag" as const), argv: remainingArgv() })),
    command("-v", object({ kind: constant("versionFlag" as const), argv: remainingArgv() })),
    command("install", object({ kind: constant("install" as const), argv: remainingArgv() })),
    command("update", object({ kind: constant("update" as const), argv: remainingArgv() })),
    command(
      "paths",
      object({
        kind: constant("paths" as const),
        json: option("--json"),
        argv: remainingArgv(),
      }),
    ),
  ),
  or(
    command("run", object({ kind: constant("run" as const), argv: remainingArgv() })),
    command("bg", object({ kind: constant("bg" as const), argv: remainingArgv() })),
    command("doctor", object({ kind: constant("doctor" as const), argv: remainingArgv() })),
    command("tui", object({ kind: constant("tui" as const), argv: remainingArgv() })),
    command("daemon", object({ kind: constant("daemon" as const), argv: remainingArgv() })),
    command("hub", object({ kind: constant("hub" as const), argv: remainingArgv() })),
    command("acp", object({ kind: constant("acp" as const), argv: remainingArgv() })),
    command("mcp", object({ kind: constant("mcp" as const), argv: remainingArgv() })),
    command("server", object({ kind: constant("server" as const), argv: remainingArgv() })),
    command("web", object({ kind: constant("web" as const), argv: remainingArgv() })),
    command("web-dsh", object({ kind: constant("web-dsh" as const), argv: remainingArgv() })),
  ),
  object({ kind: constant("empty" as const) }),
);

const knownDispatcherCommands = new Set([
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
  "install",
  "update",
  "paths",
  "run",
  "bg",
  "doctor",
  "tui",
  "daemon",
  "hub",
  "acp",
  "mcp",
  "server",
  "web",
  "web-dsh",
]);

export function parseSparkDispatcherArgs(argv: string[]): SparkDispatcherCommand {
  const result = parse(sparkDispatcherParser, argv);
  if (!result.success) {
    const first = argv[0];
    if (first !== undefined && !knownDispatcherCommands.has(first)) {
      return errorCommand(dispatcherStrings.unknownSubcommand(first, argv));
    }
    return errorCommand(formatMessage(result.error));
  }

  const parsed = result.value;
  switch (parsed.kind) {
    case "empty":
      return { kind: "help" };
    case "help":
      return { kind: "help" };
    case "version":
      return { kind: "dispatch", target: "update", argv: ["version", ...parsed.argv] };
    case "versionFlag":
      return { kind: "dispatch", target: "update", argv: ["version"] };
    case "install":
      return { kind: "dispatch", target: "update", argv: ["install", ...parsed.argv] };
    case "update":
      return { kind: "dispatch", target: "update", argv: ["update", ...parsed.argv] };
    case "paths":
      return parseSparkPathsCommand(parsed.json, parsed.argv);
    case "run":
      return parseSparkRunCommand([...parsed.argv]);
    case "bg":
      return parseSparkBackgroundCommand([...parsed.argv]);
    case "doctor":
      return { kind: "dispatch", target: "daemon", argv: ["doctor", ...parsed.argv] };
    case "tui":
      return errorCommand(
        'The Spark TUI was removed. Use "spark web" for the local browser workbench or "spark run <prompt>" for headless turns.',
      );
    case "daemon":
      return { kind: "dispatch", target: "daemon", argv: [...parsed.argv] };
    case "hub":
      return { kind: "dispatch", target: "hub", argv: [...parsed.argv] };
    case "acp":
      return { kind: "dispatch", target: "acp", argv: [...parsed.argv] };
    case "mcp":
      return { kind: "dispatch", target: "mcp", argv: [...parsed.argv] };
    case "server":
      return errorCommand('The "spark server" namespace was removed. Use "spark hub" instead.');
    case "web":
      return { kind: "dispatch", target: "web", argv: [...parsed.argv] };
    case "web-dsh":
      return { kind: "dispatch", target: "web-dsh", argv: [...parsed.argv] };
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
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
        hub: publicSparkPaths(resolveSparkPaths({ app: "hub" })),
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
      return await launcher.run(
        command.target,
        dispatchArgv,
        spawnOptions(command.target, dispatchArgv),
      );
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function helpText(): string {
  return dispatcherStrings.helpText;
}

function parseSparkRunCommand(argv: string[]): SparkDispatcherCommand {
  const mapped = ["submit"];
  let hasSession = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      mapped.push(...argv.slice(index));
      break;
    }
    if (arg === "--wait" || arg === "-w") {
      mapped.push("--wait");
      continue;
    }
    if (arg === "--resume" || arg === "--session" || arg === "-s") {
      const session = argv[++index];
      if (!session) return errorCommand(`spark run ${arg} requires a session id`);
      mapped.push("--session", session);
      hasSession = true;
      continue;
    }
    if (arg === "--session-id") {
      const session = argv[++index];
      if (!session) return errorCommand("spark run --session-id requires a session id");
      mapped.push("--session", session);
      hasSession = true;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const session = arg.slice("--resume=".length);
      if (!session) return errorCommand("spark run --resume requires a session id");
      mapped.push(`--session=${session}`);
      hasSession = true;
      continue;
    }
    if (arg.startsWith("--session=") || arg.startsWith("--session-id=")) {
      const session = arg.slice(arg.indexOf("=") + 1);
      if (!session) return errorCommand("spark run --session requires a session id");
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
    ...(hasSession ? {} : { autoSessionPrefix: "spark-run" }),
  };
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

function parseSparkPathsCommand(json: boolean, argv: readonly string[]): SparkDispatcherCommand {
  if (argv.length > 0) return errorCommand('spark paths accepts only the optional "--json" flag');
  return { kind: "paths", json };
}

function formatSparkPaths(payload: {
  sparkHome: string | null;
  user: ReturnType<typeof resolveSparkUserPaths>;
  hub: Omit<ReturnType<typeof resolveSparkPaths>, "sessionRuntimeDir">;
  daemon: Omit<ReturnType<typeof resolveSparkPaths>, "sessionRuntimeDir">;
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

function publicSparkPaths(
  paths: ReturnType<typeof resolveSparkPaths>,
): Omit<ReturnType<typeof resolveSparkPaths>, "sessionRuntimeDir"> {
  const { sessionRuntimeDir: _sessionRuntimeDir, ...publicPaths } = paths;
  return publicPaths;
}

const defaultLauncher: SparkDispatcherLauncher = {
  run(target, argv, options) {
    return new Promise((resolve) => {
      const command = resolveTargetCommand(target);
      const child = spawn(command.command, [...command.args, ...argv], options);
      const releaseIpcBridge = bridgeDaemonIpc(target, argv, child);
      child.on("error", (error: NodeJS.ErrnoException) => {
        releaseIpcBridge();
        const detail = error.code === "ENOENT" ? "executable was not found on PATH" : error.message;
        process.stderr.write(`${dispatcherStrings.dispatchFailure(command.label, detail)}\n`);
        resolve(error.code === "ENOENT" ? 127 : 1);
      });
      child.on("close", (code, signal) => {
        releaseIpcBridge();
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

function spawnOptions(target: SparkDispatcherTarget, argv: readonly string[]): SpawnOptions {
  return {
    stdio: shouldBridgeDaemonIpc(target, argv)
      ? ["inherit", "inherit", "inherit", "ipc"]
      : "inherit",
  };
}

function shouldBridgeDaemonIpc(target: SparkDispatcherTarget, argv: readonly string[]): boolean {
  return (
    target === "daemon" &&
    argv[0] === "__restart-successor" &&
    process.connected === true &&
    typeof process.send === "function"
  );
}

function bridgeDaemonIpc(
  target: SparkDispatcherTarget,
  argv: readonly string[],
  child: ChildProcess,
): () => void {
  if (!shouldBridgeDaemonIpc(target, argv) || typeof child.send !== "function") {
    return () => undefined;
  }

  let released = false;
  const onParentMessage = (message: Serializable) => {
    if (!child.connected) return;
    child.send(message, reportIpcForwardingError("parent to daemon"));
  };
  const onChildMessage = (message: Serializable) => {
    if (process.connected !== true || typeof process.send !== "function") return;
    process.send(message, reportIpcForwardingError("daemon to parent"));
  };
  const onParentDisconnect = () => {
    release();
    if (child.connected) child.disconnect();
  };
  const release = () => {
    if (released) return;
    released = true;
    process.off("message", onParentMessage);
    process.off("disconnect", onParentDisconnect);
    child.off("message", onChildMessage);
    child.off("disconnect", release);
  };

  process.on("message", onParentMessage);
  process.once("disconnect", onParentDisconnect);
  child.on("message", onChildMessage);
  child.once("disconnect", release);
  return release;
}

function reportIpcForwardingError(direction: string): (error: Error | null) => void {
  return (error) => {
    if (!error) return;
    process.stderr.write(`Spark daemon IPC bridge failed (${direction}): ${error.message}\n`);
  };
}

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
    mcp: "SPARK_MCP_COMMAND",
    update: "SPARK_UPDATE_COMMAND",
    web: "SPARK_WEB_COMMAND",
    "web-dsh": "SPARK_WEB_DSH_COMMAND",
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
  const entryByTarget: Partial<Record<SparkDispatcherTarget, string>> = {
    daemon: "../spark-daemon/bin/spark-daemon",
    hub: "../spark-hub/bin/spark-hub",
    acp: "../../packages/spark-acp/bin/spark-acp.ts",
    mcp: "../../packages/spark-mcp/bin/spark-mcp.ts",
    update: "../../packages/spark-update/bin/spark-update",
    web: "../spark-web/bin/spark-web",
    "web-dsh": "../spark-web-dsh/bin/spark-web-dsh",
  };
  const entry = entryByTarget[target];
  return entry ? resolve(cliRoot, entry) : undefined;
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
