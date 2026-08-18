import { setTimeout as delay } from "node:timers/promises";

import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";

import {
  SPARK_TUI_RELOAD_EXIT_CODE,
  SPARK_TUI_WORKER_ARG,
  installSparkTuiWorkerSupervisorGuard,
  runSparkTuiProcessSupervisor,
  sendSparkTuiReloadHandoff,
} from "../cli/process-supervisor.ts";
import { SparkNativeSession, SparkNativeTuiApp } from "../native-tui.ts";
import type { TUI } from "@zendev-lab/spark-tui-adapter/pi-tui";
import { sparkNativeReproSessionView } from "./spark-native-repro-view-fixture.ts";

interface FixtureOptions {
  generation: number;
  reloads: number;
  sessionId: string;
  malformed: boolean;
  leakTimer: boolean;
  noHandoff: boolean;
  handoffExitCode?: number;
  hang: boolean;
  ignoreSignals: boolean;
}

function fixtureOptions(argv: readonly string[]): FixtureOptions {
  const value = (flag: string, fallback: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
  };
  return {
    generation: Number(value("--generation", "0")),
    reloads: Number(value("--reloads", "1")),
    sessionId: value("--session-id", "session-reload"),
    malformed: argv.includes("--malformed"),
    leakTimer: argv.includes("--leak-timer"),
    noHandoff: argv.includes("--no-handoff"),
    ...(argv.includes("--handoff-exit-code")
      ? { handoffExitCode: Number(value("--handoff-exit-code", "75")) }
      : {}),
    hang: argv.includes("--hang"),
    ignoreSignals: argv.includes("--ignore-signals"),
  };
}

async function runWorker(argv: string[]): Promise<number> {
  const options = fixtureOptions(argv);
  if (options.ignoreSignals) {
    process.on("SIGINT", () => undefined);
    process.on("SIGTERM", () => undefined);
  }
  const reproPresentation = reproPresentationState(options.generation, options.sessionId);
  process.stdout.write(
    `${JSON.stringify({
      kind: "worker",
      pid: process.pid,
      ppid: process.ppid,
      generation: options.generation,
      cwd: process.cwd(),
      sessionId: options.sessionId,
      ...reproPresentation,
    })}\n`,
  );
  if (options.hang) {
    setInterval(() => undefined, 60_000);
    return await new Promise<number>(() => undefined);
  }
  if (options.generation >= options.reloads) return 0;
  if (options.leakTimer) setInterval(() => undefined, 60_000);
  if (options.noHandoff) return SPARK_TUI_RELOAD_EXIT_CODE;
  const nextGeneration = options.generation + 1;
  await sendSparkTuiReloadHandoff({
    sessionId: options.sessionId,
    cwd: process.cwd(),
    argv: [
      "--generation",
      String(nextGeneration),
      "--reloads",
      String(options.reloads),
      ...(options.leakTimer ? ["--leak-timer"] : []),
      ...(options.handoffExitCode !== undefined
        ? ["--handoff-exit-code", String(options.handoffExitCode)]
        : []),
      ...(options.malformed ? ["--session-id", "mismatched-session"] : []),
      "--session-id",
      options.sessionId,
    ],
  });
  return options.handoffExitCode ?? SPARK_TUI_RELOAD_EXIT_CODE;
}

function reproPresentationState(generation: number, sessionId: string): Record<string, unknown> {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => undefined,
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(tui, session, () => undefined);
  app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: sparkNativeReproSessionView({ sessionId }),
  });
  if (generation === 0) {
    app.openHubPanel("repro");
    app.handleInput("2");
    app.handleInput("\r");
  }
  const snapshot = app.hubSnapshot();
  app.dispose();
  return {
    reproId: snapshot.reproId,
    activeHubPanel: snapshot.activePanel,
    selectedReproLane: snapshot.selectedReproLane,
    reproDetailExpanded: snapshot.reproDetailExpanded,
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === SPARK_TUI_WORKER_ARG) {
    const supervisorGuard = installSparkTuiWorkerSupervisorGuard(250);
    try {
      const code = await runWorker(argv.slice(1));
      if (supervisorGuard.disconnected) process.exit(1);
      if (code === SPARK_TUI_RELOAD_EXIT_CODE) process.exit(code);
      return code;
    } finally {
      supervisorGuard.dispose();
    }
  }
  const options = fixtureOptions(argv);
  process.stdout.write(`${JSON.stringify({ kind: "supervisor", pid: process.pid })}\n`);
  await delay(10);
  return await runSparkTuiProcessSupervisor({
    entrypoint: process.argv[1]!,
    argv: [
      "--generation",
      "0",
      "--reloads",
      String(options.reloads),
      ...(options.leakTimer ? ["--leak-timer"] : []),
      ...(options.malformed ? ["--malformed"] : []),
      ...(options.noHandoff ? ["--no-handoff"] : []),
      ...(options.handoffExitCode !== undefined
        ? ["--handoff-exit-code", String(options.handoffExitCode)]
        : []),
      ...(options.hang ? ["--hang"] : []),
      ...(options.ignoreSignals ? ["--ignore-signals"] : []),
      "--session-id",
      options.sessionId,
    ],
    cwd: process.cwd(),
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
