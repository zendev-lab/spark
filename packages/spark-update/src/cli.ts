import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";
import { formatSparkCliError, SparkCliError, sparkCliExitCode } from "@zendev-lab/spark-i18n/cli";

import { readSparkBuildInfo } from "./build-info.ts";
import { parseChannel, parsePolicy } from "./config.ts";
import { SparkUpdateManager } from "./manager.ts";
import type { SparkUpdateConfig } from "./types.ts";

type Output = Pick<NodeJS.WriteStream, "write">;

export interface SparkUpdateCliIo {
  stdout?: Output;
  stderr?: Output;
}

export async function runSparkVersionCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--json")) {
    (io.stderr ?? process.stderr).write(
      formatSparkCliError(
        invalidUpdateArgument("Invalid spark version options", [
          'The command accepts only the optional "--json" flag.',
        ]),
      ),
    );
    return 2;
  }
  const build = readSparkBuildInfo();
  stdout.write(argv[0] === "--json" ? `${JSON.stringify(build, null, 2)}\n` : `${build.version}\n`);
  return 0;
}

export async function runSparkManagedInstallCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  return await guarded(io, async () => {
    const version = optionValue(argv, "--version");
    const prefix = optionValue(argv, "--prefix");
    const unknown = argv.filter(
      (argument, index) =>
        argument !== "--managed" &&
        argument !== "--version" &&
        argument !== "--prefix" &&
        argv[index - 1] !== "--version" &&
        argv[index - 1] !== "--prefix",
    );
    if (unknown.length > 0) {
      throw invalidUpdateArgument(`Unknown managed install option: ${unknown[0]}`);
    }
    const status = await new SparkUpdateManager({ prefix }).installManaged(version);
    (io.stdout ?? process.stdout).write(`${formatStatus(status)}\n`);
  });
}

export async function runSparkUpdateCommand(
  argv: string[],
  io: SparkUpdateCliIo = {},
): Promise<number> {
  return await guarded(io, async () => {
    const classified = classifySparkUpdateAction(argv);
    if (classified.action === "unknown") {
      throw invalidUpdateArgument(`Unknown spark update action: ${classified.command}`, [
        'Run "spark update --help" to see the supported actions.',
      ]);
    }
    const rest = classified.argv;
    const prefix = optionValue(rest, "--prefix");
    const manager = new SparkUpdateManager({ prefix });
    await UPDATE_COMMAND_HANDLERS[classified.action]({
      manager,
      rest,
      stdout: io.stdout ?? process.stdout,
    });
  });
}

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkUpdateActionParser = or(
  command("status", object({ action: constant("status" as const), argv: remainingArgv() })),
  command("check", object({ action: constant("check" as const), argv: remainingArgv() })),
  command("__tick", object({ action: constant("__tick" as const), argv: remainingArgv() })),
  command("configure", object({ action: constant("configure" as const), argv: remainingArgv() })),
  command("apply", object({ action: constant("apply" as const), argv: remainingArgv() })),
  command("rollback", object({ action: constant("rollback" as const), argv: remainingArgv() })),
  command("retry", object({ action: constant("retry" as const), argv: remainingArgv() })),
  object({ action: constant("empty" as const) }),
);

function classifySparkUpdateAction(argv: string[]) {
  const result = parse(sparkUpdateActionParser, argv);
  if (result.success) {
    if (result.value.action === "empty") return { action: "status" as const, argv: [] as string[] };
    return { ...result.value, argv: [...result.value.argv] };
  }
  return { action: "unknown" as const, command: argv[0] ?? "" };
}

interface UpdateCommandContext {
  manager: SparkUpdateManager;
  rest: string[];
  stdout: Output;
}

type UpdateCommandHandler = (context: UpdateCommandContext) => Promise<void>;

const UPDATE_COMMAND_HANDLERS: Readonly<Record<string, UpdateCommandHandler>> = {
  status: async ({ manager, rest, stdout }) => {
    writeStatus(stdout, await manager.status(), rest.includes("--json"));
  },
  check: async ({ manager, rest, stdout }) => {
    writeStatus(stdout, await manager.check(), rest.includes("--json"));
  },
  __tick: async ({ manager }) => {
    try {
      await manager.tick();
    } catch {
      // Background failures are already rate-limited and persisted by the
      // updater. Keep launchd's 15-minute tick from duplicating log noise.
    }
  },
  configure: async ({ manager, rest, stdout }) => {
    const policyValue = optionValue(rest, "--policy");
    const channelValue = optionValue(rest, "--channel");
    const intervalValue = optionValue(rest, "--interval-hours");
    const policy = policyValue ? parsePolicy(policyValue) : undefined;
    const channel = channelValue ? parseChannel(channelValue) : undefined;
    const checkIntervalHours = intervalValue ? Number(intervalValue) : undefined;
    if (policyValue && !policy) {
      throw invalidUpdateArgument(`Invalid update policy: ${policyValue}`);
    }
    if (channelValue && !channel) {
      throw invalidUpdateArgument(`Invalid update channel: ${channelValue}`);
    }
    if (!policy && !channel && checkIntervalHours === undefined) {
      throw invalidUpdateArgument(
        "spark update configure requires --policy, --channel, and/or --interval-hours",
      );
    }
    const config = await manager.configure({
      ...(policy ? { policy } : {}),
      ...(channel ? { channel } : {}),
      ...(checkIntervalHours !== undefined ? { checkIntervalHours } : {}),
    });
    stdout.write(
      rest.includes("--json")
        ? `${JSON.stringify(config, null, 2)}\n`
        : `${formatConfig(config)}\n`,
    );
  },
  apply: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.apply(positional(rest), { wait: true }))}\n`);
  },
  rollback: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.rollback({ wait: true }))}\n`);
  },
  retry: async ({ manager, rest, stdout }) => {
    requireConfirmation(rest);
    stdout.write(`${formatStatus(await manager.retry(positional(rest)))}\n`);
  },
};

function formatConfig(config: SparkUpdateConfig): string {
  return [
    `policy: ${config.policy}`,
    `channel: ${config.channel}`,
    `check interval: ${config.checkIntervalHours}h`,
  ].join("\n");
}

function writeStatus(
  output: Output,
  status: Awaited<ReturnType<SparkUpdateManager["status"]>>,
  json: boolean,
): void {
  output.write(json ? `${JSON.stringify(status, null, 2)}\n` : `${formatStatus(status)}\n`);
}

function optionValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw invalidUpdateArgument(`${name} requires a value`);
  return value;
}

function positional(argv: string[]): string | undefined {
  return argv.find(
    (argument, index) =>
      !argument.startsWith("--") &&
      argv[index - 1] !== "--prefix" &&
      argv[index - 1] !== "--policy" &&
      argv[index - 1] !== "--channel" &&
      argv[index - 1] !== "--interval-hours",
  );
}

function requireConfirmation(argv: string[]): void {
  if (!argv.includes("--yes")) {
    throw new SparkCliError({
      code: "CONFIRMATION_REQUIRED",
      title: "Managed installation confirmation is required",
      hints: ["Rerun with --yes to confirm the change."],
      exitCode: 2,
    });
  }
}

function formatStatus(status: Awaited<ReturnType<SparkUpdateManager["status"]>>): string {
  const state = status.state;
  return [
    `managed: ${status.managed ? "yes" : "no"}`,
    `installation: ${status.installation.method}`,
    `policy: ${status.config.policy}`,
    `channel: ${status.config.channel}`,
    `current: ${state.currentVersion ?? "none"}`,
    `available: ${state.availableVersion ?? "none"}`,
    `pending: ${state.pendingVersion ?? "none"}`,
    `quarantined: ${state.quarantined.map((entry) => entry.version).join(", ") || "none"}`,
    ...(status.installation.updateCommand
      ? [`update command: ${status.installation.updateCommand}`]
      : []),
    ...(status.repairCommand ? [`repair: ${status.repairCommand}`] : []),
  ].join("\n");
}

async function guarded(io: SparkUpdateCliIo, operation: () => Promise<void>): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    (io.stderr ?? process.stderr).write(
      formatSparkCliError(error, {
        code: "UPDATE_FAILED",
        title: "Spark update command failed",
      }),
    );
    return sparkCliExitCode(error);
  }
}

function invalidUpdateArgument(title: string, hints: readonly string[] = []): SparkCliError {
  return new SparkCliError({
    code: "INVALID_ARGUMENT",
    title,
    hints: hints.length > 0 ? hints : ['Run "spark update --help" to see the supported options.'],
    exitCode: 2,
  });
}
