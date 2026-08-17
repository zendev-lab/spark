import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";

export interface SparkCliArgs {
  initialMessage?: string;
  help: boolean;
}

export interface SparkCliRuntimeOptions {
  provider?: string;
  model?: string;
  session?: string;
  sessionId?: string;
  sessionDir?: string;
  sparkSessionKey?: string;
  noSession?: boolean;
  wait?: boolean;
  name?: string;
  extensions?: string[];
  noExtensions?: boolean;
  skills?: string[];
  noSkills?: boolean;
  promptTemplates?: string[];
  noPromptTemplates?: boolean;
  themes?: string[];
  noThemes?: boolean;
  noContextFiles?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  excludeTools?: string[];
  projectTrustOverride?: boolean;
  fileArgs?: string[];
}

export type SparkCliCommand =
  | { kind: "help" }
  | { kind: "run"; prompt: string; json: boolean; options?: SparkCliRuntimeOptions }
  | { kind: "tui"; initialMessage?: string; options?: SparkCliRuntimeOptions }
  | { kind: "error"; message: string };

export function parseSparkCliArgs(argv: string[]): SparkCliArgs {
  if (argv.some((arg) => arg === "-h" || arg === "--help")) return { help: true };
  const initialMessage = argv.join(" ").trim();
  return { help: false, initialMessage: initialMessage || undefined };
}

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkTuiCommandParser = or(
  or(
    command("daemon", object({ kind: constant("daemon" as const), argv: remainingArgv() })),
    command("server", object({ kind: constant("server" as const), argv: remainingArgv() })),
    command("sessions", object({ kind: constant("sessions" as const), argv: remainingArgv() })),
    command("session", object({ kind: constant("session" as const), argv: remainingArgv() })),
    command(
      "install",
      object({
        kind: constant("legacy" as const),
        name: constant("install"),
        argv: remainingArgv(),
      }),
    ),
    command(
      "remove",
      object({
        kind: constant("legacy" as const),
        name: constant("remove"),
        argv: remainingArgv(),
      }),
    ),
    command(
      "uninstall",
      object({
        kind: constant("legacy" as const),
        name: constant("uninstall"),
        argv: remainingArgv(),
      }),
    ),
    command(
      "update",
      object({
        kind: constant("legacy" as const),
        name: constant("update"),
        argv: remainingArgv(),
      }),
    ),
    command(
      "list",
      object({
        kind: constant("legacy" as const),
        name: constant("list"),
        argv: remainingArgv(),
      }),
    ),
    command(
      "config",
      object({
        kind: constant("legacy" as const),
        name: constant("config"),
        argv: remainingArgv(),
      }),
    ),
  ),
  or(
    command("run", object({ kind: constant("run" as const), argv: remainingArgv() })),
    command("help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("--help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("-h", object({ kind: constant("help" as const), argv: remainingArgv() })),
  ),
  object({ kind: constant("tui" as const), argv: remainingArgv() }),
  object({ kind: constant("empty" as const) }),
);

/**
 * Authoritative process-mode classifier and Spark TUI argument parser.
 *
 * Keep this module free of application imports: the stable process supervisor
 * uses it before deciding whether to load the full TUI worker.
 */
export function parseSparkCliCommand(argv: string[]): SparkCliCommand {
  const classified = classifySparkTuiCommand(argv);
  switch (classified.kind) {
    case "empty":
      return { kind: "tui" };
    case "help":
      return { kind: "help" };
    case "daemon":
      return {
        kind: "error",
        message: '"daemon" is not a spark-tui command. Use "spark daemon ..." instead.',
      };
    case "server":
      return {
        kind: "error",
        message: '"server" is not a spark-tui command. Use "spark hub" instead.',
      };
    case "sessions":
    case "session":
      return {
        kind: "error",
        message: `Legacy "${classified.kind}" was removed. Use "spark daemon session ..." instead.`,
      };
    case "legacy":
      return {
        kind: "error",
        message: `Legacy "${classified.name}" resource command was removed from spark-tui.`,
      };
    case "run":
      if (hasLegacyPiFlags(classified.argv)) return legacyPiFlagError();
      return parseSparkRunCliCommand([...classified.argv]);
    case "tui": {
      if (classified.argv.some((arg) => arg === "-h" || arg === "--help")) return { kind: "help" };
      if (hasLegacyPiFlags(classified.argv)) return legacyPiFlagError();
      const parsed = parseSparkNativeOptions([...classified.argv]);
      const options = compactRuntimeOptions(parsed.options);
      const initialMessage = parsed.messages.join(" ").trim();
      return {
        kind: "tui",
        ...(initialMessage ? { initialMessage } : {}),
        ...(options ? { options } : {}),
      };
    }
    default: {
      const exhaustive: never = classified;
      return exhaustive;
    }
  }
}

function classifySparkTuiCommand(argv: string[]) {
  const result = parse(sparkTuiCommandParser, argv);
  if (result.success) return result.value;
  return { kind: "tui" as const, argv };
}

function hasLegacyPiFlags(argv: readonly string[]): boolean {
  return argv.some(
    (arg) => arg === "--print" || arg === "-p" || arg === "--mode" || arg === "--list-models",
  );
}

function legacyPiFlagError(): SparkCliCommand {
  return {
    kind: "error",
    message:
      'Legacy Pi-style flags were removed. Use "spark run", "spark acp", or "spark daemon model list".',
  };
}

interface ParsedSparkNativeOptions {
  messages: string[];
  options: SparkCliRuntimeOptions;
}

function parseSparkRunCliCommand(argv: string[]): SparkCliCommand {
  const mapped: string[] = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--resume") {
      const session = readRequired(argv, ++index, arg);
      mapped.push("--session", session);
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const session = arg.slice("--resume=".length);
      if (!session) throw new Error("--resume requires a value");
      mapped.push("--session", session);
      continue;
    }
    mapped.push(arg);
  }
  const parsed = parseSparkNativeOptions(mapped);
  const prompt = parsed.messages.join(" ").trim();
  if (!prompt) throw new Error("spark run requires a prompt");
  const options = compactRuntimeOptions(parsed.options);
  return {
    kind: "run",
    prompt,
    json,
    ...(options ? { options } : {}),
  };
}

function parseSparkNativeOptions(argv: string[]): ParsedSparkNativeOptions {
  const messages: string[] = [];
  const options: SparkCliRuntimeOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--provider":
        options.provider = readRequired(argv, ++index, arg);
        break;
      case "--model":
        options.model = readRequired(argv, ++index, arg);
        break;
      case "--session":
        options.session = readRequired(argv, ++index, arg);
        break;
      case "--session-id":
        options.sessionId = readRequired(argv, ++index, arg);
        break;
      case "--session-dir":
        options.sessionDir = readRequired(argv, ++index, arg);
        break;
      case "--spark-session-key":
        options.sparkSessionKey = readRequired(argv, ++index, arg);
        break;
      case "--no-session":
        options.noSession = true;
        break;
      case "--wait":
      case "-w":
        options.wait = true;
        break;
      case "--name":
      case "-n":
        options.name = readRequired(argv, ++index, arg);
        break;
      case "--extension":
      case "-e":
        (options.extensions ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-extensions":
      case "-ne":
        options.noExtensions = true;
        break;
      case "--skill":
        (options.skills ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-skills":
      case "-ns":
        options.noSkills = true;
        break;
      case "--prompt-template":
        (options.promptTemplates ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-prompt-templates":
      case "-np":
        options.noPromptTemplates = true;
        break;
      case "--theme":
        (options.themes ??= []).push(readRequired(argv, ++index, arg));
        break;
      case "--no-themes":
        options.noThemes = true;
        break;
      case "--no-context-files":
      case "-nc":
        options.noContextFiles = true;
        break;
      case "--thinking":
        options.thinking = readThinkingLevel(argv[++index]);
        break;
      case "--tools":
      case "-t":
        options.tools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--exclude-tools":
      case "-xt":
        options.excludeTools = splitCsv(readRequired(argv, ++index, arg));
        break;
      case "--approve":
      case "-a":
        options.projectTrustOverride = true;
        break;
      case "--no-approve":
      case "-na":
        options.projectTrustOverride = false;
        break;
      default:
        if (arg.startsWith("@")) {
          (options.fileArgs ??= []).push(arg.slice(1));
        } else if (arg.startsWith("-")) {
          throw new Error(`Unknown spark option: ${arg}`);
        } else {
          messages.push(arg);
        }
    }
  }
  return { messages, options };
}

function compactRuntimeOptions(
  options: SparkCliRuntimeOptions,
): SparkCliRuntimeOptions | undefined {
  return Object.values(options).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  )
    ? options
    : undefined;
}

function readRequired(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readThinkingLevel(
  value: string | undefined,
): NonNullable<SparkCliRuntimeOptions["thinking"]> {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  throw new Error("--thinking must be off, minimal, low, medium, high, or xhigh");
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
