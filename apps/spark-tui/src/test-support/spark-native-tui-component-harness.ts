import type { Component, OverlayOptions, TUI } from "@zendev-lab/spark-tui-adapter/pi-tui";
import {
  SparkNativeSession,
  SparkNativeTuiApp,
  type SparkNativeInteractionHandler,
  type SparkNativeResponder,
  type SparkNativeSlashCommandMap,
  type SparkNativeStatusContext,
  type SparkNativeTuiExitReason,
  type SparkNativeWorkspaceSessionState,
} from "../native-tui.ts";
import type { SparkKeybindings } from "@zendev-lab/spark-host/keybindings";
import type { SparkTheme } from "../host/theme.ts";

export interface FakeSparkNativeTuiState {
  readonly children: Component[];
  readonly overlays: Array<{ component: Component; options?: OverlayOptions; visible: boolean }>;
  readonly renderRequests: boolean[];
  focused: unknown;
  exited: boolean;
  exitReason?: SparkNativeTuiExitReason;
}

export interface SparkNativeTuiComponentSnapshot {
  readonly rows: number;
  readonly columns: number;
  readonly focused: boolean;
  readonly exited: boolean;
  readonly toolsExpanded: boolean;
  readonly thinkingExpanded: boolean;
  readonly hub: ReturnType<SparkNativeTuiApp["hubSnapshot"]>;
  readonly actionBar: ReturnType<SparkNativeTuiApp["actionBarSnapshot"]>;
  readonly renderRequests: readonly boolean[];
  readonly renderedLines: readonly string[];
}

export interface SparkNativeTuiComponentHarness {
  readonly tui: TUI;
  readonly app: SparkNativeTuiApp;
  readonly session: SparkNativeSession;
  readonly state: FakeSparkNativeTuiState;
  readonly width: number;
  render(width?: number): string;
  renderLines(width?: number): string[];
  snapshot(width?: number): SparkNativeTuiComponentSnapshot;
  resize(columns: number, rows: number): Promise<void>;
  press(data: string): Promise<void>;
  type(text: string): Promise<void>;
  submitEditor(input: string): Promise<void>;
  submit(input: string): Promise<Awaited<ReturnType<SparkNativeTuiApp["submitInput"]>>>;
  flush(): Promise<void>;
}

export interface SparkNativeTuiComponentHarnessOptions {
  rows?: number;
  cols?: number;
  responder?: SparkNativeResponder;
  slashCommands?: SparkNativeSlashCommandMap;
  autocompleteBasePath?: string;
  autocompleteFdPath?: string | null;
  interactionHandler?: SparkNativeInteractionHandler;
  keybindings?: SparkKeybindings;
  statusContext?: SparkNativeStatusContext;
  theme?: SparkTheme;
  withOverlay?: boolean;
  workspaceSession?: SparkNativeWorkspaceSessionState;
  prepareEditorInput?: (input: string, basePath: string) => Promise<string>;
}

export function createSparkNativeTuiComponentHarness(
  options: SparkNativeTuiComponentHarnessOptions = {},
): SparkNativeTuiComponentHarness {
  const width = options.cols ?? 100;
  const state: FakeSparkNativeTuiState = {
    children: [],
    overlays: [],
    renderRequests: [],
    focused: undefined,
    exited: false,
  };
  const terminal = { rows: options.rows ?? 30, columns: width };
  const fakeTui = {
    terminal,
    requestRender(force?: boolean) {
      state.renderRequests.push(force === true);
    },
    addChild(component: Component) {
      state.children.push(component);
    },
    removeChild(component: Component) {
      const index = state.children.indexOf(component);
      if (index >= 0) state.children.splice(index, 1);
    },
    setFocus(component: unknown) {
      state.focused = component;
    },
    showOverlay: options.withOverlay
      ? (component: Component, overlayOptions?: OverlayOptions) => {
          const entry = { component, options: overlayOptions, visible: true };
          state.overlays.push(entry);
          state.focused = component;
          return {
            hide() {
              entry.visible = false;
              state.renderRequests.push(false);
            },
          };
        }
      : undefined,
  } as unknown as TUI;

  const session = new SparkNativeSession(options.responder);
  const app = new SparkNativeTuiApp(
    fakeTui,
    session,
    (reason) => {
      state.exited = true;
      state.exitReason = reason ?? "exit";
    },
    options,
  );

  return {
    tui: fakeTui,
    app,
    session,
    state,
    get width() {
      return terminal.columns;
    },
    render(renderWidth = width) {
      return app.render(renderWidth).join("\n");
    },
    renderLines(renderWidth = terminal.columns) {
      return app.render(renderWidth);
    },
    snapshot(renderWidth = terminal.columns) {
      return {
        rows: terminal.rows,
        columns: renderWidth,
        focused: app.focused,
        exited: state.exited,
        toolsExpanded: app.areToolsExpanded(),
        thinkingExpanded: app.isThinkingExpanded(),
        hub: app.hubSnapshot(),
        actionBar: app.actionBarSnapshot(),
        renderRequests: [...state.renderRequests],
        renderedLines: app.render(renderWidth),
      };
    },
    async resize(columns: number, rows: number) {
      terminal.columns = Math.max(1, columns);
      terminal.rows = Math.max(1, rows);
      app.invalidate();
      await flushNativeTuiMicrotasks();
    },
    async press(data: string) {
      app.handleInput(data);
      await flushNativeTuiMicrotasks();
    },
    async type(text: string) {
      for (const character of text) {
        app.handleInput(character);
      }
      await flushNativeTuiMicrotasks();
    },
    async submitEditor(input: string) {
      app.setEditorText(input);
      app.handleInput("\r");
      await flushNativeTuiMicrotasks();
    },
    async submit(input: string) {
      const result = await app.submitInput(input);
      await flushNativeTuiMicrotasks();
      return result;
    },
    flush: flushNativeTuiMicrotasks,
  };
}

export async function flushNativeTuiMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Some native submit paths (notably visible bang commands) cross a child
  // process boundary; give those macrotasks a deterministic chance to settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
