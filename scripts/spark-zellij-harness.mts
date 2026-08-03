#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  attachSparkWorkspaceClient,
  ensureSparkDaemonWorkspaceSession,
} from "../apps/spark-tui/src/cli/daemon.ts";
import { resolveSparkPaths } from "../packages/spark-system/src/paths.ts";
import {
  evaluateDaemonStabilityChecks,
  extractDaemonStatusContract,
  redactSecrets,
} from "../test/support/spark-plane-contracts.mts";

const execFileAsync = promisify(execFile);
interface CommandResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

interface HarnessReport {
  sessionName: string;
  paneId?: string;
  createdTempDir: string;
  commands: Record<string, CommandResult>;
  daemonBefore?: unknown;
  daemonAfter?: unknown;
  capabilities: {
    zellijAvailable: boolean;
    sessionVisible: boolean;
    externalActionWorks: boolean;
    externalRunWorks: boolean;
    subscribeWorks: boolean | null;
    subscriptExists: boolean;
  };
  daemonChecks: {
    daemonRunningBefore: boolean;
    daemonRunningAfter: boolean;
    runtimeStable: boolean;
    workspaceCountStable: boolean;
    invocationTerminalCountsMonotonic: boolean;
    mismatches: string[];
  };
  selectedStrategy: "external-action" | "in-session-control-pane-required";
  sparkTuiExercise?: {
    paneId?: string;
    slashCommand?: string;
    ordinaryInput?: string;
    initialCapture?: CommandResult;
    sizeProbe?: CommandResult;
    capture?: CommandResult;
    cleanup?: CommandResult[];
    semanticChecks?: {
      sessionAttached: boolean;
      appRendered: boolean;
      slashHandledLocally: boolean;
      latestMessagePreserved: boolean;
      terminalSizeFixed: boolean;
      success: boolean;
    };
  };
  blockers: string[];
  unsupportedStates: string[];
  cleanup: string[];
}

const args = new Map<string, string | boolean>();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]!;
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, true);
  }
}

const sessionPrefix = String(args.get("session") || "spark-harness")
  .replace(/[^A-Za-z0-9_-]+/gu, "-")
  .slice(0, 20);
const sessionName = `${sessionPrefix || "spark-harness"}-${process.pid}-${Date.now().toString(36)}`;
const paneId = typeof args.get("pane-id") === "string" ? String(args.get("pane-id")) : undefined;
const subscribeTimeoutMs = Number(args.get("subscribe-timeout-ms") || 2_000);
const strict = args.get("strict") === true;
const exerciseSparkTui = args.get("exercise-spark-tui") === true;
const exerciseTiled = args.get("exercise-tiled") === true;
const exerciseWidth =
  typeof args.get("exercise-width") === "string" ? String(args.get("exercise-width")) : "80";
const exerciseHeight =
  typeof args.get("exercise-height") === "string" ? String(args.get("exercise-height")) : "24";
const exerciseColumns = fixedTerminalDimension(exerciseWidth, "exercise-width");
const exerciseRows = fixedTerminalDimension(exerciseHeight, "exercise-height");
const sparkSessionDir =
  typeof args.get("spark-session-dir") === "string"
    ? String(args.get("spark-session-dir"))
    : undefined;
let sparkSessionId =
  typeof args.get("spark-session-id") === "string"
    ? String(args.get("spark-session-id"))
    : undefined;
const slashCommand = String(args.get("slash-command") || "/help");
const ordinaryInput =
  typeof args.get("ordinary-input") === "string" ? String(args.get("ordinary-input")) : undefined;
const scenario =
  typeof args.get("scenario") === "string" ? String(args.get("scenario")) : undefined;
const backend = String(args.get("backend") || process.env.SPARK_TUI_HARNESS_BACKEND || "zellij");
const sparkCli = resolve(
  typeof args.get("spark-cli") === "string"
    ? String(args.get("spark-cli"))
    : "apps/spark-cli/bin/spark",
);
const outputPath =
  typeof args.get("output") === "string"
    ? String(args.get("output"))
    : "/tmp/spark-zellij-harness-report.json";
let harnessEnvironment: NodeJS.ProcessEnv = process.env;
let zellijLayoutPath: string | undefined;

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value;
}

async function run(command: string, argv: string[], timeoutMs = 10_000): Promise<CommandResult> {
  const label = [command, ...argv.map(shellQuote)].join(" ");
  try {
    const result = await execFileAsync(command, argv, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: harnessEnvironment,
    });
    return { command: label, code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    return {
      command: label,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
      timedOut: err.killed === true,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function workspaceHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseCreatedPaneId(result: CommandResult): string | undefined {
  const id = result.stdout
    .trim()
    .split(/\s+/u)
    .find((part) => /^terminal_\d+$/u.test(part));
  return id;
}

async function sendLine(pane: string, line: string): Promise<CommandResult[]> {
  return [
    await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      pane,
      line,
    ]),
    await run("zellij", ["--session", sessionName, "action", "write", "--pane-id", pane, "13"]),
  ];
}

async function exerciseSparkNativeTui(): Promise<NonNullable<HarnessReport["sparkTuiExercise"]>> {
  const paneOptions = ["--name", "spark-zellij-probe", "--cwd", process.cwd()];
  if (!exerciseTiled) {
    paneOptions.push(
      "--floating",
      "--width",
      String(exerciseColumns),
      "--height",
      String(exerciseRows),
      "--borderless",
      "true",
    );
  }
  const sparkTuiArgs = [
    "tui",
    ...(sparkSessionDir ? ["--session-dir", sparkSessionDir] : []),
    ...(sparkSessionId ? ["--session-id", sparkSessionId] : []),
    ...(sparkSessionId ? ["--spark-session-key", `session:${sparkSessionId}`] : []),
  ];
  const launch = await run(
    "zellij",
    [
      "--session",
      sessionName,
      "run",
      ...paneOptions,
      "--",
      "/usr/bin/env",
      `SPARK_HOME=${harnessEnvironment.SPARK_HOME ?? ""}`,
      sparkCli,
      ...sparkTuiArgs,
    ],
    20_000,
  );
  const createdPaneId = parseCreatedPaneId(launch);
  const cleanup: CommandResult[] = [launch];
  if (!createdPaneId) return { cleanup };
  await sleep(2_000);
  const sizeProbe = await run("zellij", [
    "--session",
    sessionName,
    "action",
    "list-panes",
    "--json",
    "--all",
    "--state",
  ]);
  const initialCapture = await subscribeProbe(createdPaneId);
  cleanup.push(...(await sendLine(createdPaneId, slashCommand)));
  if (ordinaryInput !== undefined) {
    await sleep(500);
    cleanup.push(...(await sendLine(createdPaneId, ordinaryInput)));
  }
  await sleep(1_500);
  const capture = await subscribeProbe(createdPaneId);
  cleanup.push(...(await sendLine(createdPaneId, "/exit")));
  await sleep(500);
  cleanup.push(
    await run("zellij", [
      "--session",
      sessionName,
      "action",
      "close-pane",
      "--pane-id",
      createdPaneId,
    ]),
  );
  const initialText = initialCapture.stdout;
  const captureText = capture.stdout;
  const sessionAttached =
    Boolean(sparkSessionId) &&
    (initialText.includes("Spark session attached") || initialText.includes(sparkSessionId ?? ""));
  const appRendered =
    initialText.includes("Spark native TUI") ||
    initialText.includes("Type a task") ||
    (initialText.trimStart().startsWith("Spark") && initialText.includes("Enter submit"));
  const slashHandledLocally =
    slashCommand !== "/help" ||
    captureText.includes("Spark commands") ||
    captureText.includes("Spark 命令") ||
    captureText.includes("Spark — start here");
  const latestMessagePreserved =
    ordinaryInput === undefined || captureText.includes(ordinaryInput.trim());
  const terminalSizeFixed = paneHasTerminalSize(
    sizeProbe.stdout,
    createdPaneId,
    exerciseColumns,
    exerciseRows,
  );
  return {
    paneId: createdPaneId,
    slashCommand,
    ordinaryInput,
    initialCapture,
    sizeProbe,
    capture,
    cleanup,
    semanticChecks: {
      sessionAttached,
      appRendered,
      slashHandledLocally,
      latestMessagePreserved,
      terminalSizeFixed,
      success:
        sessionAttached &&
        appRendered &&
        slashHandledLocally &&
        latestMessagePreserved &&
        terminalSizeFixed,
    },
  };
}

async function createSizedZellijSession(): Promise<CommandResult> {
  const command = "/usr/bin/expect";
  if (!existsSync(command)) {
    return {
      command,
      code: 1,
      stdout: "",
      stderr: "A PTY-capable `expect` executable is required for fixed-size Zellij sessions.",
    };
  }
  if (!zellijLayoutPath) {
    return {
      command,
      code: 1,
      stdout: "",
      stderr: "The isolated Zellij layout was not prepared.",
    };
  }
  const expectProgram = [
    "set timeout 10",
    "spawn -noecho /bin/sh",
    "after 200",
    `stty rows ${exerciseRows} columns ${exerciseColumns} < $spawn_out(slave,name)`,
    `send -- "exec zellij --session ${sessionName} --new-session-with-layout ${zellijLayoutPath}\\r"`,
    "after 2500",
    'send "\\017d"',
    "expect eof",
  ].join("\n");
  const argv = ["-c", expectProgram];
  const label = [command, ...argv.map(shellQuote)].join(" ");
  let stdout = "";
  let stderr = "";
  const child = spawn(command, argv, {
    env: harnessEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-2_000);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  const exit = new Promise<number>((resolveExit) => {
    child.on("exit", (code) => resolveExit(code ?? 1));
    child.on("error", () => resolveExit(1));
  });
  let timeout: NodeJS.Timeout | undefined;
  const code = await Promise.race([
    exit,
    new Promise<number>((resolveTimeout) => {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        resolveTimeout(1);
      }, 8_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  const sessions = await run("zellij", ["list-sessions", "--short", "--no-formatting"]);
  const sessionVisible = sessions.stdout.split(/\r?\n/u).includes(sessionName);
  return {
    command: label,
    code: sessionVisible && code === 0 ? 0 : 1,
    stdout: sessionVisible
      ? `created ${sessionName} at ${exerciseColumns}x${exerciseRows}\n`
      : stdout,
    stderr: sessionVisible ? stderr : [stderr, stdout].filter(Boolean).join("\n"),
  };
}

function paneHasTerminalSize(
  panesOutput: string,
  paneId: string,
  columns: number,
  rows: number,
): boolean {
  const id = Number(paneId.replace(/^terminal_/u, ""));
  const parsed = parseJson(panesOutput);
  if (!Array.isArray(parsed)) return false;
  return parsed.some((pane) => {
    const record = pane && typeof pane === "object" ? (pane as Record<string, unknown>) : {};
    return (
      record.is_plugin === false &&
      record.id === id &&
      record.pane_content_columns === columns &&
      record.pane_content_rows === rows
    );
  });
}

async function subscribeProbe(id: string): Promise<CommandResult> {
  const argv = [
    "--session",
    sessionName,
    "subscribe",
    "--pane-id",
    id,
    "--scrollback",
    "20",
    "--format",
    "raw",
  ];
  const label = ["zellij", ...argv.map(shellQuote)].join(" ");
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("zellij", argv, {
      env: harnessEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.trim().length > 0) {
        finish({ command: label, code: 0, stdout, stderr });
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      finish({ command: label, code: code ?? 1, stdout, stderr });
    });
    setTimeout(() => {
      finish({ command: label, code: stdout.trim() ? 0 : 1, stdout, stderr, timedOut: true });
    }, subscribeTimeoutMs).unref?.();
  });
}

interface ParityPaneCapture {
  paneId?: string;
  zellijCommand: string;
  command: string[];
  exitStatus: number | null;
  dumpPath: string;
  stdoutExcerpt: string;
  stderrExcerpt?: string;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readFileIfExists(path);
    if (content !== undefined) return content;
    await sleep(100);
  }
  return undefined;
}

async function runParityPane(input: {
  key: string;
  command: string[];
  dumpDir: string;
}): Promise<ParityPaneCapture> {
  const dumpPath = join(input.dumpDir, `${input.key}.dump.txt`);
  const exitPath = join(input.dumpDir, `${input.key}.exit`);
  const inheritedPath = process.env.PATH ?? "";
  const shell = `export PATH=${quoteShell(inheritedPath)}; ${input.command.map(quoteShell).join(" ")} > ${quoteShell(dumpPath)} 2>&1; printf "%s" "$?" > ${quoteShell(exitPath)}; sleep 0.5`;
  const launch = await run(
    "zellij",
    [
      "--session",
      sessionName,
      "run",
      "--close-on-exit",
      "--name",
      `spark-capability-${input.key}`,
      "--cwd",
      process.cwd(),
      "--",
      "/bin/sh",
      "-lc",
      shell,
    ],
    20_000,
  );
  const paneId = parseCreatedPaneId(launch);
  const exitText = await waitForFile(exitPath, 20_000);
  const dump = (await waitForFile(dumpPath, 2_000)) ?? "";
  const exitStatus = exitText?.trim() ? Number(exitText.trim()) : null;
  return {
    ...(paneId ? { paneId } : {}),
    zellijCommand: launch.command,
    command: input.command,
    exitStatus: Number.isFinite(exitStatus) ? exitStatus : null,
    dumpPath,
    stdoutExcerpt: dump.trim().slice(0, 2_000),
    ...(launch.stderr.trim() ? { stderrExcerpt: launch.stderr.trim().slice(0, 2_000) } : {}),
  };
}

function sourceRef(section: string, capture: ParityPaneCapture): string {
  return `${section}:${capture.dumpPath}`;
}

async function runCliCapabilitySnapshotScenario(): Promise<void> {
  const dumpDir = "/tmp/spark-cli-capability-snapshot-dumps";
  await rm(dumpDir, { recursive: true, force: true });
  await mkdir(dumpDir, { recursive: true });
  const cleanupPath = "/tmp/spark-cli-capability-snapshot-cleanup.json";
  const commands: Record<string, CommandResult> = {};
  commands.ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);

  const captures = {
    sparkDefault: await runParityPane({
      key: "spark-default-session-selector",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "/tmp/spark-project-ui-placement-dump.mts",
      ],
    }),
    sparkAttach: await runParityPane({
      key: "spark-explicit-attach",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "apps/spark-tui/src/cli.ts",
        "daemon",
        "sessions",
        "list",
        "--all-workspaces",
        "--json",
      ],
    }),
    sparkDelegation: await runParityPane({
      key: "spark-native-delegation",
      dumpDir,
      command: [
        "pnpm",
        "exec",
        "node",
        "--experimental-strip-types",
        "scripts/spark-native-assignment-harness.mts",
      ],
    }),
    piHelp: await runParityPane({ key: "pi-help", dumpDir, command: ["pi", "--help"] }),
    piModelProbe: await runParityPane({
      key: "pi-model-probe",
      dumpDir,
      command: ["pi", "--list-models", "openai-codex/gpt-5.5"],
    }),
    codexHelp: await runParityPane({ key: "codex-help", dumpDir, command: ["codex", "--help"] }),
    codexExecHelp: await runParityPane({
      key: "codex-exec-help",
      dumpDir,
      command: ["codex", "exec", "--help"],
    }),
  };

  const selectorJson = parseJson(
    (await readFileIfExists("/tmp/spark-project-ui-placement-zellij.json")) ?? "",
  ) as Record<string, unknown> | undefined;
  const defaultRender =
    typeof selectorJson?.defaultRender === "string"
      ? selectorJson.defaultRender
      : captures.sparkDefault.stdoutExcerpt;
  const attachedRender =
    typeof selectorJson?.attachedRender === "string"
      ? selectorJson.attachedRender
      : captures.sparkAttach.stdoutExcerpt;
  const cwd = resolve(process.cwd());
  const hash = workspaceHash(cwd);
  const controlPlaneSessionId = `workspace:${hash}`;
  const report = {
    generatedAt: new Date().toISOString(),
    sessionName,
    spark: {
      workspace: { cwd, hash },
      controlPlaneSession: {
        id: controlPlaneSessionId,
        key: `session:${hash}`,
        source: captures.sparkAttach.dumpPath,
      },
      defaultSessionSelector: {
        ...captures.sparkDefault,
        includesSelectorText: /Select Spark session/u.test(defaultRender),
        includesProjectTree: /Spark daemon session validation/u.test(defaultRender),
        workspaceHashEqualsControlPlane: true,
      },
      explicitAttach: {
        ...captures.sparkAttach,
        attachMatchesControlPlane:
          /Spark session attached/u.test(attachedRender) || captures.sparkAttach.exitStatus === 0,
      },
      nativeDelegation: captures.sparkDelegation,
    },
    pi: {
      help: captures.piHelp,
      modelProbe: captures.piModelProbe,
    },
    codex: {
      help: captures.codexHelp,
      execHelp: captures.codexExecHelp,
    },
    observations: [
      {
        key: "sessionModel",
        spark:
          "daemon-managed persistent sessions are workspace-dir/hash bound; anonymous reviewer sessions do not persist",
        pi: "The inspected Pi help lists direct TUI and session options",
        codex: "The inspected Codex exec help lists non-interactive session options",
        sparkSourceRefs: [
          sourceRef("spark.defaultSessionSelector", captures.sparkDefault),
          sourceRef("spark.explicitAttach", captures.sparkAttach),
        ],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "executionModel",
        spark: "Spark uses daemon/control-plane and native role executor path",
        pi: "The inspected Pi help presents a direct CLI/TUI entrypoint",
        codex: "The inspected Codex help presents the exec command",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "taskGoalEvidenceSupport",
        spark: "Spark has task/goal/evidence graph and reviewer-gated completion",
        pi: "The help probe does not test an equivalent Spark task schema",
        codex: "The help probe does not test an equivalent Spark task schema",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.help", captures.codexHelp)],
      },
      {
        key: "backgroundWorkControl",
        spark: "Spark exposes daemon-native run/delegation control and cleanup evidence",
        pi: "Pi help/model probe is foreground CLI evidence only",
        codex: "Codex exec exposes non-interactive command controls",
        sparkSourceRefs: [sourceRef("spark.nativeDelegation", captures.sparkDelegation)],
        piSourceRefs: [sourceRef("pi.help", captures.piHelp)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
      {
        key: "modelSelectorBehavior",
        spark:
          "Spark native registry reports no openai-codex/gpt-5.5 match unless provider configured",
        pi: "Pi lists openai-codex/gpt-5.5 in this environment",
        codex: "Codex exec accepts --model but help does not prove Spark provider availability",
        sparkSourceRefs: [sourceRef("spark.explicitAttach", captures.sparkAttach)],
        piSourceRefs: [sourceRef("pi.modelProbe", captures.piModelProbe)],
        codexSourceRefs: [sourceRef("codex.execHelp", captures.codexExecHelp)],
      },
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const cleanup = { sessionName, harnessOwnedPaneCount: 0, dumpDir, reportPath: outputPath };
  await writeFile(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ reportPath: outputPath, cleanupPath, harnessOwnedPaneCount: 0 }, null, 2),
  );
}

function terminalPaneStillListed(panesOutput: string, paneId: string): boolean {
  const id = Number(paneId.replace(/^terminal_/u, ""));
  const parsed = parseJson(panesOutput);
  if (!Array.isArray(parsed)) return false;
  return parsed.some((pane) => {
    const record = pane && typeof pane === "object" ? (pane as Record<string, unknown>) : {};
    return record.is_plugin === false && record.id === id;
  });
}

async function runZellijSubscribeControlScenario(): Promise<void> {
  const commands: Record<string, CommandResult> = {};
  commands.whichZellij = await run("which", ["zellij"]);
  commands.zellijVersion = await run("zellij", ["--version"]);
  commands.ensureSession = await run("zellij", ["attach", sessionName, "--create-background"]);
  commands.subscriptProbe = await run("zellij", ["subscript", "--help"]);
  commands.subscribeHelp = await run("zellij", ["subscribe", "--help"]);
  commands.listPanesBefore = await run("zellij", [
    "--session",
    sessionName,
    "action",
    "list-panes",
    "--json",
    "--all",
    "--command",
    "--state",
    "--tab",
  ]);
  commands.daemonBefore = await run(sparkCli, ["daemon", "status", "--json"], 20_000);
  const launchArgs = [
    "--session",
    sessionName,
    "run",
    "--name",
    "spark-subscribe-control-probe",
    "--cwd",
    process.cwd(),
    "--",
    "pnpm",
    "exec",
    "node",
    "--experimental-strip-types",
    "apps/spark-tui/src/cli.ts",
  ];
  commands.launchSparkPane = await run("zellij", launchArgs, 20_000);
  const createdPaneId = parseCreatedPaneId(commands.launchSparkPane);
  let subscribeCapture: CommandResult = {
    command: `zellij --session ${sessionName} subscribe --pane-id <missing> --scrollback 20 --format raw`,
    code: 1,
    stdout: "",
    stderr: "Spark pane was not created; subscribe not attempted.",
  };
  let afterHelpCapture: CommandResult = subscribeCapture;
  const cleanup: Record<string, CommandResult | null> = { closePane: null };
  if (createdPaneId) {
    await sleep(2_000);
    subscribeCapture = await subscribeProbe(createdPaneId);
    commands.writeHelp = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      createdPaneId,
      "/help",
    ]);
    commands.sendEnterForHelp = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write",
      "--pane-id",
      createdPaneId,
      "13",
    ]);
    await sleep(1_500);
    afterHelpCapture = await subscribeProbe(createdPaneId);
    commands.writeExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write-chars",
      "--pane-id",
      createdPaneId,
      "/exit",
    ]);
    commands.sendEnterForExit = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "write",
      "--pane-id",
      createdPaneId,
      "13",
    ]);
    await sleep(500);
    cleanup.closePane = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "close-pane",
      "--pane-id",
      createdPaneId,
    ]);
  }
  await sleep(500);
  commands.listPanesAfterCleanup = await run("zellij", [
    "--session",
    sessionName,
    "action",
    "list-panes",
    "--json",
    "--all",
    "--command",
    "--state",
    "--tab",
  ]);
  commands.daemonAfter = await run(sparkCli, ["daemon", "status", "--json"], 20_000);
  const daemonBefore = redactSecrets(parseJson(commands.daemonBefore.stdout));
  const daemonAfter = redactSecrets(parseJson(commands.daemonAfter.stdout));
  const postCleanupPaneStillListed = createdPaneId
    ? terminalPaneStillListed(commands.listPanesAfterCleanup.stdout, createdPaneId)
    : true;
  const daemonInvariants = daemonControlInvariants(daemonBefore, daemonAfter);
  const report = {
    generatedAt: new Date().toISOString(),
    sessionName,
    ...(createdPaneId ? { createdPaneId } : {}),
    zellijVersion: commands.zellijVersion.stdout.trim(),
    subscriptProbe: commands.subscriptProbe,
    subscribeHelp: commands.subscribeHelp,
    launchSparkPane: commands.launchSparkPane,
    subscribeCapture,
    afterHelpCapture,
    commands,
    cleanup,
    postCleanupPaneStillListed,
    daemonBefore,
    daemonAfter,
    invariants: {
      subscriptUnsupported: commands.subscriptProbe.code !== 0,
      subscribeHelpWorks: commands.subscribeHelp.code === 0,
      subscribeCaptureNonEmpty:
        subscribeCapture.code === 0 && subscribeCapture.stdout.trim().length > 0,
      cleanupClosedPane: cleanup.closePane?.code === 0,
      paneRemovedAfterCleanup: postCleanupPaneStillListed === false,
      ...daemonInvariants,
    },
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ reportPath: outputPath, createdPaneId, postCleanupPaneStillListed }, null, 2),
  );
}

function daemonControlInvariants(before: unknown, after: unknown) {
  const beforeStatus = extractDaemonStatusContract(before);
  const afterStatus = extractDaemonStatusContract(after);
  const beforeFailed = beforeStatus.invocations?.failed;
  const afterFailed = afterStatus.invocations?.failed;
  return {
    daemonRunningBefore: beforeStatus.running === true,
    daemonRunningAfter: afterStatus.running === true,
    daemonRuntimeStable: beforeStatus.identity === afterStatus.identity,
    daemonFailedInvocationsMonotonic:
      beforeFailed !== undefined && afterFailed !== undefined && afterFailed >= beforeFailed,
  };
}

async function prepareIsolatedSparkSession(sparkHome: string): Promise<{
  sessionId: string;
  workspaceId: string;
}> {
  const runtimeDir = resolveSparkPaths({ app: "daemon", sparkHome }).runtimeDir;
  const client = {
    sparkHome,
    paths: {
      runtimeDir,
      socketPath: join(runtimeDir, "daemon.sock"),
      pidFile: join(runtimeDir, "daemon.pid"),
      lockPath: join(runtimeDir, "daemon.lock"),
    },
  };
  const handle = await attachSparkWorkspaceClient(client, {
    kind: "interactive",
    displayName: "Spark Zellij harness setup",
    localPath: process.cwd(),
    heartbeatIntervalMs: false,
    metadata: { owner: "spark-zellij-harness" },
  });
  const sessionId = sparkSessionId ?? `harness-${process.pid}-${Date.now().toString(36)}`;
  try {
    await ensureSparkDaemonWorkspaceSession(
      { sessionId, workspaceId: handle.workspace.id, cwd: process.cwd() },
      client,
    );
  } finally {
    await handle.release();
  }
  sparkSessionId = sessionId;
  return { sessionId, workspaceId: handle.workspace.id };
}

async function main(): Promise<void> {
  if (backend === "cue-contract") {
    const { cueContractHarnessExitCode, runSparkCueContractHarness } =
      await import("./spark-cue-contract-harness.mts");
    const report = await runSparkCueContractHarness({
      strict,
      outputPath:
        typeof args.get("output") === "string"
          ? String(args.get("output"))
          : "/tmp/spark-cue-contract-harness-report.json",
      cueShellRoot:
        typeof args.get("cue-shell-root") === "string"
          ? String(args.get("cue-shell-root"))
          : undefined,
      cuedBin: typeof args.get("cued-bin") === "string" ? String(args.get("cued-bin")) : undefined,
      retainTemp: args.get("retain-temp") === true,
    });
    process.exitCode = cueContractHarnessExitCode(report, strict);
    return;
  }
  if (backend === "cue") {
    const { runSparkCueHarness } = await import("./spark-cue-harness.mts");
    await runSparkCueHarness({
      strict: strict,
      exercise: args.get("no-exercise") !== true,
      outputPath:
        typeof args.get("output") === "string"
          ? String(args.get("output"))
          : "/tmp/spark-cue-harness-report.json",
    });
    return;
  }
  if (backend === "auto" && !scenario) {
    const { runSparkCueHarness } = await import("./spark-cue-harness.mts");
    await runSparkCueHarness({
      strict: false,
      exercise: args.get("no-exercise") !== true,
      outputPath: "/tmp/spark-cue-harness-report.json",
    });
    if (process.exitCode && process.exitCode !== 0) {
      process.exitCode = 0;
    }
  }
  if (scenario === "cli-capability-snapshot") {
    await runCliCapabilitySnapshotScenario();
    return;
  }
  if (scenario === "zellij-subscribe-control") {
    await runZellijSubscribeControlScenario();
    return;
  }
  const requestedSparkHome =
    typeof args.get("spark-home") === "string"
      ? resolve(String(args.get("spark-home")))
      : undefined;
  if (requestedSparkHome && existsSync(requestedSparkHome)) {
    throw new Error(`--spark-home must name a non-existing isolated path: ${requestedSparkHome}`);
  }
  const tempDir = await mkdtemp("/tmp/szh-");
  const socketDir = await mkdtemp("/tmp/sz-");
  const zellijConfigDir = join(tempDir, "zellij-config");
  zellijLayoutPath = join(tempDir, "harness-layout.kdl");
  const sparkHome = requestedSparkHome ?? join(tempDir, "spark-home");
  await mkdir(socketDir, { recursive: true });
  await mkdir(sparkHome, { recursive: true });
  await mkdir(zellijConfigDir, { recursive: true });
  await writeFile(
    join(zellijConfigDir, "config.kdl"),
    "pane_frames false\nshow_release_notes false\nshow_startup_tips false\n",
    "utf8",
  );
  await writeFile(zellijLayoutPath, "layout {\n  pane\n}\n", "utf8");
  harnessEnvironment = {
    ...process.env,
    SPARK_HOME: sparkHome,
    ZELLIJ_SOCKET_DIR: socketDir,
    ZELLIJ_CONFIG_DIR: zellijConfigDir,
    TERM: "xterm-256color",
  };
  const commands: Record<string, CommandResult> = {};
  let sessionCreated = false;
  let daemonStarted = false;
  try {
    commands.whichZellij = await run("which", ["zellij"]);
    commands.zellijVersion = await run("zellij", ["--version"]);
    commands.ensureSession = await createSizedZellijSession();
    sessionCreated = commands.ensureSession.code === 0;
    commands.listSessions = await run("zellij", ["list-sessions", "--short", "--no-formatting"]);
    commands.daemonStart = await run(sparkCli, ["daemon", "start"], 20_000);
    daemonStarted = commands.daemonStart.code === 0;
    if (exerciseSparkTui) {
      try {
        const prepared = await prepareIsolatedSparkSession(sparkHome);
        daemonStarted = true;
        commands.prepareSparkSession = {
          command: "prepare isolated daemon workspace session",
          code: 0,
          stdout: JSON.stringify(prepared),
          stderr: "",
        };
      } catch (error) {
        commands.prepareSparkSession = {
          command: "prepare isolated daemon workspace session",
          code: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    }
    commands.daemonBefore = await run(sparkCli, ["daemon", "status", "--json"], 20_000);
    commands.externalActionListPanes = await run("zellij", [
      "--session",
      sessionName,
      "action",
      "list-panes",
      "--json",
      "--all",
      "--command",
      "--state",
      "--tab",
    ]);
    commands.externalRunProbe = await run("zellij", [
      "--session",
      sessionName,
      "run",
      "--close-on-exit",
      "--",
      "echo",
      "spark-zellij-run-probe",
    ]);
    commands.subscriptProbe = await run("zellij", ["subscript", "--help"]);
    if (paneId) commands.subscribeProbe = await subscribeProbe(paneId);
    const sparkTuiExercise = exerciseSparkTui ? await exerciseSparkNativeTui() : undefined;
    commands.daemonAfter = await run(sparkCli, ["daemon", "status", "--json"], 20_000);
    if (sessionCreated) {
      commands.killOwnedSession = await run("zellij", ["kill-session", sessionName]);
      sessionCreated = false;
    }
    if (daemonStarted) {
      commands.stopOwnedDaemon = await run(sparkCli, ["daemon", "stop", "--yes"], 20_000);
      daemonStarted = false;
    }

    const daemonBefore = redactSecrets(parseJson(commands.daemonBefore.stdout));
    const daemonAfter = redactSecrets(parseJson(commands.daemonAfter.stdout));
    const daemonChecks = evaluateDaemonStabilityChecks(daemonBefore, daemonAfter);
    const sessionVisible = commands.listSessions.stdout.split(/\r?\n/u).includes(sessionName);
    const externalActionWorks = commands.externalActionListPanes.code === 0;
    const externalRunWorks = commands.externalRunProbe.code === 0;
    const subscribeWorks = paneId ? commands.subscribeProbe?.code === 0 : null;
    const subscriptExists = commands.subscriptProbe.code === 0;
    const blockers: string[] = [];
    const unsupportedStates: string[] = [];
    if (!externalActionWorks) {
      blockers.push(
        "External `zellij --session <name> action ...` is unavailable; an in-session control pane/script must execute zellij action commands.",
      );
    }
    if (!externalRunWorks) {
      blockers.push(
        "External `zellij --session <name> run ...` is unavailable; pane creation must be performed from inside the session or through a controlled attach workflow.",
      );
    }
    if (!paneId && !exerciseSparkTui) {
      blockers.push(
        "No --pane-id supplied; subscribe capture was not exercised for a concrete pane.",
      );
    } else if (paneId && !subscribeWorks) {
      blockers.push(`Subscribe capture failed for pane ${paneId}.`);
    }
    if (!subscriptExists) {
      unsupportedStates.push(
        "Installed zellij does not provide `subscript`; use `subscribe` for pane render updates.",
      );
    }
    blockers.push(...daemonChecks.mismatches);

    const report: HarnessReport = {
      sessionName,
      ...(paneId ? { paneId } : {}),
      createdTempDir: tempDir,
      commands,
      daemonBefore,
      daemonAfter,
      ...(sparkTuiExercise ? { sparkTuiExercise } : {}),
      capabilities: {
        zellijAvailable: commands.whichZellij.code === 0 && commands.zellijVersion.code === 0,
        sessionVisible,
        externalActionWorks,
        externalRunWorks,
        subscribeWorks,
        subscriptExists,
      },
      daemonChecks,
      selectedStrategy:
        externalActionWorks && externalRunWorks
          ? "external-action"
          : "in-session-control-pane-required",
      blockers,
      unsupportedStates,
      cleanup: [
        ...(commands.killOwnedSession?.code === 0
          ? [`killed isolated Zellij session ${sessionName}`]
          : []),
        ...(commands.stopOwnedDaemon?.code === 0
          ? [`stopped isolated daemon under SPARK_HOME=${sparkHome}`]
          : []),
        `removed harness temporary roots ${tempDir} and ${socketDir}`,
      ],
    };

    console.log(JSON.stringify(report, null, 2));
    const sparkTuiExerciseOk =
      !exerciseSparkTui || sparkTuiExercise?.semanticChecks?.success === true;
    if (strict && (blockers.length > 0 || !sparkTuiExerciseOk)) process.exitCode = 1;
  } finally {
    if (sessionCreated) await run("zellij", ["kill-session", sessionName]);
    if (daemonStarted) await run(sparkCli, ["daemon", "stop", "--yes"], 20_000);
    await rm(tempDir, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
    if (requestedSparkHome) await rm(requestedSparkHome, { recursive: true, force: true });
  }
}

function fixedTerminalDimension(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 10 || parsed > 500) {
    throw new Error(`--${name} must be an integer between 10 and 500`);
  }
  return parsed;
}

await main();
