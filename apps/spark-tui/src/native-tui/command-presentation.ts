import type { SparkNativeSlashCommand, SparkNativeSlashCommandMap } from "./types.ts";

export const SPARK_NATIVE_COMMAND_GROUP_ORDER = [
  "common",
  "automation",
  "workflow",
  "session",
  "advanced",
] as const;

export type SparkNativeCommandGroup = (typeof SPARK_NATIVE_COMMAND_GROUP_ORDER)[number];

export interface SparkNativeKernelCommandPresentation {
  name: string;
  description: string;
  argumentHint?: string;
  deprecatedAliasFor?: string;
}

export interface SparkNativeCommandPresentation {
  name: string;
  description: string;
  argumentHint?: string;
  deprecatedAliasFor?: string;
  group: SparkNativeCommandGroup;
  source: "kernel" | "registered";
  command?: SparkNativeSlashCommand;
}

const COMMON_COMMANDS = new Set(["help", "plan", "status", "stop", "retry", "inbox", "ask"]);
const AUTOMATION_COMMANDS = new Set(["automate", "goal", "loop", "repro"]);
const SESSION_COMMANDS = new Set([
  "sessions",
  "resume",
  "new",
  "compact",
  "btw",
  "tree",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "model",
]);

export function catalogSparkNativeCommands(
  commands: SparkNativeSlashCommandMap,
  kernelCommands: readonly SparkNativeKernelCommandPresentation[],
  options: { includeDeprecated?: boolean } = {},
): SparkNativeCommandPresentation[] {
  const entries: SparkNativeCommandPresentation[] = [
    ...kernelCommands.map((command) => ({
      ...command,
      group: commandGroup(command.name),
      source: "kernel" as const,
    })),
    ...Object.entries(commands).map(([name, command]) => ({
      name,
      description: command.description,
      argumentHint: command.argumentHint,
      deprecatedAliasFor: command.metadata?.deprecatedAliasFor,
      group: commandGroup(name, command),
      source: "registered" as const,
      command,
    })),
  ];

  return entries
    .filter((entry) => options.includeDeprecated || !entry.deprecatedAliasFor)
    .sort(
      (left, right) =>
        SPARK_NATIVE_COMMAND_GROUP_ORDER.indexOf(left.group) -
          SPARK_NATIVE_COMMAND_GROUP_ORDER.indexOf(right.group) ||
        left.name.localeCompare(right.name),
    );
}

function commandGroup(name: string, command?: SparkNativeSlashCommand): SparkNativeCommandGroup {
  if (COMMON_COMMANDS.has(name)) return "common";
  if (AUTOMATION_COMMANDS.has(name)) return "automation";
  if (
    name === "workflow" ||
    name === "ultracode" ||
    name.startsWith("workflow-") ||
    name.startsWith("workflow:") ||
    command?.metadata?.resource === "workflow"
  ) {
    return "workflow";
  }
  if (
    SESSION_COMMANDS.has(name) ||
    command?.metadata?.resource === "session" ||
    command?.metadata?.resource === "side-thread"
  ) {
    return "session";
  }
  return "advanced";
}
