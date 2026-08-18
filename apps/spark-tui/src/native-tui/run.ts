/** Process-terminal entrypoint for the native Spark TUI. */

import { ProcessTerminal, TUI } from "@zendev-lab/spark-tui-adapter/pi-tui";
import type { SparkKeybindingContext, SparkKeybindings } from "@zendev-lab/spark-host/keybindings";
import type { SparkTheme } from "../host/theme.ts";
import type { SparkHostMessageRenderer } from "@zendev-lab/spark-host/types";
import { SparkNativeTuiApp } from "./app.ts";
import { SparkNativeSession } from "./session.ts";
import { nativeTuiStrings } from "./strings.ts";
import { acquireSparkNativeTuiLease } from "./tty-lease.ts";
import type {
  SparkNativeInteractionHandler,
  SparkNativeResponder,
  SparkNativeSlashCommandMap,
  SparkNativeStatusContext,
  SparkNativeTuiExitReason,
  SparkNativeWorkspaceSessionState,
} from "./types.ts";

export interface SparkNativeSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface RunNativeSparkTuiOptions {
  initialMessage?: string;
  responder?: SparkNativeResponder;
  slashCommands?: SparkNativeSlashCommandMap;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  keybindings?: SparkKeybindings;
  keybindingContext?: SparkKeybindingContext;
  messageRenderers?: ReadonlyMap<string, SparkHostMessageRenderer>;
  theme?: SparkTheme;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  statusContext?: SparkNativeStatusContext;
  signalSource?: SparkNativeSignalSource;
  configureApp?: (app: SparkNativeTuiApp, session: SparkNativeSession) => void | Promise<void>;
}

export async function runNativeSparkTui(
  input?: string | RunNativeSparkTuiOptions,
): Promise<SparkNativeTuiExitReason> {
  const options = typeof input === "string" ? { initialMessage: input } : (input ?? {});
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const session = new SparkNativeSession(options.responder);

  let resolveDone: ((reason: SparkNativeTuiExitReason) => void) | undefined;
  const done = new Promise<SparkNativeTuiExitReason>((resolve) => {
    resolveDone = resolve;
  });
  const stop = (reason: SparkNativeTuiExitReason = "exit") => resolveDone?.(reason);

  const app = new SparkNativeTuiApp(tui, session, stop, {
    slashCommands: options.slashCommands,
    autocompleteBasePath: options.autocompleteBasePath,
    autocompleteFdPath: options.autocompleteFdPath,
    interactionHandler: options.interactionHandler,
    keybindings: options.keybindings,
    keybindingContext: options.keybindingContext,
    messageRenderers: options.messageRenderers,
    statusContext: options.statusContext,
    theme: options.theme,
    workspaceSession: options.workspaceSession,
  });
  const unregisterSignals = registerSparkNativeTuiSignalHandlers(
    options.signalSource ?? process,
    stop,
  );
  let started = false;
  let terminalLease: Awaited<ReturnType<typeof acquireSparkNativeTuiLease>>;
  try {
    terminalLease = await acquireSparkNativeTuiLease();
    await options.configureApp?.(app, session);
    tui.addChild(app);
    tui.setFocus(app);
    terminal.setTitle(nativeTuiStrings.appTitle);
    tui.start();
    started = true;
    tui.requestRender(true);

    if (options.initialMessage) {
      queueMicrotask(() => void app.submitInput(options.initialMessage!));
    }

    return await done;
  } finally {
    unregisterSignals();
    app.dispose();
    if (started) tui.stop();
    try {
      await terminal.drainInput();
    } finally {
      await terminalLease?.release();
    }
  }
}

export function registerSparkNativeTuiSignalHandlers(
  source: SparkNativeSignalSource,
  stop: () => void,
): () => void {
  const onSignal = () => stop();
  source.on("SIGINT", onSignal);
  source.on("SIGTERM", onSignal);
  return () => {
    source.off("SIGINT", onSignal);
    source.off("SIGTERM", onSignal);
  };
}
