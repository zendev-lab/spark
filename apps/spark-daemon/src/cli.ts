import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { object, or } from "@optique/core/constructs";
import { parse } from "@optique/core/parser";
import { command, constant, passThrough } from "@optique/core/primitives";
import { resolvePiAuthSourcePath } from "@zendev-lab/spark-llm-providers/control";
import type { SparkAuthFlow, SparkAuthImportReport } from "@zendev-lab/spark-protocol";
import { gitCommand, resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  defaultSparkDaemonConfig,
  readSparkDaemonConfig,
  writeSparkDaemonConfig,
} from "./config.js";
import { sparkDaemonVersion } from "./daemon.js";
import {
  getSparkDaemonServerProfile,
  listSparkDaemonServerProfiles,
  scheduledSparkDaemonHubOrigin,
  sparkDaemonConfigForServerProfile,
  type SparkDaemonServerProfile,
} from "./server-profiles.js";

import {
  type LocalWorkspaceLifecycleMutation,
  LocalRpcUnavailableError,
  localRpcSocketPath,
  requestWorkspaceAttach,
  requestWorkspaceList,
  requestWorkspaceLifecycle,
  requestWorkspaceRegister,
  requestWorkspaceRelocate,
  requestUplinkPark,
  requestUplinkUnpark,
  requestUplinkPrefer,
  requestUplinkStatus,
  requestWorkspaceStop,
  requestProviderAuthImportPi,
  requestProviderAuthLogout,
  requestProviderAuthOAuthCancel,
  requestProviderAuthOAuthRespond,
  requestProviderAuthOAuthStart,
  requestProviderAuthOAuthStatus,
  requestProviderAuthSetApiKey,
  requestProviderAuthSnapshot,
} from "./local-rpc.js";
import {
  completeSparkDaemonDeviceAuthorization,
  configuredServerUrl,
  DeviceAuthorizationError,
  hasRunnableSparkDaemonCredentialsForServer,
  RegistrationGrantRefusedError,
  startSparkDaemonDeviceAuthorization,
  validateRegistrationServerUrl,
} from "./registration.js";

import {
  isUserDetachedWorkspace,
  type RegisterWorkspaceOptions,
  type SparkDaemonWorkspace,
  type WorkspaceProfileRegistration,
  planWorkspaceRegistration,
  workspaceNameForPath,
  WorkspacePathConflictError,
} from "./store/workspaces.js";
import { migrateEvidenceWorkspaceCommand } from "./evidence-migration-cli.js";
import { readRunningPid } from "./service.js";
import {
  type CliIo,
  defaultIo,
  STRINGS,
  SparkDaemonUnavailableError,
  WorkspacePathValidationError,
  prepareSparkDaemonState,
  parseFlags,
  helpRequested,
  positionalArgs,
  confirmAction,
  printHelp,
  printWorkspaceHelp,
  printLoginHelp,
  printUplinkHelp,
  startSparkDaemonProcess,
  syncSparkDaemonIfConfigured,
  errorMessage,
  padColumn,
  truncateColumn,
  readStdinLine,
  promptSecret,
  promptWithDefault,
  resolveInvocationCwd,
  writeSparkDaemonCliError,
  writeSparkDaemonUsageError,
} from "./cli-shared.ts";
import {
  bindCliDaemonLogs,
  buildDaemonStatus,
  daemon,
  daemonSync,
  daemonAsk,
  daemonSubmit,
  type DaemonStatus,
  restart,
  restartSuccessor,
  start,
  startCommand,
  stop,
} from "./cli-daemon-lifecycle.ts";
import { runSparkDaemonControlCommand } from "./control-cli.ts";

export type { CliIo } from "./cli-shared.ts";
export { sparkDaemonServiceExitCode } from "./cli-daemon-lifecycle.ts";

const remainingArgv = () => passThrough({ format: "greedy" });

const sparkDaemonCommandParser = or(
  or(
    command("help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("--help", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("-h", object({ kind: constant("help" as const), argv: remainingArgv() })),
    command("install", object({ kind: constant("install" as const), argv: remainingArgv() })),
    command("doctor", object({ kind: constant("doctor" as const), argv: remainingArgv() })),
    command("status", object({ kind: constant("status" as const), argv: remainingArgv() })),
    command("logs", object({ kind: constant("logs" as const), argv: remainingArgv() })),
    command("login", object({ kind: constant("login" as const), argv: remainingArgv() })),
    command("auth", object({ kind: constant("auth" as const), argv: remainingArgv() })),
  ),
  or(
    command("start", object({ kind: constant("start" as const), argv: remainingArgv() })),
    command(
      "__service-start",
      object({ kind: constant("serviceStart" as const), argv: remainingArgv() }),
    ),
    command("stop", object({ kind: constant("stop" as const), argv: remainingArgv() })),
    command("restart", object({ kind: constant("restart" as const), argv: remainingArgv() })),
    command("sync", object({ kind: constant("sync" as const), argv: remainingArgv() })),
    command(
      "__restart-successor",
      object({ kind: constant("restartSuccessor" as const), argv: remainingArgv() }),
    ),
    command("submit", object({ kind: constant("submit" as const), argv: remainingArgv() })),
    command("ask", object({ kind: constant("ask" as const), argv: remainingArgv() })),
  ),
  or(
    command("model", object({ kind: constant("model" as const), argv: remainingArgv() })),
    command("invocation", object({ kind: constant("invocation" as const), argv: remainingArgv() })),
    command("session", object({ kind: constant("session" as const), argv: remainingArgv() })),
    command("sessions", object({ kind: constant("sessions" as const), argv: remainingArgv() })),
    command("channel", object({ kind: constant("channel" as const), argv: remainingArgv() })),
    command("channels", object({ kind: constant("channels" as const), argv: remainingArgv() })),
    command("run", object({ kind: constant("run" as const), argv: remainingArgv() })),
    command("runs", object({ kind: constant("runs" as const), argv: remainingArgv() })),
    command("events", object({ kind: constant("events" as const), argv: remainingArgv() })),
  ),
  or(
    command("workspace", object({ kind: constant("workspace" as const), argv: remainingArgv() })),
    command("ws", object({ kind: constant("workspace" as const), argv: remainingArgv() })),
    command("uplink", object({ kind: constant("uplink" as const), argv: remainingArgv() })),
    command("daemon", object({ kind: constant("daemon" as const), argv: remainingArgv() })),
  ),
  object({ kind: constant("empty" as const) }),
);

function classifySparkDaemonCommand(argv: string[]) {
  const result = parse(sparkDaemonCommandParser, argv);
  if (result.success) {
    if (result.value.kind === "empty") return result.value;
    return { ...result.value, argv: [...result.value.argv] };
  }
  const first = argv[0];
  if (first?.startsWith("--")) return { kind: "workspaceDefault" as const, argv };
  return { kind: "unknown" as const, command: first ?? "" };
}

export async function main(argv = process.argv.slice(2), io: CliIo = defaultIo): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const classified = classifySparkDaemonCommand(args);
  const paths = resolveSparkPaths({ app: "daemon" });

  try {
    switch (classified.kind) {
      case "help":
        printHelp(io);
        return 0;
      case "workspaceDefault":
        return await defaultWorkspace(paths, classified.argv, io);
      case "empty":
        return await defaultWorkspace(paths, [], io);
      case "unknown": {
        const title = STRINGS.unknownCommand(classified.command);
        writeSparkDaemonCliError(io, new Error(title), {
          code: "UNKNOWN_COMMAND",
          title,
          hints: ['Run "spark daemon --help" to see the supported commands.'],
          exitCode: 2,
        });
        return 2;
      }
      case "install":
        return install(paths, io);
      case "doctor":
        return await doctor(paths, args.slice(1), io);
      case "status":
        return await status(paths, args.slice(1), io);
      case "logs":
        return await logs(paths, classified.argv, io);
      case "login":
        return await login(paths, classified.argv, io);
      case "auth": {
        const [subcommand, ...rest] = classified.argv;
        return await providerAuth(paths, subcommand, rest, io);
      }
      case "start": {
        const managed = process.env.XPC_SERVICE_NAME === "dev.spark.daemon";
        if (!managed) return await startCommand(paths, classified.argv, io);
        return await start(paths, {
          // Plists created by older Spark versions invoked `start` directly.
          // launchd exposes the label here, so legacy managed activation must
          // still honor a durable Cancelled tombstone instead of clearing it.
          explicit: !managed,
          managed,
        });
      }
      case "serviceStart":
        // This entrypoint is shared by launchd and detached starts. Only the
        // former has a supervisor that can replace a planned restart exit.
        return await start(paths, {
          explicit: false,
          managed: process.env.XPC_SERVICE_NAME === "dev.spark.daemon",
          expectedRestartId: process.env.SPARK_DAEMON_EXPECTED_RESTART_ID?.trim() || undefined,
        });
      case "stop":
        return await stop(paths, classified.argv, io);
      case "restart":
        return await restart(paths, classified.argv, io);
      case "sync":
        return await daemonSync(paths, classified.argv, io);
      case "restartSuccessor":
        return await restartSuccessor(paths, classified.argv, io);
      case "submit":
        return await daemonSubmit(paths, classified.argv, io);
      case "ask":
        return await daemonAsk(paths, classified.argv, io);
      case "model":
      case "invocation":
      case "session":
      case "sessions":
      case "channel":
      case "channels":
      case "run":
      case "runs":
      case "events":
        return await runSparkDaemonControlCommand(paths, classified.kind, classified.argv, io);
      case "workspace": {
        const [subcommand, ...rest] = classified.argv;
        return await workspace(paths, subcommand, rest, io);
      }
      case "uplink": {
        const [subcommand, ...rest] = classified.argv;
        return await uplink(paths, subcommand, rest, io);
      }
      case "daemon": {
        const [subcommand, ...rest] = classified.argv;
        return await daemon(paths, subcommand, rest, io);
      }
      default: {
        const exhaustive: never = classified;
        return exhaustive;
      }
    }
  } catch (error) {
    if (
      error instanceof WorkspacePathConflictError ||
      error instanceof WorkspacePathValidationError ||
      error instanceof RegistrationGrantRefusedError ||
      error instanceof DeviceAuthorizationError
    ) {
      writeSparkDaemonCliError(io, error, {
        code: "DAEMON_REQUEST_REJECTED",
        title: "Spark daemon rejected the request",
        hints: ['Run the selected command with "--help" and correct the reported input.'],
        exitCode: 3,
      });
      return 3;
    }
    if (error instanceof SparkDaemonUnavailableError || error instanceof LocalRpcUnavailableError) {
      writeSparkDaemonCliError(io, error, {
        code: "DAEMON_UNAVAILABLE",
        title: "Spark daemon is unavailable",
        hints: [
          'Run "spark daemon status" to inspect the service.',
          'Run "spark daemon logs --lines 100" for startup details.',
        ],
        exitCode: 2,
      });
      return 2;
    }
    writeSparkDaemonCliError(io, error, {
      code: "DAEMON_COMMAND_FAILED",
      title: "Spark daemon command failed",
    });
    return 1;
  }
}

async function providerAuth(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h" ||
    helpRequested(args)
  ) {
    printProviderAuthHelp(io);
    return 0;
  }

  if (subcommand === undefined || subcommand === "status") {
    if (args.some((arg) => arg !== "--json")) return providerAuthUsageError(io);
    return await providerAuthStatus(paths, io, args.includes("--json"));
  }
  if (subcommand === "login") {
    if (args.some((arg) => arg.startsWith("--")) || positionalArgs(args).length > 1) {
      return providerAuthUsageError(io);
    }
    return await providerAuthLogin(paths, positionalArgs(args)[0], io);
  }
  if (subcommand === "logout") {
    const flags = parseFlags(args);
    const positionals = positionalArgs(args);
    if (args.some((arg) => arg.startsWith("--") && arg !== "--json") || positionals.length !== 1) {
      return providerAuthUsageError(io);
    }
    const result = await requestProviderAuthService(paths, io, () =>
      requestProviderAuthLogout(paths, positionals[0]!),
    );
    if (flags.json === "true") {
      io.stdout.write(`${JSON.stringify({ provider: positionals[0], ...result }, null, 2)}\n`);
    } else {
      io.stdout.write(
        result.removed
          ? `Removed stored credentials for ${positionals[0]}.\n`
          : `No stored credentials found for ${positionals[0]}.\n`,
      );
    }
    return 0;
  }
  if (subcommand !== "import") return providerAuthUsageError(io);

  const flags = parseFlags(args);
  const positionals = positionalArgs(args);
  const unknownFlag = args.find(
    (arg) => arg.startsWith("--") && arg !== "--overwrite" && arg !== "--json",
  );
  if (unknownFlag || positionals.length !== 1 || positionals[0] !== "pi") {
    return providerAuthUsageError(io);
  }

  const sourcePath = resolvePiAuthSourcePath();
  const displaySourcePath = authPathForDisplay(sourcePath);
  try {
    const report = await requestProviderAuthService(
      paths,
      io,
      () =>
        (io.providerAuthImportPiInService ?? requestProviderAuthImportPi)(paths, {
          sourcePath,
          overwrite: flags.overwrite === "true",
        }),
      io.providerAuthImportPiInService !== undefined,
    );
    renderProviderAuthImportReport(io, report, flags.json === "true");
    return 0;
  } catch (error) {
    const message = safeProviderAuthImportError(error, displaySourcePath);
    if (flags.json === "true") {
      io.stderr.write(
        `${JSON.stringify(
          {
            source: "pi",
            sourcePath: displaySourcePath,
            error: { code: "AUTH_IMPORT_FAILED", message },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      writeSparkDaemonCliError(io, new Error(message), {
        code: "AUTH_IMPORT_FAILED",
        title: "Provider credential import failed",
      });
    }
    return 1;
  }
}

async function requestProviderAuthService<T>(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  request: () => Promise<T>,
  injected = false,
): Promise<T> {
  if (injected) return await request();
  return await requestWorkspaceService(paths, io, request);
}

async function providerAuthStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  json: boolean,
): Promise<number> {
  const snapshot = await requestProviderAuthService(paths, io, () =>
    requestProviderAuthSnapshot(paths),
  );
  if (json) {
    io.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }
  io.stdout.write("Spark provider authentication\n");
  if (snapshot.providers.length === 0) {
    io.stdout.write("  No providers registered.\n");
    return 0;
  }
  for (const provider of snapshot.providers) {
    io.stdout.write(
      `  ${provider.providerName}  ${provider.auth.configured ? "configured" : "missing"}  ${provider.auth.source ?? provider.auth.kind}\n`,
    );
  }
  return 0;
}

async function providerAuthLogin(
  paths: ReturnType<typeof resolveSparkPaths>,
  requestedProvider: string | undefined,
  io: CliIo,
): Promise<number> {
  const snapshot = await requestProviderAuthService(paths, io, () =>
    requestProviderAuthSnapshot(paths),
  );
  const configurable = snapshot.providers.filter(
    (provider) => provider.auth.kind === "oauth" || provider.auth.kind === "api_key",
  );
  const provider = requestedProvider
    ? configurable.find((entry) => entry.providerName === requestedProvider)
    : configurable.length === 1
      ? configurable[0]
      : undefined;
  if (!provider) {
    const available = configurable.map((entry) => entry.providerName).join(", ") || "none";
    throw new Error(
      requestedProvider
        ? `Unknown or non-configurable Spark provider "${requestedProvider}". Available: ${available}.`
        : `Select a Spark provider: ${available}.`,
    );
  }

  if (provider.auth.kind !== "oauth") {
    const apiKey = await promptSecret(io, `${provider.providerName} API key`);
    await requestProviderAuthService(paths, io, () =>
      requestProviderAuthSetApiKey(paths, {
        providerName: provider.providerName,
        apiKey,
      }),
    );
    io.stdout.write(`Stored API key for ${provider.providerName}.\n`);
    return 0;
  }

  let flow = await requestProviderAuthService(paths, io, () =>
    requestProviderAuthOAuthStart(paths, provider.providerName),
  );
  const seen = { auth: false, deviceCode: false, progress: 0 };
  try {
    while (true) {
      publishProviderOAuthProgress(flow, seen, io);
      if (flow.status === "succeeded") {
        io.stdout.write(`OAuth login completed for ${provider.providerName}.\n`);
        return 0;
      }
      if (flow.status === "failed") {
        throw new Error(
          `OAuth login failed for ${provider.providerName}: ${flow.error ?? "unknown error"}`,
        );
      }
      if (flow.status === "cancelled") {
        io.stdout.write(`OAuth login cancelled for ${provider.providerName}.\n`);
        return 1;
      }
      if (flow.prompt) {
        const value = await collectProviderOAuthPrompt(flow.prompt, io);
        flow = await requestProviderAuthService(paths, io, () =>
          requestProviderAuthOAuthRespond(paths, {
            flowId: flow.id,
            promptId: flow.prompt!.id,
            value,
          }),
        );
        continue;
      }
      const pollMs = Math.max(
        100,
        Math.min(2_000, (flow.deviceCode?.intervalSeconds ?? 1) * 1_000),
      );
      await delay(pollMs);
      flow = await requestProviderAuthService(paths, io, () =>
        requestProviderAuthOAuthStatus(paths, flow.id),
      );
    }
  } catch (error) {
    if (flow.status !== "succeeded" && flow.status !== "failed" && flow.status !== "cancelled") {
      await requestProviderAuthService(paths, io, () =>
        requestProviderAuthOAuthCancel(paths, flow.id),
      );
    }
    throw error;
  }
}

function publishProviderOAuthProgress(
  flow: SparkAuthFlow,
  seen: { auth: boolean; deviceCode: boolean; progress: number },
  io: CliIo,
): void {
  if (flow.authorization && !seen.auth) {
    io.stdout.write(`Open ${flow.authorization.url}\n`);
    if (flow.authorization.instructions) io.stdout.write(`${flow.authorization.instructions}\n`);
    seen.auth = true;
  }
  if (flow.deviceCode && !seen.deviceCode) {
    io.stdout.write(
      `Device code ${flow.deviceCode.userCode} at ${flow.deviceCode.verificationUri}\n`,
    );
    seen.deviceCode = true;
  }
  for (const message of flow.progress.slice(seen.progress)) {
    io.stdout.write(`OAuth: ${message}\n`);
  }
  seen.progress = flow.progress.length;
}

async function collectProviderOAuthPrompt(
  prompt: NonNullable<SparkAuthFlow["prompt"]>,
  io: CliIo,
): Promise<string> {
  if (prompt.kind === "select") {
    io.stdout.write(`${prompt.message}\n`);
    for (const option of prompt.options ?? []) {
      io.stdout.write(`  ${option.id}  ${option.label}\n`);
    }
    return await promptWithDefault(io, "Selection", prompt.options?.[0]?.id);
  }
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY)
    throw new Error(`OAuth provider requested interactive input: ${prompt.message}`);
  const reader = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await reader.question(`${prompt.message}: `);
    if (!answer && prompt.allowEmpty !== true) {
      throw new Error("OAuth prompt response must be non-empty.");
    }
    return answer;
  } finally {
    reader.close();
  }
}

function printProviderAuthHelp(io: CliIo): void {
  io.stdout.write(
    "Usage:\n" +
      "  spark daemon auth status [--json]\n" +
      "  spark daemon auth login [provider]\n" +
      "  spark daemon auth logout <provider> [--json]\n" +
      "  spark daemon auth import pi [--overwrite] [--json]\n\n" +
      "Provider credentials are separate from `spark daemon login`, which authorizes machine connectivity to Hub.\n" +
      "Pi import never executes Pi, environment references, or shell commands.\n",
  );
}

function providerAuthUsageError(io: CliIo): number {
  return writeSparkDaemonUsageError(io, "Invalid provider authentication command", [
    "Usage: spark daemon auth <status|login|logout|import>",
    'Run "spark daemon auth --help" to see the supported commands.',
  ]);
}

function renderProviderAuthImportReport(
  io: CliIo,
  report: SparkAuthImportReport,
  json: boolean,
): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  io.stdout.write(`Pi auth import from ${report.sourcePath}\n`);
  for (const entry of report.imported) {
    io.stdout.write(`  imported    ${entry.provider} (${entry.type})\n`);
  }
  for (const entry of report.overwritten) {
    io.stdout.write(`  overwritten ${entry.provider} (${entry.type})\n`);
  }
  for (const entry of report.skipped) {
    io.stdout.write(
      `  skipped     ${entry.provider}${entry.type ? ` (${entry.type})` : ""}: ${entry.reason}\n`,
    );
  }
  io.stdout.write(
    `Imported ${report.totals.imported}, overwritten ${report.totals.overwritten}, skipped ${report.totals.skipped}.\n`,
  );
}

function safeProviderAuthImportError(error: unknown, sourcePath: string): string {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "ENOENT") return `Pi auth file was not found at ${sourcePath}.`;
  if (code === "EACCES" || code === "EPERM") {
    return `Pi auth file could not be read at ${sourcePath}.`;
  }
  if (
    error instanceof Error &&
    (error.message === "Pi auth file contains invalid JSON" ||
      error.message === "Pi auth file root must be a JSON object")
  ) {
    return error.message;
  }
  if (
    error instanceof Error &&
    error.message.startsWith("Refusing to overwrite unreadable Spark auth store:")
  ) {
    return "Spark auth store could not be read; no credentials were imported.";
  }
  return `Pi auth import failed for ${sourcePath}.`;
}

function authPathForDisplay(path: string): string {
  const home = resolve(homedir());
  const relativeToHome = relative(home, path);
  return relativeToHome === ".." || relativeToHome.startsWith("../") || isAbsolute(relativeToHome)
    ? path
    : relativeToHome
      ? join("~", relativeToHome)
      : "~";
}

async function login(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (helpRequested(args)) {
    printLoginHelp(io);
    return 0;
  }
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const current = readSparkDaemonConfig(paths);
  const profiles = listSparkDaemonServerProfiles(paths);
  const registrationDefault =
    profiles.length === 1 ? sparkDaemonConfigForServerProfile(current, profiles[0]!) : current;
  const serverUrl = await resolveRegistrationServerUrl(flags, registrationDefault, io);
  const deviceIdentity = {
    serverUrl,
    installationId: current.installationId,
    displayName: current.displayName,
    ...(flags["allow-insecure-http"] === "true" ? { allowInsecureHttp: true } : {}),
  };
  const authorization = await startSparkDaemonDeviceAuthorization(paths, deviceIdentity);

  io.stdout.write(
    `${STRINGS.deviceAuthorizationVerification(authorization.verificationUri, authorization.userCode)}\n`,
  );
  if (flags["no-open"] !== "true") {
    const opened = (io.openExternal ?? openExternalUrl)(authorization.verificationUriComplete);
    if (!opened) {
      io.stdout.write(
        `${STRINGS.deviceAuthorizationOpenFailed(authorization.verificationUriComplete)}\n`,
      );
    }
  }
  io.stdout.write(`${STRINGS.deviceAuthorizationWaiting}\n`);

  const registered = await completeSparkDaemonDeviceAuthorization(
    paths,
    { ...deviceIdentity, authorization },
    io.deviceAuthorizationSleep ? { sleep: io.deviceAuthorizationSleep } : {},
  );
  io.stdout.write(`${STRINGS.deviceAuthorizationSucceeded(registered.runtimeId, serverUrl)}\n`);
  return 0;
}

function openExternalUrl(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!command) {
    return false;
  }
  const result = spawnSync(command, [url.toString()], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function install(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo): number {
  prepareSparkDaemonState(paths);
  const config = existsSync(paths.configFile)
    ? readSparkDaemonConfig(paths)
    : defaultSparkDaemonConfig();
  writeSparkDaemonConfig(paths, config);
  io.stdout.write(`Installed Spark daemon at ${paths.dataDir}\n`);
  return 0;
}

function configForHubServer(
  paths: ReturnType<typeof resolveSparkPaths>,
  identity: ReturnType<typeof readSparkDaemonConfig>,
  serverUrl: string,
) {
  const profile = getSparkDaemonServerProfile(paths, serverUrl);
  return profile ? sparkDaemonConfigForServerProfile(identity, profile) : identity;
}

function serverProfileStatus(
  identity: ReturnType<typeof readSparkDaemonConfig>,
  profile: SparkDaemonServerProfile,
) {
  const config = sparkDaemonConfigForServerProfile(identity, profile);
  return {
    serverUrl: profile.serverUrl,
    runtimeId: profile.runtimeId,
    enrolled: Boolean(profile.runtimeId && profile.runtimeToken),
    runnable: hasRunnableSparkDaemonCredentialsForServer(config, profile.serverUrl),
    runtimeTokenExpiresAt: profile.runtimeTokenExpiresAt,
    refreshTokenExpiresAt: profile.refreshTokenExpiresAt,
  };
}

async function doctor(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (args.some((arg) => arg !== "--json")) {
    return writeSparkDaemonUsageError(io, "Invalid spark daemon doctor options", [
      'The command accepts only the optional "--json" flag.',
      'Run "spark daemon doctor --help" for usage.',
    ]);
  }
  const report = await buildDoctorReport(paths, io);
  io.stdout.write(
    args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorText(report),
  );
  return 0;
}

async function buildDoctorReport(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
): Promise<DoctorReport> {
  prepareSparkDaemonState(paths);
  const config = readSparkDaemonConfig(paths);
  const profiles = listSparkDaemonServerProfiles(paths);
  const daemon = await buildDaemonStatus(paths, io);
  const workspace = await buildDoctorWorkspaceStatus(paths, io, daemon);
  const credentialServers = profiles.map((profile) => serverProfileStatus(config, profile));
  const credentialsOk =
    credentialServers.length > 0 && credentialServers.every((server) => server.runnable);
  const primary = profiles[0];
  const hub = buildDoctorHubStatus();
  return {
    version: sparkDaemonVersion,
    checks: {
      daemon: {
        ok: daemon.running === true,
        running: daemon.running,
        socketPath: daemon.socketPath,
        ...(daemon.running ? { invocations: daemon.invocations } : {}),
        ...("unreachable" in daemon && daemon.unreachable
          ? { unreachable: true, error: daemon.error }
          : {}),
      },
      credentials: {
        ok: credentialsOk,
        enrolled: credentialServers.some((server) => server.enrolled),
        servers: credentialServers,
      },
      workspace,
      hub,
    },
    paths,
    config: {
      installationId: config.installationId,
      displayName: config.displayName,
      // Retain the single-server fields as a compatibility projection when
      // exactly one profile exists; `servers` is authoritative.
      serverUrl: profiles.length === 1 ? primary?.serverUrl : undefined,
      runtimeId: profiles.length === 1 ? primary?.runtimeId : undefined,
      runtimeTokenExpiresAt: profiles.length === 1 ? primary?.runtimeTokenExpiresAt : undefined,
      refreshTokenExpiresAt: profiles.length === 1 ? primary?.refreshTokenExpiresAt : undefined,
      enrolled: credentialServers.some((server) => server.enrolled),
      servers: credentialServers,
    },
  };
}

type DoctorReport = {
  version: string;
  checks: {
    daemon: {
      ok: boolean;
      running: boolean | undefined;
      socketPath: string;
      invocations?: {
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
        cancelled: number;
      };
      unreachable?: boolean;
      error?: string;
    };
    credentials: {
      ok: boolean;
      enrolled: boolean;
      servers: Array<{ runnable: boolean }>;
    };
    workspace: Record<string, unknown>;
    hub: Record<string, unknown>;
  };
  paths: ReturnType<typeof resolveSparkPaths>;
  config: {
    installationId: string;
    displayName: string;
    serverUrl?: string;
    runtimeId?: string;
    runtimeTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
    enrolled: boolean;
    servers: unknown[];
  };
};

function renderDoctorText(report: DoctorReport): string {
  const { daemon, credentials, workspace, hub } = report.checks;
  const daemonDetail = daemon.running
    ? `running, socket ${daemon.socketPath}, ${daemon.invocations?.running ?? 0} running / ${daemon.invocations?.queued ?? 0} queued invocations`
    : (daemon.error ?? `not running (socket ${daemon.socketPath})`);
  const credentialsDetail = credentials.enrolled
    ? `${credentials.servers.filter((server) => server.runnable).length}/${credentials.servers.length} servers runnable`
    : "not enrolled";
  const workspaceDetail =
    typeof workspace.detail === "string"
      ? workspace.detail
      : workspace.reachable === true
        ? `${typeof workspace.workspaces === "number" ? workspace.workspaces : 0} workspaces`
        : typeof workspace.error === "string"
          ? workspace.error
          : "unreachable";
  const hubDetail =
    [
      hub.packageAvailable === true ? "package available" : undefined,
      hub.commandAvailable === true && typeof hub.command === "string"
        ? `${hub.command} on PATH`
        : undefined,
    ]
      .filter(Boolean)
      .join(", ") || (typeof hub.error === "string" ? hub.error : "unavailable");
  return (
    [
      `Spark ${report.version}`,
      checkLine("daemon", daemon.ok, daemonDetail),
      checkLine("credentials", credentials.ok, credentialsDetail),
      checkLine("workspace", workspace.ok === true, workspaceDetail),
      checkLine("hub", hub.ok === true, hubDetail),
      `config: ${report.paths.configFile} (${report.config.installationId}, ${report.config.displayName})`,
    ].join("\n") + "\n"
  );
}

function checkLine(label: string, ok: boolean, detail: string): string {
  return `${label}: ${ok ? "ok" : "FAIL"} — ${detail}`;
}

async function buildDoctorWorkspaceStatus(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  daemon: DaemonStatus,
): Promise<Record<string, unknown>> {
  if (!daemon.running) {
    return {
      ok: false,
      reachable: false,
      workspaces: 0,
      detail: "Spark daemon is not running; workspace state was not queried.",
    };
  }
  try {
    const result = await (io.listWorkspacesFromService ?? requestWorkspaceList)(paths);
    return {
      ok: true,
      reachable: true,
      workspaces: result.workspaces.length,
      observedAt: result.observedAt,
    };
  } catch (error) {
    return { ok: false, reachable: false, workspaces: 0, error: errorMessage(error) };
  }
}

function errorCode(error: Error | undefined): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function buildDoctorHubStatus(): Record<string, unknown> {
  const packagePath = fileURLToPath(new URL("../../spark-hub/package.json", import.meta.url));
  const packageAvailable = existsSync(packagePath);
  const command = "spark-hub";
  const commandProbe = spawnSync(command, ["--help"], { stdio: "ignore", timeout: 1_000 });
  const commandErrorCode = errorCode(commandProbe.error);
  const commandAvailable = !commandProbe.error || commandErrorCode !== "ENOENT";
  return {
    ok: packageAvailable || commandAvailable,
    packageAvailable,
    command,
    commandAvailable,
    ...(commandProbe.error && commandErrorCode !== "ENOENT"
      ? { error: commandProbe.error.message }
      : {}),
  };
}

async function status(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (args.some((arg) => arg !== "--json")) {
    return writeSparkDaemonUsageError(io, "Invalid spark daemon status options", [
      'The command accepts only the optional "--json" flag.',
      'Run "spark daemon status --help" for usage.',
    ]);
  }
  const report = await buildStatusReport(paths, io);
  io.stdout.write(
    args.includes("--json")
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderDaemonStatusText(report),
  );
  return 0;
}

async function buildStatusReport(paths: ReturnType<typeof resolveSparkPaths>, io: CliIo) {
  prepareSparkDaemonState(paths);
  const config = readSparkDaemonConfig(paths);
  const profiles = listSparkDaemonServerProfiles(paths);
  const credentialServers = profiles.map((profile) => serverProfileStatus(config, profile));
  const primary = profiles[0];
  const daemon = await buildDaemonStatus(paths, io);
  const workspaceCount = daemon.running
    ? daemon.servers.reduce((sum, server) => sum + server.workspaceCount, 0)
    : 0;
  return {
    action: "status" as const,
    daemon,
    enrolled: credentialServers.some((server) => server.enrolled),
    runtimeId: profiles.length === 1 ? primary?.runtimeId : undefined,
    serverUrl: profiles.length === 1 ? primary?.serverUrl : undefined,
    runtimeTokenExpiresAt: profiles.length === 1 ? primary?.runtimeTokenExpiresAt : undefined,
    refreshTokenExpiresAt: profiles.length === 1 ? primary?.refreshTokenExpiresAt : undefined,
    servers: credentialServers.map((server) => ({
      ...server,
      ...(daemon.running
        ? {
            connection: daemon.servers.find((current) => current.url === server.serverUrl) ?? null,
          }
        : {}),
    })),
    workspaceCount,
    daemonRunning: daemon.running,
    invocations: daemon.running ? daemon.invocations : undefined,
    lifecycle: daemon.running ? daemon.lifecycle : undefined,
    pidFile: paths.pidFile,
  };
}

type DaemonStatusReport = Awaited<ReturnType<typeof buildStatusReport>>;

function renderDaemonStatusText(report: DaemonStatusReport): string {
  const lines: string[] = [];
  if (report.daemon.running) {
    const daemon = report.daemon;
    lines.push(`daemon: running (pid ${daemon.pid}, socket ${daemon.socketPath})`);
    if (daemon.lifecycle?.state) lines.push(`lifecycle: ${daemon.lifecycle.state}`);
    if (daemon.build.runningVersion ?? daemon.build.availableVersion) {
      lines.push(
        `build: ${daemon.build.runningVersion ?? daemon.build.availableVersion}${daemon.build.updateAvailable ? ` (update available: ${daemon.build.availableVersion})` : ""}`,
      );
    }
  } else if ("unreachable" in report.daemon && report.daemon.unreachable) {
    lines.push(`daemon: unreachable (pid ${report.daemon.pid}) — ${report.daemon.error}`);
  } else {
    lines.push(`daemon: not running (socket ${report.daemon.socketPath})`);
  }
  const connected = report.servers.filter(
    (server) => server.connection?.wsConnected === true,
  ).length;
  lines.push(
    `servers: ${report.servers.filter((server) => server.enrolled).length} enrolled, ${connected} connected`,
  );
  lines.push(`workspaces: ${report.workspaceCount}`);
  if (report.invocations) {
    lines.push(
      `invocations: ${report.invocations.running} running, ${report.invocations.queued} queued`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function workspace(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printWorkspaceHelp(io);
    return 0;
  }
  if (helpRequested(args)) {
    printWorkspaceHelp(io);
    return 0;
  }

  prepareSparkDaemonState(paths);
  if (subcommand === undefined || subcommand === "ls" || subcommand === "list") {
    return await listWorkspaceCommand(paths, args, io);
  }

  if (subcommand.startsWith("-")) {
    return await listWorkspaceCommand(paths, [subcommand, ...args], io);
  }

  if (subcommand === "stop") {
    const code = await stopWorkspaceCommand(paths, args, io);
    if (code === 0 && !workspaceSkipPostStopSync(parseFlags(args))) {
      syncSparkDaemonIfConfigured(paths, io);
    }
    return code;
  }

  if (subcommand === "unregister" || subcommand === "move" || subcommand === "merge") {
    return await mutateWorkspaceLifecycleCommand(paths, subcommand, args, io);
  }

  if (subcommand === "show") {
    return await showWorkspaceCommand(paths, args, io);
  }

  if (subcommand === "register") {
    return await registerWorkspaceCommand(paths, args, io);
  }

  if (subcommand === "relocate") {
    return await relocateWorkspaceCommand(paths, args, io);
  }

  if (subcommand === "migrate-evidence") {
    return await migrateEvidenceWorkspaceCommand(paths, args, io);
  }

  throw new Error(
    "Usage: spark daemon workspace <register|relocate|migrate-evidence|ls|show|stop|unregister|move|merge>",
  );
}

async function registerWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const explicitPathArg = flags.path ?? positionalArgs(args)[0];
  const scripted = isScriptedWorkspaceRegistration(flags);
  const interactive = !scripted && explicitPathArg === undefined;
  const pathArg = explicitPathArg ?? (scripted ? "." : await promptWorkspacePath(io));
  const localPath = resolveWorkspacePath(pathArg);
  assertDirectory(localPath);

  const wantsHubAnnounce = Boolean(registrationToken(flags) || flags.token === "-");
  if ((flags["server-url"] || flags.server) && !wantsHubAnnounce) {
    throw new Error(
      "Hub origin is owned by this daemon. Run spark daemon login --server-url <url>. Pass --token to announce a Hub projection.",
    );
  }
  const serverUrl = wantsHubAnnounce
    ? await resolveWorkspaceAnnounceServerUrl(paths, flags)
    : undefined;
  const registrationTokenValue = wantsHubAnnounce
    ? await resolveRegistrationToken(flags, io, {
        interactive,
      })
    : undefined;
  if (serverUrl && !registrationTokenValue) {
    throw new Error(STRINGS.workspaceTokenRequired(serverUrl));
  }
  const displayName =
    flags.name ?? (interactive ? await promptWorkspaceName(localPath, io) : undefined);
  const workspaceOptions: WorkspaceRegistrationRequest = {
    localPath,
    ...(serverUrl ? { serverUrl } : {}),
    ...(flags["allow-insecure-http"] === "true" ? { allowInsecureHttp: true } : {}),
    ...(registrationTokenValue ? { registrationToken: registrationTokenValue } : {}),
    ...(flags.key || flags["local-key"]
      ? { localWorkspaceKey: flags.key ?? flags["local-key"] }
      : {}),
    ...(displayName ? { displayName } : {}),
    ...(flags["workspace-name"] ? { workspaceName: flags["workspace-name"] } : {}),
    ...(flags["workspace-slug"] ? { workspaceSlug: flags["workspace-slug"] } : {}),
  };
  preflightWorkspaceRegistration(paths, workspaceOptions);
  const profile = await resolveWorkspaceProfile(localPath, flags, io, {
    allowDetectedPrompt: interactive,
  });
  if (profile) workspaceOptions.profile = profile;
  const added = await registerWorkspaceForCli(paths, workspaceOptions, io);
  io.stdout.write(
    `✓ workspace '${added.displayName}' registered\n` +
      `  path     ${formatPathForDisplay(added.localPath)}\n` +
      `  server   ${added.serverUrl || "—"}\n` +
      profileTextLine(added.profile) +
      `  status   ${workspaceStatusLabel(added)}\n` +
      (serverUrl ? workspaceAuthorizationText(added, serverUrl) : "") +
      (added.serverUrl
        ? `  note     Hub can unbind this projection; rerun workspace register to bind it again.\n`
        : `  note     Local daemon workspace. Hub projection is scheduled by daemon login/uplink.\n`),
  );

  if (readRunningPid(paths) !== null) {
    io.stdout.write("Spark daemon is running.\n");
  }
  return 0;
}

function preflightWorkspaceRegistration(
  paths: ReturnType<typeof resolveSparkPaths>,
  options: WorkspaceRegistrationRequest,
): void {
  if (!existsSync(paths.databasePath)) return;

  // The daemon is the only writer for daemon-local state. The CLI may inspect
  // an existing schema to reject obvious conflicts before starting the
  // service, but it must not apply PRAGMAs or schema migrations itself.
  const db = new DatabaseSync(paths.databasePath, { readOnly: true });
  try {
    const { registrationToken, ...registration } = options;
    planWorkspaceRegistration(db, {
      ...registration,
      ...(registrationToken ? { allowLocalPathRebind: true } : {}),
    });
  } finally {
    db.close();
  }
}

function workspaceAuthorizationText(workspace: SparkDaemonWorkspace, serverUrl: string): string {
  const authorization = workspace.workspaceAuthorization;
  if (!authorization) return "";
  const loginUrl = new URL(`/${encodeURIComponent(authorization.workspaceSlug)}/login`, serverUrl);
  return (
    `  authorize ${loginUrl.toString()}\n` +
    `  one-time ${authorization.oneTimeToken}\n` +
    `  expires  ${authorization.expiresAt}\n` +
    `  note     Additional browsers: spark hub workspace access create --workspace ${authorization.workspaceId}\n`
  );
}

async function uplink(
  paths: ReturnType<typeof resolveSparkPaths>,
  subcommand: string | undefined,
  args: string[],
  io: CliIo,
): Promise<number> {
  if (
    helpRequested(args) ||
    subcommand === "help" ||
    subcommand === "--help" ||
    subcommand === "-h"
  ) {
    printUplinkHelp(io);
    return 0;
  }
  prepareSparkDaemonState(paths);
  if (subcommand === "park") {
    return await uplinkParkCommand(paths, args, io);
  }
  if (subcommand === "unpark") {
    return await uplinkUnparkCommand(paths, args, io);
  }
  if (subcommand === "prefer") {
    return await uplinkPreferCommand(paths, args, io);
  }
  if (subcommand === "status" || subcommand === undefined) {
    return await uplinkStatusCommand(paths, args, io);
  }
  throw new Error("Usage: spark daemon uplink <park|unpark|prefer|status>");
}

async function uplinkParkCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"] ?? positionalArgs(args)[0];
  if (!serverUrl) {
    throw new Error("Usage: spark daemon uplink park --server-url <origin>");
  }
  const profile = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { parkUplinkInService?: typeof requestUplinkPark }).parkUplinkInService ??
      requestUplinkPark
    )(paths, { serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-park", profile }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`✓ Uplink parked for ${serverUrl}\n`);
  return 0;
}

async function uplinkUnparkCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"] ?? positionalArgs(args)[0];
  if (!serverUrl) {
    throw new Error("Usage: spark daemon uplink unpark --server-url <origin>");
  }
  const profile = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { unparkUplinkInService?: typeof requestUplinkUnpark }).unparkUplinkInService ??
      requestUplinkUnpark
    )(paths, { serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-unpark", profile }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`✓ Uplink unparked for ${serverUrl}\n`);
  return 0;
}

async function uplinkPreferCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const serverUrl = flags["server-url"];
  const workspace = flags.workspace ?? positionalArgs(args)[0];
  if (!serverUrl || !workspace) {
    throw new Error("Usage: spark daemon uplink prefer --workspace <id> --server-url <origin>");
  }
  const preferred = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { preferUplinkInService?: typeof requestUplinkPrefer }).preferUplinkInService ??
      requestUplinkPrefer
    )(paths, { workspace, serverUrl }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify({ action: "uplink-prefer", preferred }, null, 2)}\n`);
    return 0;
  }
  const row = preferred as {
    previousServerUrl?: string;
    serverUrl?: string;
    workspace?: { displayName?: string };
  };
  io.stdout.write(
    `✓ Workspace preferred onto ${row.serverUrl ?? serverUrl}\n` +
      `  workspace ${row.workspace?.displayName ?? workspace}\n` +
      `  previous  ${row.previousServerUrl ?? "—"}\n`,
  );
  return 0;
}

async function uplinkStatusCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const status = await requestWorkspaceService(paths, io, async () =>
    (
      (io as { uplinkStatusInService?: typeof requestUplinkStatus }).uplinkStatusInService ??
      requestUplinkStatus
    )(paths),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  const payload = status as {
    origins?: Array<{
      serverUrl: string;
      parked: boolean;
      desired: boolean;
      runnable: boolean;
      workspaceCount: number;
    }>;
  };
  const origins = payload.origins ?? [];
  if (origins.length === 0) {
    io.stdout.write("No Hub uplink profiles.\n");
    return 0;
  }
  for (const origin of origins) {
    io.stdout.write(
      `${origin.serverUrl}  parked=${origin.parked}  desired=${origin.desired}  runnable=${origin.runnable}  workspaces=${origin.workspaceCount}\n`,
    );
  }
  return 0;
}

async function relocateWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const toServerUrl = flags["to-server-url"] ?? flags.to ?? positionalArgs(args)[0];
  if (!toServerUrl) {
    throw new Error("Workspace relocation requires --to-server-url <https-origin>.");
  }
  if (!(await confirmAction(io, flags, `Relocate Hub uplink to ${toServerUrl}?`))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }
  const result = await requestWorkspaceService(
    paths,
    io,
    async () =>
      await (io.relocateWorkspaceInService ?? requestWorkspaceRelocate)(paths, {
        toServerUrl,
        ...(flags["from-server-url"] ? { fromServerUrl: flags["from-server-url"] } : {}),
      }),
  );
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(
    `✓ Hub uplink relocated\n` +
      `  instance   ${result.instanceId}\n` +
      `  runtime    ${result.runtimeId}\n` +
      `  from       ${result.fromServerUrl}\n` +
      `  to         ${result.toServerUrl}\n` +
      `  workspaces ${result.workspaceCount}\n` +
      `  bindings   ${result.workspaceBindingIds.join(", ") || "none"}\n`,
  );
  return 0;
}

async function defaultWorkspace(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  prepareSparkDaemonState(paths);
  const flags = parseFlags(args);
  const workspaces = await loadWorkspaceList(paths, io);
  if (workspaces.length === 0) {
    io.stdout.write("no workspaces registered.\n  spark daemon workspace register . --name <ws>\n");
    return 0;
  }

  const explicitWorkspace = flags.workspace;
  const cwd = resolveInvocationCwd();
  const workspace = explicitWorkspace
    ? resolveWorkspace(workspaces, explicitWorkspace)
    : resolveWorkspaceForCwd(workspaces, cwd);
  if (!workspace) {
    io.stdout.write(
      `${cwd} is not under a registered workspace.\n` +
        "  spark daemon workspace register . --name <ws>\n" +
        "or cd into a registered workspace, or pass --workspace <id>.\n",
    );
    return 2;
  }

  assertDirectory(workspace.localPath);
  const config = readSparkDaemonConfig(paths);
  if (workspace.serverUrl) {
    const serverConfig = configForHubServer(paths, config, workspace.serverUrl);
    if (!hasRunnableSparkDaemonCredentialsForServer(serverConfig, workspace.serverUrl)) {
      throw new Error(
        `Workspace '${workspace.displayName}' is bound on this daemon, but Hub credentials for ${workspace.serverUrl} are missing. Run spark daemon login --server-url ${shellQuote(workspace.serverUrl)}, then retry.`,
      );
    }
  }

  const wasDetached = isUserDetachedWorkspace(workspace);
  const ready = wasDetached ? await attachWorkspaceForCli(paths, workspace.id, io) : workspace;
  io.stdout.write(
    `${wasDetached ? "✓ re-attached" : "✓ workspace"} '${ready.displayName}' ready\n` +
      `  path     ${formatPathForDisplay(ready.localPath)}\n` +
      `  status   ${workspaceStatusLabel(ready)}\n`,
  );

  io.stdout.write("Spark daemon is running.\n");
  await startWorkspaceShell(paths, ready, io);
  return 0;
}

async function listWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const workspaces = await loadWorkspaceList(paths, io, {
    includeInactive: flags.all === "true",
  });
  const statusContext = workspaceStatusContext(paths);
  if (flags.json === "true") {
    io.stdout.write(
      `${JSON.stringify(
        workspaces.map((workspace) => workspaceListItem(workspace, statusContext)),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (workspaces.length === 0) {
    io.stdout.write("no workspaces registered.\n  spark daemon workspace register . --name <ws>\n");
    return 0;
  }

  const idWidth = Math.max(37, ...workspaces.map((entry) => entry.id.length));
  io.stdout.write(
    `${padColumn("ID", idWidth)} ${padColumn("NAME", 20)} ${padColumn("SERVER", 30)} ${padColumn("STATUS", 24)} ${padColumn("PATH", 38)} ${padColumn("PROJECTS", 8)} ${padColumn("INBOX", 5)} LAST SESSION\n`,
  );
  for (const workspace of workspaces) {
    const listItem = workspaceListItem(workspace, statusContext);
    io.stdout.write(
      `${padColumn(workspace.id, idWidth)} ` +
        `${padColumn(truncateColumn(workspace.displayName, 20), 20)} ` +
        `${padColumn(formatServerForList(workspace.serverUrl, flags.full === "true"), 30)} ` +
        `${padColumn(workspaceStatusLabel(workspace, statusContext), 24)} ` +
        `${padColumn(formatPathForList(workspace.localPath, flags.full === "true"), 38)} ` +
        `${padColumn(countColumn(listItem.counts.projects), 8)} ` +
        `${padColumn(countColumn(listItem.counts.unresolvedInbox), 5)} ` +
        `${lastSessionColumn(listItem.lastSessionAt)}\n`,
    );
  }
  return 0;
}

type WorkspaceRegistrationRequest = RegisterWorkspaceOptions & {
  registrationToken?: string;
};

async function requestWorkspaceService<T>(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  request: () => Promise<T>,
): Promise<T> {
  let startedService = false;
  if (readRunningPid(paths) === null) {
    try {
      startSparkDaemonProcess(paths, io);
      startedService = true;
    } catch (error) {
      throw new SparkDaemonUnavailableError(error, { running: false });
    }
  }

  let attempts = startedService ? 20 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (isWorkspaceDomainError(error)) {
        throw error;
      }
      if (!(error instanceof LocalRpcUnavailableError)) {
        throw error;
      }
      lastError = error;
      if (!startedService && isMissingLocalRpcSocketError(paths, error)) {
        try {
          startSparkDaemonProcess(paths, io);
          startedService = true;
          attempts = 20;
        } catch (startError) {
          throw new SparkDaemonUnavailableError(startError, { running: false });
        }
      }
      if (attempt < attempts - 1) {
        await delay(100);
      }
    }
  }

  throw new SparkDaemonUnavailableError(lastError ?? "Spark daemon request failed");
}

function workspaceSkipPostStopSync(flags: Record<string, string>): boolean {
  return flags["no-service"] === "true" || flags["no-start"] === "true";
}

function isWorkspaceDomainError(error: unknown): boolean {
  return (
    error instanceof WorkspacePathConflictError || error instanceof RegistrationGrantRefusedError
  );
}

function isMissingLocalRpcSocketError(
  paths: ReturnType<typeof resolveSparkPaths>,
  error: unknown,
): boolean {
  const message = errorMessage(error);
  return message.includes("ENOENT") && message.includes(localRpcSocketPath(paths));
}

async function loadWorkspaceList(
  paths: ReturnType<typeof resolveSparkPaths>,
  io: CliIo,
  options: { includeInactive?: boolean } = {},
): Promise<SparkDaemonWorkspace[]> {
  return await requestWorkspaceService(paths, io, async () => {
    return (await (io.listWorkspacesFromService ?? requestWorkspaceList)(paths, options))
      .workspaces;
  });
}

async function registerWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  options: WorkspaceRegistrationRequest,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.registerWorkspaceInService ?? requestWorkspaceRegister)(paths, options);
  });
}

async function attachWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  id: string,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.attachWorkspaceInService ?? requestWorkspaceAttach)(paths, id);
  });
}

async function stopWorkspaceForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  id: string,
  io: CliIo,
): Promise<SparkDaemonWorkspace> {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.stopWorkspaceInService ?? requestWorkspaceStop)(paths, id);
  });
}

async function mutateWorkspaceLifecycleForCli(
  paths: ReturnType<typeof resolveSparkPaths>,
  mutation: LocalWorkspaceLifecycleMutation,
  io: CliIo,
) {
  return await requestWorkspaceService(paths, io, async () => {
    return await (io.mutateWorkspaceLifecycleInService ?? requestWorkspaceLifecycle)(
      paths,
      mutation,
    );
  });
}

async function mutateWorkspaceLifecycleCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  action: "unregister" | "move" | "merge",
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const positionals = positionalArgs(args);
  const workspaces = await loadWorkspaceList(paths, io, { includeInactive: true });
  let mutation: LocalWorkspaceLifecycleMutation;

  if (action === "unregister") {
    const identifier = flags.workspace ?? positionals[0];
    if (!identifier) throw new Error("Pass a workspace id or --workspace <id>.");
    mutation = {
      action,
      workspaceId: resolveWorkspace(workspaces, identifier).id,
      dryRun: true,
    };
  } else if (action === "move") {
    const identifier = flags.workspace ?? positionals[0];
    const localPath = flags.to ?? flags.path ?? positionals[1];
    if (!identifier || !localPath) {
      throw new Error("Usage: spark daemon workspace move <id> <path> [--yes] [--json]");
    }
    assertDirectory(localPath);
    mutation = {
      action,
      workspaceId: resolveWorkspace(workspaces, identifier).id,
      localPath,
      dryRun: true,
    };
  } else {
    const targetIdentifier = flags.into ?? flags.workspace;
    const localPath = flags.path ?? flags.to ?? resolveInvocationCwd();
    const allNested = flags["all-nested"] === "true";
    if (!targetIdentifier) {
      throw new Error(
        "Usage: spark daemon workspace merge [source ...] --into <target> --path <parent> [--all-nested] [--yes] [--json]",
      );
    }
    if (positionals.length === 0 && !allNested) {
      throw new Error("Pass at least one source workspace or --all-nested.");
    }
    assertDirectory(localPath);
    mutation = {
      action,
      targetWorkspaceId: resolveWorkspace(workspaces, targetIdentifier).id,
      sourceWorkspaceIds: positionals.map(
        (identifier) => resolveWorkspace(workspaces, identifier).id,
      ),
      localPath,
      ...(allNested ? { allNested: true } : {}),
      dryRun: true,
    };
  }

  const plan = await mutateWorkspaceLifecycleForCli(paths, mutation, io);
  if (flags["dry-run"] === "true") {
    if (flags.json === "true") {
      io.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      io.stdout.write(workspaceLifecycleMutationText(plan, true));
    }
    return 0;
  }

  const subject =
    action === "merge"
      ? `Merge ${plan.sources.length} workspace(s) into '${plan.workspace.displayName}' at ${formatPathForDisplay(plan.localPath)}?`
      : action === "move"
        ? `Move workspace '${plan.workspace.displayName}' to ${formatPathForDisplay(plan.localPath)}?`
        : `Unregister workspace '${plan.workspace.displayName}' while retaining its history?`;
  if (!(await confirmAction(io, flags, subject))) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const { dryRun: _dryRun, ...applyMutation } = mutation;
  const result = await mutateWorkspaceLifecycleForCli(paths, applyMutation, io);
  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(workspaceLifecycleMutationText(result, false));
  }
  return 0;
}

function workspaceLifecycleMutationText(
  result: Awaited<ReturnType<typeof requestWorkspaceLifecycle>>,
  dryRun: boolean,
): string {
  const prefix = dryRun ? "Plan" : "✓";
  if (result.action === "unregister") {
    return (
      `${prefix} unregister '${result.workspace.displayName}'\n` +
      `  path     ${formatPathForDisplay(result.localPath)}\n` +
      "  history  retained; inspect with workspace ls --all\n"
    );
  }
  if (result.action === "move") {
    return (
      `${prefix} move '${result.workspace.displayName}'\n` +
      `  from     ${formatPathForDisplay(result.previousLocalPath)}\n` +
      `  to       ${formatPathForDisplay(result.localPath)}\n`
    );
  }
  return (
    `${prefix} merge ${result.sources.length} workspace(s) into '${result.workspace.displayName}'\n` +
    `  path     ${formatPathForDisplay(result.localPath)}\n` +
    `  sources  ${result.sources.map((source) => source.displayName).join(", ")}\n` +
    "  history  source IDs remain aliases; inspect with workspace ls --all\n"
  );
}

async function showWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const identifier = flags.workspace ?? positionalArgs(args)[0];
  const workspaces = await loadWorkspaceList(paths, io, { includeInactive: Boolean(identifier) });
  let workspace = resolveWorkspaceForShow(workspaces, identifier);
  if (!workspace.lifecycle && isUserDetachedWorkspace(workspace)) {
    workspace = await attachWorkspaceForCli(paths, workspace.id, io);
  }
  const statusContext = workspaceStatusContext(paths);

  if (flags.json === "true") {
    io.stdout.write(`${JSON.stringify(workspaceDetail(workspace, statusContext), null, 2)}\n`);
    return 0;
  }

  io.stdout.write(workspaceDetailText(workspace, statusContext));
  return 0;
}

async function startWorkspaceShell(
  paths: ReturnType<typeof resolveSparkPaths>,
  workspace: SparkDaemonWorkspace,
  io: CliIo,
): Promise<void> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return;
  }

  let current = workspace;
  io.stdout.write(
    `\nSpark workspace ${current.displayName}\n` + "  commands show, status, stop, help, quit\n",
  );
  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question(`spark daemon:${current.localWorkspaceKey}> `))
        .trim()
        .toLowerCase();
      if (answer === "" || answer === "status") {
        io.stdout.write(
          `status   ${workspaceStatusLabel(current, workspaceStatusContext(paths))}\n`,
        );
        continue;
      }
      if (answer === "q" || answer === "quit" || answer === "exit") {
        return;
      }
      if (answer === "help" || answer === "?") {
        io.stdout.write("commands show, status, stop, help, quit\n");
        continue;
      }
      if (answer === "show") {
        io.stdout.write(workspaceDetailText(current, workspaceStatusContext(paths)));
        continue;
      }
      if (answer === "stop") {
        current = await stopWorkspaceForCli(paths, current.id, io);
        io.stdout.write(
          `✓ paused '${current.displayName}'\n` +
            `  status   ${workspaceStatusLabel(current, workspaceStatusContext(paths))}\n`,
        );
        continue;
      }
      io.stdout.write("unknown command. type help.\n");
    }
  } finally {
    prompt.close();
  }
}

function workspaceDetailText(
  workspace: SparkDaemonWorkspace,
  statusContext: WorkspaceStatusContext,
) {
  return (
    `${workspace.displayName}\n` +
    `  id             ${workspace.id}\n` +
    `  status         ${workspaceStatusLabel(workspace, statusContext)}\n` +
    `  server         ${workspace.serverUrl || "—"}\n` +
    `  binding        ${workspace.serverBindingId ?? "—"}${
      workspace.hubBindingState ? ` (${workspace.hubBindingState})` : ""
    }\n` +
    `  hub ws     ${workspace.serverWorkspaceId ?? "—"}\n` +
    `  path           ${formatPathForDisplay(workspace.localPath)}\n` +
    profileTextLine(workspace.profile, "  profile        ") +
    offlineTextBlock(workspace, statusContext) +
    degradedTextBlock(workspace, statusContext) +
    recentSessionsTextBlock(workspace)
  );
}

function recentSessionsTextBlock(workspace: SparkDaemonWorkspace): string {
  const sessions = workspace.recentSessions ?? [];
  if (sessions.length === 0) {
    return "";
  }

  return (
    `\nrecent sessions (${sessions.length})\n` +
    sessions
      .map(
        (session) =>
          `  ${session.id}   ${session.project}   ${session.model}   ${relativeTime(session.lastActivityAt)}   ${session.state}\n`,
      )
      .join("")
  );
}

function resolveWorkspaceForShow(
  workspaces: SparkDaemonWorkspace[],
  identifier: string | undefined,
): SparkDaemonWorkspace {
  if (identifier) {
    return resolveWorkspace(workspaces, identifier);
  }

  if (workspaces.length === 0) {
    throw new Error("No workspace found. Run spark daemon workspace register . --name <ws>.");
  }

  const cwd = resolveInvocationCwd();
  const workspace = resolveWorkspaceForCwd(workspaces, cwd);
  if (!workspace) {
    throw new Error(`${cwd} is not under a registered workspace. Pass a workspace id.`);
  }
  return workspace;
}

async function stopWorkspaceCommand(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const identifier = flags.workspace ?? positionalArgs(args)[0];
  if (!identifier) {
    throw new Error("Pass a workspace id or --workspace <id>.");
  }
  const workspace = resolveWorkspace(await loadWorkspaceList(paths, io), identifier);
  if (
    !(await confirmAction(
      io,
      flags,
      `Pause workspace '${workspace.id}' (${workspace.displayName})?`,
    ))
  ) {
    io.stdout.write("Cancelled.\n");
    return 4;
  }

  const stopped = await stopWorkspaceForCli(paths, workspace.id, io);
  io.stdout.write(
    `✓ paused '${stopped.displayName}'\n` +
      `  server   ${stopped.serverUrl}\n` +
      `  path     ${formatPathForDisplay(stopped.localPath)}\n` +
      `  status   ${workspaceStatusLabel(stopped)}\n` +
      `  note     cd into ${formatPathForDisplay(stopped.localPath)} and run spark daemon to re-attach it.\n`,
  );
  return 0;
}

function resolveWorkspace(
  workspaces: SparkDaemonWorkspace[],
  identifier: string | undefined,
): SparkDaemonWorkspace {
  if (!identifier) {
    if (workspaces.length === 1) {
      return workspaces[0]!;
    }
    if (workspaces.length === 0) {
      throw new Error("No workspace found. Run spark daemon workspace register . --name <ws>.");
    }
    throw new Error(
      `Multiple workspaces are registered. Pass --workspace <id>. Available: ${workspaces
        .map(workspaceIdentifier)
        .join(", ")}.`,
    );
  }

  const parsed = parseWorkspaceIdentifier(identifier);
  const idMatches = workspaces.filter((workspace) => workspaceMatchesId(workspace, parsed.name));
  let matches =
    idMatches.length > 0
      ? idMatches
      : workspaces.filter((workspace) => workspaceMatchesName(workspace, parsed.name));
  if (parsed.serverRef !== undefined) {
    const matchingServers = new Set(
      workspaces
        .filter((workspace) => serverMatchesRef(workspace.serverUrl, parsed.serverRef!))
        .map((workspace) => workspace.serverUrl),
    );
    if (matchingServers.size > 1) {
      throw new Error(`Ambiguous workspace server: ${parsed.serverRef}`);
    }
    matches = matches.filter((workspace) =>
      serverMatchesRef(workspace.serverUrl, parsed.serverRef!),
    );
  }
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous workspace: ${identifier}. Use ${matches.map(workspaceIdentifier).join(", ")}.`,
    );
  }
  throw new Error(`Unknown workspace: ${identifier}`);
}

interface WorkspaceStatusContext {
  daemonRunning: boolean;
}

function workspaceStatusContext(
  paths: ReturnType<typeof resolveSparkPaths>,
): WorkspaceStatusContext {
  return { daemonRunning: readRunningPid(paths) !== null };
}

function workspaceListItem(workspace: SparkDaemonWorkspace, context: WorkspaceStatusContext) {
  const renderedStatus = workspaceStatusJson(workspace, context);
  const offlineReason = workspaceOfflineReasonJson(workspace, context);
  const degradedReasons = workspaceDegradedReasons(workspace, context);
  return {
    id: workspace.id,
    slug: workspace.localWorkspaceKey,
    name: workspace.displayName,
    serverUrl: workspace.serverUrl,
    ...(workspace.serverBindingId ? { serverBindingId: workspace.serverBindingId } : {}),
    ...(workspace.serverWorkspaceId ? { serverWorkspaceId: workspace.serverWorkspaceId } : {}),
    ...(workspace.hubBindingState ? { hubBindingState: workspace.hubBindingState } : {}),
    path: workspace.localPath,
    status: renderedStatus,
    ...(offlineReason ? { offlineReason } : {}),
    ...(degradedReasons.length > 0 ? { degradedReasons } : {}),
    ...(workspace.profile ? { profile: workspace.profile } : {}),
    ...(workspace.lifecycle ? { lifecycle: workspace.lifecycle } : {}),
    counts: {
      projects: null,
      unresolvedInbox: null,
      sessions: workspace.sessionCount ?? null,
    },
    ...(workspace.lastSessionAt ? { lastSessionAt: workspace.lastSessionAt } : {}),
    lastStatusChangedAt: workspace.updatedAt,
  };
}

function workspaceDetail(workspace: SparkDaemonWorkspace, context: WorkspaceStatusContext) {
  return {
    ...workspaceListItem(workspace, context),
    connection: {
      ref: workspace.id,
      capabilities: bindingCapabilities(workspace),
    },
    projects: [],
    inbox: [],
    recentSessions: workspace.recentSessions ?? [],
  };
}

function bindingCapabilities(workspace: SparkDaemonWorkspace): Array<{
  id: string;
  status: "online" | "offline";
  lastCheckedAt: string;
  message?: string;
}> {
  return Object.entries(workspace.capabilities).map(([id, value]) => {
    const capability = {
      id,
      status: capabilityStatus(value),
      lastCheckedAt: capabilityLastCheckedAt(value, workspace.updatedAt),
    };
    const message = capabilityMessage(value);
    return message ? { ...capability, message } : capability;
  });
}

function capabilityStatus(value: unknown): "online" | "offline" {
  if (value === "unavailable" || value === "offline") {
    return "offline";
  }
  if (isRecord(value) && (value.status === "unavailable" || value.status === "offline")) {
    return "offline";
  }
  return "online";
}

function capabilityLastCheckedAt(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.lastCheckedAt === "string"
    ? value.lastCheckedAt
    : fallback;
}

function capabilityMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workspaceStatusLabel(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
    lifecycle?: SparkDaemonWorkspace["lifecycle"];
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): string {
  if (workspace.lifecycle?.state === "merged") {
    return `merged → ${workspace.lifecycle.mergedIntoWorkspaceId}`;
  }
  if (workspace.lifecycle?.state === "unregistered") {
    return "unregistered";
  }
  if (isUserDetached(workspace)) {
    return "offline · detached";
  }

  if (!context.daemonRunning) {
    return "offline · service stopped";
  }

  switch (workspace.status) {
    case "available":
      return "online";
    case "indexing":
      return "starting";
    case "degraded":
      return "degraded";
    default:
      return "offline · disconnected";
  }
}

function workspaceStatusJson(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
    lifecycle?: SparkDaemonWorkspace["lifecycle"];
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): string {
  if (workspace.lifecycle?.state === "merged") return "merged";
  if (workspace.lifecycle?.state === "unregistered") return "unregistered";
  if (isUserDetached(workspace)) {
    return "offline:detached";
  }

  if (!context.daemonRunning) {
    return "offline:service-stopped";
  }

  switch (workspace.status) {
    case "available":
      return "online";
    case "indexing":
      return "starting";
    case "degraded":
      return "degraded";
    default:
      return "offline:disconnected";
  }
}

function workspaceOfflineReasonJson(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): "detached" | "disconnected" | "service-stopped" | undefined {
  if (isUserDetached(workspace)) {
    return "detached";
  }

  if (!context.daemonRunning) {
    return "service-stopped";
  }

  if (
    workspace.status === "available" ||
    workspace.status === "indexing" ||
    workspace.status === "degraded"
  ) {
    return undefined;
  }
  return "disconnected";
}

function workspaceDegradedReasons(
  workspace: {
    status: string;
    diagnostics?: Record<string, unknown>;
  },
  context: WorkspaceStatusContext = { daemonRunning: true },
): DegradedReasonCode[] {
  if (!context.daemonRunning || workspace.status !== "degraded") {
    return [];
  }

  const values = [
    ...arrayStrings(workspace.diagnostics?.degradedReasons),
    ...arrayStrings(workspace.diagnostics?.reasons),
    ...singleString(workspace.diagnostics?.degradedReason),
    ...singleString(workspace.diagnostics?.reason),
  ];

  return [...new Set(values.filter(isDegradedReasonCode))];
}

function degradedTextBlock(
  workspace: SparkDaemonWorkspace,
  context: WorkspaceStatusContext,
): string {
  const reasons = workspaceDegradedReasons(workspace, context);
  if (reasons.length === 0) {
    return "";
  }

  const whyLines = reasons
    .map((reason, index) => {
      const prefix = index === 0 ? "  why            " : "                 ";
      return `${prefix}${degradedReasonText[reason].why} (${reason})\n`;
    })
    .join("");
  const remediationLines = reasons
    .map((reason, index) => {
      const prefix = index === 0 ? "  remediation    " : "                 ";
      return `${prefix}${remediationFor(reason, workspace)}\n`;
    })
    .join("");
  return whyLines + remediationLines;
}

function offlineTextBlock(
  workspace: SparkDaemonWorkspace,
  context: WorkspaceStatusContext,
): string {
  const reason = workspaceOfflineReasonJson(workspace, context);
  if (!reason) {
    return "";
  }

  const text = offlineReasonText[reason];
  return (
    `  offline reason ${reason}\n` +
    `  why            ${text.why}\n` +
    `  remediation    ${text.fix}\n`
  );
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function singleString(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function isUserDetached(workspace: {
  status: string;
  diagnostics?: Record<string, unknown>;
}): boolean {
  return workspace.status === "unavailable" && workspace.diagnostics?.userDetached === true;
}

const offlineReasonText = {
  detached: {
    why: "workspace was paused by the user",
    fix: "run spark daemon from the workspace directory to re-attach it",
  },
  disconnected: {
    why: "Spark daemon is running but the server connection is unavailable",
    fix: "check Hub reachability and run spark daemon login again if authorization expired",
  },
  "service-stopped": {
    why: "Spark daemon is not running",
    fix: "run spark daemon start or retry the workspace command",
  },
};

const degradedReasonText = {
  "filesystem.unreachable": {
    why: "workspace path not reachable",
    fix: "reconnect the volume",
  },
  "filesystem.permission": {
    why: "workspace path permission check failed",
    fix: "check directory permissions",
  },
  "git.corrupt": {
    why: "git worktree is corrupt or missing HEAD",
    fix: "repair the git worktree",
  },
  "profile.invalid": {
    why: "imported profile is invalid",
    fix: "fix the workspace profile files",
  },
  "profile.missing-agents": {
    why: "imported profile references missing agents",
    fix: "restore the referenced agent definitions",
  },
  "runtime.subprocess-unhealthy": {
    why: "Spark runtime bridge subprocess is unhealthy",
    fix: "restart the Spark daemon",
  },
  "lease.stale": {
    why: "stale workspace lease found",
    fix: "retry after the Spark daemon cleans stale leases",
  },
  "storage.full": {
    why: "local storage is full",
    fix: "free space in the Spark daemon data/cache/state directories",
  },
  "storage.io-error": {
    why: "local storage I/O failed",
    fix: "check the Spark daemon data/cache/state directories",
  },
} as const;

type DegradedReasonCode = keyof typeof degradedReasonText;

function isDegradedReasonCode(value: string): value is DegradedReasonCode {
  return value in degradedReasonText;
}

function remediationFor(reason: DegradedReasonCode, workspace: SparkDaemonWorkspace): string {
  if (reason === "filesystem.unreachable") {
    return `${degradedReasonText[reason].fix}, or run 'spark daemon workspace stop ${shellQuote(workspace.localWorkspaceKey)}'`;
  }
  return degradedReasonText[reason].fix;
}

function resolveWorkspaceForCwd(
  workspaces: SparkDaemonWorkspace[],
  cwd: string,
): SparkDaemonWorkspace | null {
  const current = resolve(cwd);
  const matches = workspaces
    .filter((workspace) => pathContains(workspace.localPath, current))
    .sort((left, right) => right.localPath.length - left.localPath.length);
  const bestLength = matches[0]?.localPath.length;
  const bestMatches =
    bestLength === undefined
      ? []
      : matches.filter((workspace) => workspace.localPath.length === bestLength);
  if (bestMatches.length > 1) {
    throw new Error(
      `Multiple workspaces match ${current}. Use ${bestMatches.map(workspaceIdentifier).join(", ")}.`,
    );
  }
  return matches[0] ?? null;
}

function parseWorkspaceIdentifier(identifier: string): { name: string; serverRef?: string } {
  const separator = identifier.lastIndexOf("@");
  if (separator <= 0) {
    return { name: identifier };
  }

  const serverRef = identifier.slice(separator + 1);
  if (!serverRef) {
    return { name: identifier };
  }

  return { name: identifier.slice(0, separator), serverRef };
}

function workspaceMatchesId(workspace: SparkDaemonWorkspace, ref: string): boolean {
  return (
    workspace.id === ref || workspace.serverBindingId === ref || workspace.serverWorkspaceId === ref
  );
}

function workspaceMatchesName(workspace: SparkDaemonWorkspace, name: string): boolean {
  return workspace.displayName === name || workspace.localWorkspaceKey === name;
}

function serverMatchesRef(serverUrl: string, serverRef: string): boolean {
  return serverUrl === serverRef || serverUrl.startsWith(serverRef);
}

/** Canonical CLI marker for a daemon workspace. */
function workspaceIdentifier(workspace: SparkDaemonWorkspace): string {
  return workspace.id;
}

function pathContains(parentPath: string, childPath: string): boolean {
  const fromParent = relative(normalizeLocalPath(parentPath), normalizeLocalPath(childPath));
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function normalizeLocalPath(localPath: string): string {
  const absolutePath = resolve(localPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function formatServerForList(serverUrl: string, full: boolean): string {
  return full ? serverUrl : truncateColumn(serverUrl, 30);
}

function formatPathForList(localPath: string, full: boolean): string {
  if (full) {
    return localPath;
  }

  return truncateColumn(abbreviateHome(localPath), 38);
}

function formatPathForDisplay(localPath: string): string {
  return abbreviateHome(localPath);
}

function abbreviateHome(localPath: string): string {
  const home = process.env.HOME;
  if (!home) {
    return localPath;
  }

  const normalizedHome = realpathOrResolved(home);
  if (localPath === normalizedHome) {
    return "~";
  }
  return localPath.startsWith(`${normalizedHome}/`)
    ? `~/${localPath.slice(normalizedHome.length + 1)}`
    : localPath;
}

function realpathOrResolved(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function countColumn(value: number | null): string {
  return value === null ? "—" : String(value);
}

function lastSessionColumn(value: string | undefined): string {
  return value ? relativeTime(value) : "—";
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} s ago`;
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) {
    return `${elapsedHours} h ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} d ago`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function resolveRegistrationServerUrl(
  flags: Record<string, string>,
  current: ReturnType<typeof readSparkDaemonConfig>,
  io: CliIo,
  options: { interactive?: boolean } = {},
): Promise<string> {
  const serverUrl = flags["server-url"] ?? flags.server;
  const validationOptions = {
    allowInsecureHttp: flags["allow-insecure-http"] === "true",
  };
  if (serverUrl) {
    return validateRegistrationServerUrl(serverUrl, validationOptions);
  }

  const configured = configuredServerUrl(current);
  if (options.interactive) {
    return validateRegistrationServerUrl(
      await promptWithDefault(io, "server URL", configured),
      validationOptions,
    );
  }

  if (configured) {
    return validateRegistrationServerUrl(configured, validationOptions);
  }

  throw new Error("Missing server URL. Pass --server-url <url> with the registration command.");
}

async function resolveWorkspaceAnnounceServerUrl(
  paths: ReturnType<typeof resolveSparkPaths>,
  flags: Record<string, string>,
): Promise<string> {
  const flagged = flags["server-url"] ?? flags.server;
  const validationOptions = {
    allowInsecureHttp: flags["allow-insecure-http"] === "true",
  };
  const scheduled = scheduledSparkDaemonHubOrigin(paths, flagged);
  if (scheduled.ambiguous) {
    throw new Error(
      "This daemon has multiple Hub origins. Pass --server-url to select which origin to project onto.",
    );
  }
  if (!scheduled.serverUrl) {
    throw new Error(
      "Hub workspace token requires a daemon Hub origin. Run spark daemon login --server-url <url>.",
    );
  }
  return validateRegistrationServerUrl(scheduled.serverUrl, validationOptions);
}

function registrationToken(flags: Record<string, string>): string | undefined {
  return flags.token ?? process.env.SPARK_WORKSPACE_REGISTRATION_TOKEN;
}

function isScriptedWorkspaceRegistration(flags: Record<string, string>): boolean {
  return Boolean(
    flags.path ||
    flags["server-url"] ||
    flags.server ||
    flags.key ||
    flags["local-key"] ||
    flags.name ||
    flags.profile ||
    flags.token,
  );
}

async function resolveRegistrationToken(
  flags: Record<string, string>,
  io: CliIo,
  options: { interactive?: boolean } = {},
): Promise<string | undefined> {
  const token = registrationToken(flags);
  if (token !== "-") {
    return (
      token ??
      (options.interactive ? await promptSecret(io, "workspace registration token") : undefined)
    );
  }

  return readStdinLine(io, "workspace registration token");
}

async function logs(
  paths: ReturnType<typeof resolveSparkPaths>,
  args: string[],
  io: CliIo,
): Promise<number> {
  const flags = parseFlags(args);
  const lineCount = parseLineCount(flags.lines ?? flags.n);
  const sources = daemonLogSources(paths);
  writeLogTail(sources, lineCount, io);
  if (flags.follow !== "true" && flags.f !== "true") {
    return 0;
  }

  await followLogFiles(sources, io);
  return 0;
}

interface DaemonLogSource {
  label: string;
  path: string;
}

function daemonLogSources(paths: ReturnType<typeof resolveSparkPaths>): DaemonLogSource[] {
  return [
    { label: "service stdout", path: join(paths.logDir, "service.stdout.log") },
    { label: "service stderr", path: join(paths.logDir, "service.stderr.log") },
    // Keep the structured log path visible for compatibility with callers or
    // future sinks that write it, even though service output currently lands
    // in the supervisor-owned stdout/stderr files above.
    { label: "daemon events", path: paths.logFile },
  ];
}

function parseLineCount(value: string | undefined): number {
  if (value === undefined) {
    return 100;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid --lines value. Pass a non-negative integer.");
  }
  return parsed;
}

function writeLogTail(sources: readonly DaemonLogSource[], lineCount: number, io: CliIo): void {
  const existingSources = sources.filter((source) => existsSync(source.path));
  if (existingSources.length === 0) {
    io.stdout.write(
      `no daemon logs yet; checked:\n${sources
        .map((source) => `  ${source.label}: ${source.path}`)
        .join("\n")}\n`,
    );
    return;
  }

  for (const source of existingSources) {
    const content = readFileSync(source.path, "utf8");
    if (!content) {
      continue;
    }

    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    const selected = lineCount === 0 ? [] : lines.slice(-lineCount);
    if (selected.length > 0) {
      writeLogSource(source, `${selected.join("\n")}\n`, io);
    }
  }
}

function writeLogSource(source: DaemonLogSource, content: string, io: CliIo): void {
  io.stdout.write(`==> ${source.label} (${source.path}) <==\n`);
  io.stdout.write(content);
  if (!content.endsWith("\n")) {
    io.stdout.write("\n");
  }
}

async function followLogFiles(sources: readonly DaemonLogSource[], io: CliIo): Promise<void> {
  const offsets = new Map(
    sources.map((source) => [
      source.path,
      existsSync(source.path) ? readFileSync(source.path, "utf8").length : 0,
    ]),
  );
  const listeners = new Map<string, () => void>();

  await new Promise<void>((resolvePromise) => {
    for (const source of sources) {
      const listener = () => {
        if (!existsSync(source.path)) {
          return;
        }

        const content = readFileSync(source.path, "utf8");
        let offset = offsets.get(source.path) ?? 0;
        if (content.length < offset) {
          offset = 0;
        }
        if (content.length > offset) {
          writeLogSource(source, content.slice(offset), io);
          offsets.set(source.path, content.length);
        }
      };
      listeners.set(source.path, listener);
      watchFile(source.path, { interval: 500 }, listener);
    }

    process.once("SIGINT", () => {
      for (const source of sources) {
        unwatchFile(source.path, listeners.get(source.path));
      }
      resolvePromise();
    });
  });
}

bindCliDaemonLogs(logs);

async function resolveWorkspaceProfile(
  localPath: string,
  flags: Record<string, string>,
  io: CliIo,
  options: { allowDetectedPrompt: boolean },
): Promise<WorkspaceProfileRegistration | undefined> {
  const profileRef = flags.profile;
  if (profileRef !== undefined) {
    if (profileRef === "true" || !profileRef.trim()) {
      throw new Error("Missing workspace profile. Pass --profile <path-or-git-url>.");
    }

    return profileRegistrationFromRef(localPath, profileRef);
  }

  if (!options.allowDetectedPrompt) {
    return undefined;
  }

  const detected = detectWorkspaceProfile(localPath);
  if (!detected || !(await confirmDetectedProfileImport(io, detected.promptLabel))) {
    return undefined;
  }

  return profileRegistrationFromRef(localPath, detected.ref);
}

function profileRegistrationFromRef(
  localPath: string,
  profileRef: string,
): WorkspaceProfileRegistration {
  const localProfilePath = resolveLocalProfilePath(localPath, profileRef);
  return {
    sourceKind: "git",
    ref: profileRef,
    ...gitCommitForProfile(localProfilePath),
    importedAt: new Date().toISOString(),
  };
}

function detectWorkspaceProfile(localPath: string): { ref: string; promptLabel: string } | null {
  const directoryProfileSettings = resolve(localPath, "spark-profile", "settings.toml");
  if (existsSync(directoryProfileSettings)) {
    return { ref: "./spark-profile", promptLabel: "./spark-profile" };
  }

  const inlineProfile = resolve(localPath, ".spark", "profile.toml");
  if (existsSync(inlineProfile)) {
    return { ref: "./.spark/profile.toml", promptLabel: "./.spark/profile.toml" };
  }

  return null;
}

async function confirmDetectedProfileImport(io: CliIo, profileLabel: string): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    return false;
  }

  const prompt = createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Use profile from ${profileLabel}? [Y/n]: `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "" || normalized === "y" || normalized === "yes";
  } finally {
    prompt.close();
  }
}

function resolveLocalProfilePath(localPath: string, profileRef: string): string | null {
  if (isUrlLike(profileRef)) {
    return null;
  }

  const resolvedPath = resolve(localPath, profileRef);
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch {
    throw new Error(`Workspace profile was not found: ${resolvedPath}`);
  }

  if (stat.isDirectory()) {
    const settingsPath = resolve(resolvedPath, "settings.toml");
    if (!existsSync(settingsPath)) {
      throw new Error(`Workspace profile settings.toml was not found: ${settingsPath}`);
    }
    return resolvedPath;
  }

  if (stat.isFile()) {
    return dirname(resolvedPath);
  }

  throw new Error(`Workspace profile is not a file or directory: ${resolvedPath}`);
}

function gitCommitForProfile(profilePath: string | null): { commit?: string } {
  if (!profilePath) {
    return {};
  }

  const gitEnv = { ...process.env };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete gitEnv[name];
  }
  const result = spawnSync(gitCommand(), ["-C", profilePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: gitEnv,
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(commit) ? { commit } : {};
}

function isUrlLike(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "git:"
    );
  } catch {
    return false;
  }
}

function profileTextLine(
  profile: WorkspaceProfileRegistration | undefined,
  prefix = "  profile  ",
): string {
  if (!profile) {
    return "";
  }
  return `${prefix}${profile.ref}${profile.commit ? ` @ ${profile.commit.slice(0, 7)}` : ""}\n`;
}

function resolveWorkspacePath(pathArg: string): string {
  return resolve(resolveInvocationCwd(), pathArg);
}

async function promptWorkspacePath(io: CliIo): Promise<string> {
  return promptWithDefault(io, "path", ".");
}

async function promptWorkspaceName(localPath: string, io: CliIo): Promise<string> {
  return promptWithDefault(io, "workspace name", workspaceNameForPath(localPath));
}

function assertDirectory(localPath: string): void {
  let stat;
  try {
    stat = statSync(localPath);
  } catch {
    throw new WorkspacePathValidationError(`Workspace directory does not exist: ${localPath}`);
  }

  if (!stat.isDirectory()) {
    throw new WorkspacePathValidationError(`Workspace path is not a directory: ${localPath}`);
  }

  try {
    accessSync(localPath, constants.R_OK);
  } catch {
    throw new WorkspacePathValidationError(`Workspace directory is not readable: ${localPath}`);
  }
}

function isDirectRun(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  process.exitCode = await main();
}
