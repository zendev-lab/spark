/** SparkNativeTuiApp — native pi-tui host surface (input, slash, ask, render, hub). */

import { homedir } from "node:os";

import {
  SparkAskFlowController,
  type RenderTheme as AskRenderTheme,
  type SparkAskFlowResult,
} from "@zendev-lab/spark-ask";
import {
  SPARK_PROTOCOL_VERSION,
  createBlockedInteractionResponse,
  parseSparkInteractionResponse,
  parseSparkViewModelEvent,
  sparkSlashActionBarForInput,
  type SparkActionBarView,
  type SparkActionView,
  type SparkArtifactView,
  type SparkInteractionRequest,
  type SparkInteractionResponse,
  type SparkRunView,
  type SparkSessionView,
  type SparkTaskView,
  type SparkViewModelEvent,
} from "@zendev-lab/spark-protocol";

import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  Markdown,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
  type Focusable,
  type OverlayOptions,
  type SlashCommand,
  type TUI,
} from "../tui/pi-tui-adapter.ts";
import type { SparkKeybindingContext, SparkKeybindings } from "../host/keybindings.ts";
import {
  createSparkHostRenderTheme,
  createSparkMarkdownTheme,
  styleSparkDiffLine,
  styleSparkRoleLine,
  type SparkTheme,
} from "../host/theme.ts";
import type {
  SparkHostCustomMessage,
  SparkHostMessageRenderer,
  SparkHostRenderTheme,
} from "../host/types.ts";
import {
  createSparkTuiActionBarComponent,
  type SparkTuiActionAvailability,
  type SparkTuiActionBarComponent,
} from "../tui/action-bar.ts";
import type { SparkModelSelectorTheme, SparkModelSelectorTuiLike } from "../tui/model-selector.ts";

import { composeSparkNativeFrame } from "./layout.ts";
import {
  channelQuotePreviewFromDetails,
  compactToolPreview,
  canonicalToolStatus,
  isRecord,
  stringFromRecord,
  toolStatusColor,
  toolStatusIcon,
  userSenderLabelFromDetails,
} from "./message-view.ts";
import {
  addFooterMetrics,
  footerMetricsFromRecord,
  footerMetricsFromRun,
  formatFooterMetrics,
  mergeFooterMetrics,
  runTimeMs,
} from "./footer-metrics.ts";
import {
  compareRunsForHub,
  createSparkNativeHubState,
  graftSummaryFromRecord,
  isDoneTaskStatus,
  isReviewArtifact,
  isSparkNativeHubPanel,
  isSparkNativeLocalControlCommand,
  workflowRunControlHints,
  workflowRunDisplayStatus,
} from "./hub-helpers.ts";
import {
  compactNativeQueuePreview,
  parseBangCommand,
  prepareSparkNativeEditorInput,
  runSparkNativeBangCommand,
} from "./editor-input.ts";
import {
  catalogSparkNativeCommands,
  SPARK_NATIVE_COMMAND_GROUP_ORDER,
} from "./command-presentation.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  nativeKernelSlashCommandEntries,
  parseSlashCommand,
} from "./slash-commands.ts";
import {
  createNativeWidgetComponent,
  normalizeNativeWidgetLines,
  renderNativeWidgetComponent,
} from "./widgets.ts";
import { nativeAskAnswers, nativeAskFlowRequest, nativeAskLanguage } from "./ask-helpers.ts";
import {
  presentNativeInputPrompt,
  presentNativeSecretPrompt,
  presentNativeSelectPrompt,
} from "./prompt.ts";
import { createEditorTheme, DEFAULT_NATIVE_THEME, isOverlayRequest } from "./theme-helpers.ts";
import {
  NATIVE_WORKING_SPINNER_FRAMES,
  NATIVE_WORKING_SPINNER_INTERVAL_MS,
  nativeTuiStrings,
} from "./strings.ts";
import { SparkNativeSession } from "./session.ts";
import { SparkTerminalController } from "./controller.ts";
import {
  MAX_NATIVE_QUEUE_ITEMS,
  MAX_HUB_PANEL_ROWS,
  SPARK_HUB_PANELS,
  type SparkNativeHubPanel,
  type SparkNativeHubSnapshot,
  type SparkNativeFooterMetrics,
  type SparkNativeInteractionHandler,
  type SparkNativeMessage,
  type SparkNativeMessageRole,
  type SparkNativeQueueMode,
  type SparkNativeSlashCommandMap,
  type SparkNativeStatusContext,
  type SparkNativeToolStatus,
  type SparkNativeTuiAppOptions,
  type SparkNativeWidget,
  type SparkNativeWorkspaceSessionState,
} from "./types.ts";

type AskFlowInteractionRequest = Extract<SparkInteractionRequest, { kind: "askFlow" }>;
type AskFlowInteractionResponse = Extract<SparkInteractionResponse, { kind: "askFlow" }>;
type NativePresentationKind = "overlay" | "child";

interface NativeCustomLifecycle {
  onPresented?: (kind: NativePresentationKind, component: Component) => void;
  onClosed?: () => void;
}

const MAX_SETTLED_ASK_LIFECYCLE = 32;

type NativeWidgetFactory = (
  tui: { terminal: { columns: number }; requestRender(): void },
  theme: SparkHostRenderTheme,
) => Component | { render(width?: number): string[]; invalidate?(): void } | undefined;

export class SparkNativeTuiApp implements Component, Focusable {
  private readonly editor: Editor;
  private readonly tui: TUI;
  private readonly session: SparkNativeSession;
  private readonly onExit: () => void;
  private readonly messageRenderers: ReadonlyMap<string, SparkHostMessageRenderer>;
  private readonly keybindings?: SparkKeybindings;
  private readonly keybindingContext: SparkKeybindingContext;
  private readonly slashCommands: SparkNativeSlashCommandMap;
  private readonly interactionHandler?: SparkNativeInteractionHandler;
  private readonly statusContext?: SparkNativeStatusContext;
  private readonly inputBasePath: string;
  private readonly theme: SparkTheme;
  private readonly renderTheme: SparkHostRenderTheme;
  private workspaceSession?: SparkNativeWorkspaceSessionState;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, SparkNativeWidget>();
  private readonly hub = createSparkNativeHubState();
  private readonly completedTaskSummaryKeys = new Set<string>();
  private readonly controller = new SparkTerminalController();
  private readonly activeAskFlows = new Map<string, Promise<AskFlowInteractionResponse>>();
  private readonly settledAskResponses = new Map<string, AskFlowInteractionResponse>();
  private readonly pendingAskPresentations = new Map<string, NativePresentationKind>();
  private activeActionBarView: SparkActionBarView | undefined;
  private activeActionBar: SparkTuiActionBarComponent | undefined;
  private actionBarHandle: { hide(): void } | undefined;
  private sessionFooterMetrics: SparkNativeFooterMetrics = {};
  private readonly runFooterMetrics = new Map<string, SparkNativeFooterMetrics>();
  private workingSpinnerFrame = 0;
  private workingSpinnerTimer: ReturnType<typeof setInterval> | undefined;
  private readonly handleSessionChange = () => {
    this.syncWorkingSpinner();
    this.invalidate();
    this.tui.requestRender();
  };

  constructor(
    tui: TUI,
    session: SparkNativeSession,
    onExit: () => void,
    options: SparkNativeTuiAppOptions = {},
  ) {
    this.tui = tui;
    this.session = session;
    this.onExit = onExit;
    this.messageRenderers = options.messageRenderers ?? new Map();
    this.keybindings = options.keybindings;
    this.keybindingContext = options.keybindingContext ?? { hasUI: true };
    this.slashCommands = {
      ...createSparkNativeLocalControlSlashCommands(),
      ...options.slashCommands,
    };
    this.interactionHandler = options.interactionHandler;
    this.statusContext = options.statusContext;
    this.inputBasePath = options.autocompleteBasePath ?? process.cwd();
    this.theme = options.theme ?? DEFAULT_NATIVE_THEME;
    this.renderTheme = createSparkHostRenderTheme(this.theme);
    this.workspaceSession = options.workspaceSession;
    this.registerToggleKeybindings(options.keybindings);
    this.editor = new Editor(tui, createEditorTheme(this.theme), { paddingX: 1 });
    this.installAutocompleteProvider(options);
    this.editor.onSubmit = (text) => {
      void this.submitEditorText(text, { mode: this.primarySubmitMode() });
    };
    this.session.onChange = this.handleSessionChange;
    this.syncWorkingSpinner();
  }

  get focused(): boolean {
    return this.controller.viewState.focused;
  }

  set focused(value: boolean) {
    this.controller.dispatch({ type: "focus.set", focused: value });
    this.editor.focused = value;
  }

  dispose(): void {
    this.closeActionBar();
    this.session.detach();
    if (this.session.onChange === this.handleSessionChange) this.session.onChange = undefined;
    this.stopWorkingSpinner();
  }

  setEditorText(text: string): void {
    if (this.editor.isShowingAutocomplete()) this.editor.handleInput(Key.escape);
    this.editor.setText(text);
    this.invalidate();
    this.tui.requestRender();
  }

  async executeSlashCommand(input: string): Promise<void> {
    await this.runSlashCommand(input);
  }

  input(title: string, defaultValue?: string): Promise<string | undefined> {
    return presentNativeInputPrompt(this, this.renderTheme, title, defaultValue);
  }

  secret(title: string): Promise<string | undefined> {
    return presentNativeSecretPrompt(this, this.renderTheme, title);
  }

  select(title: string, options: readonly string[]): Promise<string | undefined> {
    return presentNativeSelectPrompt(this, this.renderTheme, title, options);
  }

  actionBarSnapshot(): { id: string; selectedActionId?: string; focused: boolean } | undefined {
    if (!this.activeActionBarView || !this.activeActionBar) return undefined;
    return {
      id: this.activeActionBarView.id,
      selectedActionId: this.activeActionBar.selectedAction?.id,
      focused: this.activeActionBar.focused,
    };
  }

  renderQueueInspection(): string {
    const queued = this.session.queuedInputs;
    const daemonPending = this.session.daemonQueued;
    if (queued.length === 0 && daemonPending.length === 0) return "Turn queue is empty.";
    if (this.session.daemonOwnsQueue) {
      return [
        `Daemon turn queue: ${queued.length} awaiting admission · ${daemonPending.length} waiting`,
        ...queued.map(
          (input, index) =>
            `${index + 1}. admitting ${input.mode === "followUp" ? "follow-up" : "steer"} — ${compactNativeQueuePreview(input.text)}`,
        ),
        ...daemonPending.map(
          (turn, index) =>
            `${queued.length + index + 1}. ${turn.status} ${turn.invocationId} — ${compactNativeQueuePreview(turn.prompt)}`,
        ),
      ].join("\n");
    }
    return [
      `Turn queue: ${queued.length} pending input${queued.length === 1 ? "" : "s"}`,
      ...queued.map(
        (input, index) =>
          `${index + 1}. ${input.mode === "followUp" ? "follow-up" : "steer"} — ${compactNativeQueuePreview(input.text)}`,
      ),
    ].join("\n");
  }

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  async submitInput(input: string): Promise<"started" | "queued" | "ignored" | "command"> {
    return await this.submitPreparedInput(input, { mode: this.primarySubmitMode() });
  }

  private primarySubmitMode(): SparkNativeQueueMode {
    return this.session.daemonOwnsQueue ? "followUp" : "steer";
  }

  private async submitEditorText(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    this.editor.addToHistory(input);
    this.editor.setText("");
    const result = await this.submitPreparedInput(input, options);
    this.invalidate();
    this.tui.requestRender();
    return result;
  }

  private async submitPreparedInput(
    input: string,
    options: { mode: SparkNativeQueueMode },
  ): Promise<"started" | "queued" | "ignored" | "command"> {
    const text = input.trim();
    if (!text) return await this.session.submit(input, options);
    // Host controls must bypass SparkNativeSession.submit: an active turn may queue prompts,
    // but it must never queue or swallow slash commands such as /model and /plan.
    if (text.startsWith("/") && !text.startsWith("//")) {
      await this.runSlashCommand(text);
      this.invalidate();
      this.tui.requestRender();
      return "command";
    }
    const bang = parseBangCommand(input);
    if (bang?.hidden) {
      const hiddenResult = await runSparkNativeBangCommand(bang.command, true, this.inputBasePath);
      this.session.addToolMessage({ toolName: "shell", text: hiddenResult, status: "success" });
      return "ignored";
    }
    try {
      const prepared = await prepareSparkNativeEditorInput(input, this.inputBasePath);
      return await this.session.submit(prepared, options);
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.inputPreparationFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
      return "ignored";
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.alt("enter"))) {
      void this.submitEditorText(this.editor.getExpandedText(), { mode: "followUp" });
      return;
    }
    if (this.handleHubPanelInput(data)) return;
    if (matchesKey(data, Key.escape)) {
      const restoredText = this.session.abort("escape").restoredText;
      if (restoredText) this.editor.setText(restoredText);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.alt("up"))) {
      const restoredText = this.session.restoreQueuedText();
      if (restoredText) {
        this.editor.setText(restoredText);
        this.session.addSystemMessage("Restored queued input to the editor.");
      } else {
        this.session.addSystemMessage(nativeTuiStrings.noQueuedInputToRestore);
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
      this.onExit();
      return;
    }
    if (this.handleSparkKeybinding(data)) return;
    if (!this.keybindings && matchesKey(data, Key.ctrl("o"))) {
      this.toggleTools();
      return;
    }
    if (!this.keybindings && matchesKey(data, Key.ctrl("t"))) {
      this.toggleThinking();
      return;
    }
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  setWorkspaceSession(state: SparkNativeWorkspaceSessionState | undefined): void {
    this.workspaceSession = state;
    this.invalidate();
    this.tui.requestRender();
  }

  setStatus(key: string, text: string | undefined): void {
    if (!key) return;
    if (text === undefined || text.trim() === "") this.statuses.delete(key);
    else this.statuses.set(key, text);
    this.invalidate();
    this.tui.requestRender();
  }

  setWidget(
    key: string,
    content: unknown,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    if (!key) return;
    const placement = options?.placement ?? "aboveEditor";
    if (content === undefined || content === null || content === false) {
      this.widgets.delete(key);
    } else if (typeof content === "function") {
      const component = createNativeWidgetComponent(
        content as NativeWidgetFactory,
        this.tui,
        this.renderTheme,
        () => this.invalidate(),
      );
      if (!component) this.widgets.delete(key);
      else this.widgets.set(key, { key, component, placement });
    } else {
      const lines = normalizeNativeWidgetLines(content);
      if (lines.length === 0) this.widgets.delete(key);
      else this.widgets.set(key, { key, lines, placement });
    }
    this.invalidate();
    this.tui.requestRender();
  }

  hubSnapshot(): SparkNativeHubSnapshot {
    return {
      activePanel: this.controller.viewState.activeHubPanel,
      sessionId: this.hub.sessionId,
      sessionStatus: this.hub.sessionStatus,
      workflows: this.hub.workflows.size,
      workflowRuns: [...this.hub.runs.values()].filter((run) => run.kind === "workflow").length,
      roleRuns: [...this.hub.runs.values()].filter((run) => run.kind === "role").length,
      tasks: this.hub.tasks.size,
      artifacts: this.hub.artifacts.size,
      evidence: this.hub.evidence.size,
      reviews: this.reviewItems().length,
      graftItems: this.graftItems().length,
      interactions: this.hub.interactions.size,
    };
  }

  toggleHubPanel(panel: SparkNativeHubPanel = "overview"): boolean {
    const state = this.controller.dispatch({ type: "hub.toggle", panel });
    if (state.activeHubPanel === "runs" || state.activeHubPanel === "workflows") {
      this.ensureWorkflowRunSelection();
    }
    this.invalidate();
    this.tui.requestRender();
    return state.activeHubPanel !== undefined;
  }

  cycleHubPanel(): SparkNativeHubPanel {
    const next =
      this.controller.dispatch({ type: "hub.cycle", panels: SPARK_HUB_PANELS }).activeHubPanel ??
      "overview";
    if (next === "runs" || next === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    return next;
  }

  private handleHubPanelInput(data: string): boolean {
    const activePanel = this.controller.viewState.activeHubPanel;
    if (activePanel !== "runs" && activePanel !== "workflows") {
      return false;
    }
    if (matchesKey(data, Key.escape)) {
      this.controller.dispatch({ type: "hub.close" });
      this.invalidate();
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.moveWorkflowRunSelection(-1);
      return true;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.moveWorkflowRunSelection(1);
      return true;
    }
    if (matchesKey(data, Key.enter) || data === "i") {
      this.runSelectedWorkflowCommand("inspect");
      return true;
    }
    if (data === "p") {
      this.runSelectedWorkflowCommand("pause");
      return true;
    }
    if (data === "u") {
      this.runSelectedWorkflowCommand("resume");
      return true;
    }
    if (data === "x") {
      this.runSelectedWorkflowCommand("stop");
      return true;
    }
    if (data === "r") {
      this.runSelectedWorkflowCommand("restart");
      return true;
    }
    if (data === "s") {
      this.runSelectedWorkflowCommand("save");
      return true;
    }
    if (data === "a") {
      this.runSelectedWorkflowCommand("ack");
      return true;
    }
    return false;
  }

  private moveWorkflowRunSelection(delta: number): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) return;
    const selectedIndex = Math.max(
      0,
      runs.findIndex((run) => run.id === this.hub.selectedWorkflowRunId),
    );
    const nextIndex = (selectedIndex + delta + runs.length) % runs.length;
    this.hub.selectedWorkflowRunId = runs[nextIndex]?.id;
    this.invalidate();
    this.tui.requestRender();
  }

  private runSelectedWorkflowCommand(
    action: "inspect" | "pause" | "resume" | "stop" | "restart" | "save" | "ack",
  ): void {
    const run = this.selectedWorkflowRun();
    if (!run) {
      this.session.addSystemMessage(nativeTuiStrings.noWorkflowRunSelected);
      return;
    }
    if (!/^run:[a-zA-Z0-9-]+$/u.test(run.id)) {
      this.session.addSystemMessage(nativeTuiStrings.selectedWorkflowNotLive(run.id));
      return;
    }
    const commandName = `workflow-${action}`;
    if (!this.slashCommands[commandName]) {
      this.session.addSystemMessage(nativeTuiStrings.hostCommandNotRegistered(commandName));
      return;
    }
    void this.runSlashCommand(`/${commandName} ${run.id}`).finally(() => {
      this.invalidate();
      this.tui.requestRender();
    });
  }

  private openActionBar(view: SparkActionBarView): void {
    this.closeActionBar();
    const component = createSparkTuiActionBarComponent({
      view,
      theme: this.renderTheme,
      resolveAvailability: (action) => this.resolveActionAvailability(action),
      requestRender: () => this.tui.requestRender(),
      onCancel: () => this.closeActionBar(),
      onAction: async (action) => {
        this.closeActionBar();
        await this.executeActionBarAction(action);
      },
    });
    this.activeActionBarView = view;
    this.activeActionBar = component;
    if (typeof this.tui.showOverlay === "function") {
      this.actionBarHandle = this.tui.showOverlay(component, {
        width: "72%",
        minWidth: 44,
        maxHeight: 6,
        anchor: "bottom-center",
        margin: { bottom: 3, left: 1, right: 1 },
      });
    } else {
      this.tui.addChild(component);
      this.tui.setFocus(component);
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private resolveActionAvailability(action: SparkActionView): SparkTuiActionAvailability {
    const requiredCommand = this.requiredActionCommand(action);
    if (requiredCommand && !this.slashCommands[requiredCommand]) {
      return {
        disabled: true,
        reason: `/${requiredCommand} is not registered in this host`,
      };
    }

    if (action.intent === "turn.retry" && !this.session.canRetry) {
      return {
        disabled: true,
        reason: this.session.isProcessing
          ? "wait for the active turn to finish"
          : "no previous prompt to retry",
      };
    }
    if (action.intent === "turn.stop" && !this.session.canStopOrRestore) {
      return { disabled: true, reason: "no active turn or queued input" };
    }
    if (action.intent === "workflow.inspect") {
      const selected = this.selectedWorkflowRun();
      if (!selected) return { disabled: true, reason: "no workflow run is selected" };
      if (!/^run:[a-zA-Z0-9-]+$/u.test(selected.id)) {
        return { disabled: true, reason: `selected workflow ${selected.id} is not live` };
      }
    }
    return { disabled: false };
  }

  private requiredActionCommand(action: SparkActionView): string | undefined {
    switch (action.intent) {
      case "model.select":
        return "model";
      case "thinking.select":
      case "settings.inspect":
        return "settings";
      case "settings.providers":
        return "login";
      case "status.inspect":
        return "status";
      case "session.select":
      case "session.create":
        return "sessions";
      case "session.inspect":
        return "session";
      case "turn.stop":
        return "stop";
      case "turn.retry":
        return "retry";
      case "goal.status":
      case "goal.start":
      case "goal.restart":
      case "goal.stop":
        return "goal";
      case "loop.status":
      case "loop.start":
      case "loop.restart":
      case "loop.stop":
        return "loop";
      case "repro.status":
      case "repro.start":
      case "repro.restart":
      case "repro.stop":
        return "repro";
      case "workflow.inspect":
        return "workflow-inspect";
      case "help.hotkeys":
        return "hotkeys";
      case "queue.inspect":
      case "workflow.open":
      case "help.commands":
        return undefined;
    }
  }

  private closeActionBar(): void {
    const component = this.activeActionBar;
    if (!component) return;
    if (this.actionBarHandle) this.actionBarHandle.hide();
    else this.tui.removeChild(component);
    this.actionBarHandle = undefined;
    this.activeActionBar = undefined;
    this.activeActionBarView = undefined;
    this.tui.setFocus(this);
    this.invalidate();
    this.tui.requestRender();
  }

  private async executeThinkingSelectAction(action: SparkActionView): Promise<void> {
    const thinkingLevel = stringFromRecord(action.payload, "thinkingLevel");
    if (thinkingLevel) {
      await this.invokeRegisteredSlashCommand("settings", `set thinking ${thinkingLevel}`, false);
      return;
    }
    const thinkingBar = sparkSlashActionBarForInput("/thinking");
    if (thinkingBar) this.openActionBar(thinkingBar);
  }

  private async executeActionBarAction(action: SparkActionView): Promise<void> {
    try {
      switch (action.intent) {
        case "model.select":
          await this.invokeRegisteredSlashCommand("model", "", false);
          return;
        case "thinking.select":
          await this.executeThinkingSelectAction(action);
          return;
        case "settings.inspect":
          await this.invokeRegisteredSlashCommand("settings", "inspect", true);
          return;
        case "settings.providers":
          await this.invokeRegisteredSlashCommand("login", "", true);
          return;
        case "status.inspect":
          await this.invokeRegisteredSlashCommand("status", "", true);
          return;
        case "session.select":
          await this.invokeRegisteredSlashCommand("sessions", "", false);
          return;
        case "session.create":
          await this.invokeRegisteredSlashCommand("sessions", "", false);
          return;
        case "session.inspect":
          await this.invokeRegisteredSlashCommand("session", "inspect", true);
          return;
        case "queue.inspect":
          this.session.addSystemMessage(this.renderQueueInspection());
          return;
        case "turn.stop":
          await this.invokeRegisteredSlashCommand("stop", "", false);
          return;
        case "turn.retry":
          await this.invokeRegisteredSlashCommand("retry", "", false);
          return;
        case "goal.status":
        case "goal.start":
        case "goal.restart":
        case "goal.stop":
        case "loop.status":
        case "loop.start":
        case "loop.restart":
        case "loop.stop":
        case "repro.status":
        case "repro.start":
        case "repro.restart":
        case "repro.stop": {
          const [command, operation] = action.intent.split(".", 2) as [string, string];
          await this.invokeRegisteredSlashCommand(command, operation, operation === "status");
          return;
        }
        case "workflow.open":
          this.openHubPanel("runs");
          return;
        case "workflow.inspect":
          this.runSelectedWorkflowCommand("inspect");
          return;
        case "help.commands":
          this.session.addSystemMessage(this.renderCommandHelp("commands"));
          return;
        case "help.hotkeys":
          await this.invokeRegisteredSlashCommand("hotkeys", "", true);
          return;
      }
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.commandFailed(
          action.intent,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  custom<T>(
    factory: (
      tui: SparkModelSelectorTuiLike,
      theme: SparkModelSelectorTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component,
    options?: unknown,
    lifecycle: NativeCustomLifecycle = {},
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let closed = false;
      let handle: { hide(): void } | undefined;
      let component: Component | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        if (handle) handle.hide();
        else if (component) this.tui.removeChild(component);
        lifecycle.onClosed?.();
        this.tui.setFocus(this);
        this.invalidate();
        this.tui.requestRender();
      };
      const done = (value: T) => {
        if (settled) return;
        settled = true;
        close();
        resolve(value);
      };
      component = factory(
        {
          terminal: { columns: this.tui.terminal.columns },
          requestRender: () => this.tui.requestRender(),
        },
        this.renderTheme,
        this.keybindings,
        done,
      );
      if (settled || closed) {
        close();
        return;
      }
      const overlayOptions = isOverlayRequest(options) ? options.overlayOptions : undefined;
      if (
        (!isOverlayRequest(options) || options.overlay !== false) &&
        typeof this.tui.showOverlay === "function"
      ) {
        handle = this.tui.showOverlay(component, overlayOptions);
        lifecycle.onPresented?.("overlay", component);
      } else {
        this.tui.addChild(component);
        this.tui.setFocus(component);
        lifecycle.onPresented?.("child", component);
      }
      this.invalidate();
      this.tui.requestRender();
    });
  }

  async handleInteractionRequest(
    request: SparkInteractionRequest,
  ): Promise<SparkInteractionResponse> {
    if (request.kind === "askFlow" && !this.interactionHandler) {
      const settled = this.settledAskResponses.get(request.requestId);
      if (settled) return settled;
      const active = this.activeAskFlows.get(request.requestId);
      if (active) return active;

      this.recordInteractionRequest(request);
      const presentation = this.presentAskFlow(request).then((response) => {
        this.rememberSettledAskResponse(response);
        this.completeInteractionRequest(response);
        return response;
      });
      this.activeAskFlows.set(request.requestId, presentation);
      try {
        return await presentation;
      } finally {
        this.activeAskFlows.delete(request.requestId);
      }
    }

    this.recordInteractionRequest(request);
    if (this.interactionHandler) {
      const response = await this.interactionHandler(request, { app: this, session: this.session });
      const parsed = parseSparkInteractionResponse(response);
      this.completeInteractionRequest(parsed);
      return parsed;
    }
    if (request.kind === "askFlow") {
      const response = await this.presentAskFlow(request);
      this.completeInteractionRequest(response);
      return response;
    }
    this.session.addCustomMessage({
      customType: request.kind === "workflowPicker" ? "workflow-picker" : "interaction-request",
      content: `${request.kind}: ${request.title}`,
      display: true,
      details: { request },
    });
    this.invalidate();
    this.tui.requestRender();
    return createBlockedInteractionResponse(request, nativeTuiStrings.noInteractionHandler);
  }

  private async presentAskFlow(
    request: AskFlowInteractionRequest,
  ): Promise<AskFlowInteractionResponse> {
    if (!this.settledAskResponses.has(request.requestId)) {
      this.session.addCustomMessage({
        customType: "interaction-request",
        content: `${request.title}${request.prompt ? `\n${request.prompt}` : ""}`,
        display: true,
        details: { request },
      });
    }
    const flowRequest = nativeAskFlowRequest(request);
    const controller = new SparkAskFlowController({
      request: flowRequest,
      language: nativeAskLanguage(),
    });
    let timedOut = false;
    const resultPromise = this.custom<SparkAskFlowResult>(
      (tui, theme, _keybindings, done) => {
        const terminal = { columns: tui.terminal?.columns ?? this.tui.terminal.columns };
        const view = controller.run(
          { terminal, requestRender: () => tui.requestRender() },
          theme as AskRenderTheme,
          done,
        );
        return {
          render: (width: number) => {
            terminal.columns = Math.max(1, width);
            return view.render();
          },
          handleInput: (data: string) => view.handleInput(data),
          invalidate: () => view.invalidate(),
        };
      },
      {
        overlay: true,
        overlayOptions: this.askOverlayOptions(),
      },
      {
        onPresented: (kind) => this.setPendingAskPresentation(request.requestId, kind),
        onClosed: () => this.clearPendingAskPresentation(request.requestId),
      },
    );
    const timeout = request.timeoutMs
      ? setTimeout(() => {
          timedOut = controller.cancel();
        }, request.timeoutMs)
      : undefined;
    timeout?.unref?.();
    let result: SparkAskFlowResult;
    try {
      result = await resultPromise;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const cancelled = result.cancelled || result.status === "cancelled";
    return {
      version: SPARK_PROTOCOL_VERSION,
      kind: "askFlow",
      requestId: request.requestId,
      status: cancelled ? "cancelled" : "answered",
      answers: nativeAskAnswers(result),
      nextAction: cancelled
        ? "cancel"
        : result.nextAction === "block" || result.nextAction === "clarify_then_reask"
          ? "block"
          : "resume",
      metadata: {
        surface: "native-tui",
        ...(timedOut && cancelled ? { timedOut: true } : {}),
      },
    };
  }

  private askOverlayOptions(): OverlayOptions {
    const columns = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    const horizontalMargin = columns < 72 ? 1 : 2;
    const verticalMargin = rows < 22 ? 1 : 2;
    const availableWidth = Math.max(1, columns - horizontalMargin * 2);
    const preferredWidth = Math.min(96, Math.max(40, Math.floor(columns * 0.8)));
    return {
      anchor: "center",
      margin: {
        top: verticalMargin,
        bottom: verticalMargin,
        left: horizontalMargin,
        right: horizontalMargin,
      },
      width: Math.min(availableWidth, preferredWidth),
      minWidth: Math.min(availableWidth, 40),
      maxHeight: Math.max(8, rows - verticalMargin * 2),
    };
  }

  private setPendingAskPresentation(requestId: string, kind: NativePresentationKind): void {
    this.pendingAskPresentations.set(requestId, kind);
    this.invalidate();
    this.tui.requestRender();
  }

  private clearPendingAskPresentation(requestId: string): void {
    if (!this.pendingAskPresentations.delete(requestId)) return;
    this.invalidate();
    this.tui.requestRender();
  }

  private renderPendingAskPresentations(width: number): string[] {
    return [...this.pendingAskPresentations.entries()].map(([requestId, kind]) =>
      truncateToWidth(this.renderTheme.fg("accent", `Ask pending · ${requestId} · ${kind}`), width),
    );
  }

  private rememberSettledAskResponse(response: AskFlowInteractionResponse): void {
    this.settledAskResponses.delete(response.requestId);
    this.settledAskResponses.set(response.requestId, response);
    while (this.settledAskResponses.size > MAX_SETTLED_ASK_LIFECYCLE) {
      const oldest = this.settledAskResponses.keys().next().value;
      if (oldest === undefined) break;
      this.settledAskResponses.delete(oldest);
    }
  }

  private completeInteractionRequest(response: SparkInteractionResponse): void {
    if (response.status !== "pending") {
      this.hub.interactions.delete(response.requestId);
      this.invalidate();
      this.tui.requestRender();
    }
  }

  hydrateHub(input: {
    sessionId?: string;
    sessionTitle?: string;
    sessionStatus?: SparkSessionView["status"];
    tasks?: SparkTaskView[];
    artifacts?: SparkArtifactView[];
  }): void {
    if (input.sessionId) this.hub.sessionId = input.sessionId;
    if (input.sessionTitle) this.hub.sessionTitle = input.sessionTitle;
    if (input.sessionStatus) this.hub.sessionStatus = input.sessionStatus;
    for (const task of input.tasks ?? []) this.hub.tasks.set(task.ref, task);
    for (const artifact of input.artifacts ?? []) this.hub.artifacts.set(artifact.ref, artifact);
    this.invalidate();
    this.tui.requestRender();
  }

  applyViewModelEvent(event: SparkViewModelEvent): void {
    const parsed = parseSparkViewModelEvent(event);
    switch (parsed.type) {
      case "session.snapshot":
        this.recordSessionView(parsed.session);
        this.session.applySessionView(parsed.session);
        break;
      case "session.message":
        this.session.addMessageView(parsed.message);
        break;
      case "run.update":
        this.recordRunView(parsed.run);
        break;
      case "loop.update":
        this.hub.loops.set(parsed.loop.loopId, parsed.loop);
        break;
      case "task.update": {
        this.hub.tasks.set(parsed.task.ref, parsed.task);
        const evidenceSummary = this.taskCompletionEvidenceSummary(parsed.task);
        if (evidenceSummary) this.session.addSystemMessage(evidenceSummary);
        break;
      }
      case "artifact.update":
        this.hub.artifacts.set(parsed.artifact.ref, parsed.artifact);
        break;
      case "evidence.update":
        this.hub.evidence.set(parsed.evidence.ref, parsed.evidence);
        break;
      default: {
        const _exhaustive: never = parsed;
        void _exhaustive;
        break;
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }

  private recordSessionView(view: SparkSessionView): void {
    this.hub.sessionId = view.sessionId;
    this.hub.sessionTitle = view.title;
    this.hub.sessionStatus = view.status;
    if (view.cwd) this.hub.cwd = view.cwd;
    else delete this.hub.cwd;
    if (view.gitBranch) this.hub.gitBranch = view.gitBranch;
    else delete this.hub.gitBranch;
    if (view.model) this.hub.model = view.model;
    else delete this.hub.model;
    if (view.thinkingLevel) this.hub.thinkingLevel = view.thinkingLevel;
    else delete this.hub.thinkingLevel;
    this.sessionFooterMetrics = view.usage ? footerMetricsFromRecord(view.usage) : {};
    this.runFooterMetrics.clear();
    this.hub.runs.clear();
    this.hub.tasks.clear();
    this.hub.artifacts.clear();
    this.hub.evidence.clear();
    this.hub.loops.clear();
    for (const loop of view.loops ?? []) {
      this.hub.loops.set(loop.loopId, loop);
    }
    for (const run of view.runs) this.recordRunView(run, false);
    if (view.runs.length === 0) this.recordActiveRunStatus();
    for (const task of view.tasks) this.hub.tasks.set(task.ref, task);
    for (const artifact of view.artifacts) {
      if (
        artifact.ref.startsWith("artifact:") &&
        (artifact.kind === "issue" ||
          artifact.kind === "git_change" ||
          artifact.kind === "document" ||
          artifact.kind === "pr" ||
          artifact.kind === "preview")
      ) {
        this.hub.artifacts.set(artifact.ref, artifact);
      } else {
        this.hub.evidence.set(artifact.ref, {
          version: artifact.version,
          ref: artifact.ref,
          title: artifact.title,
          kind:
            artifact.kind === "document" ||
            artifact.kind === "record" ||
            artifact.kind === "trace" ||
            artifact.kind === "knowledge"
              ? artifact.kind
              : "other",
          format:
            artifact.format === "markdown" ||
            artifact.format === "json" ||
            artifact.format === "text" ||
            artifact.format === "blob"
              ? artifact.format
              : "other",
          ...(artifact.status ? { status: artifact.status } : {}),
          ...(artifact.producer ? { producer: artifact.producer } : {}),
          ...(artifact.createdAt ? { createdAt: artifact.createdAt } : {}),
          ...(artifact.updatedAt ? { updatedAt: artifact.updatedAt } : {}),
          ...(artifact.preview ? { preview: artifact.preview } : {}),
          metadata: artifact.metadata,
        });
      }
    }
    for (const evidence of view.evidence ?? []) this.hub.evidence.set(evidence.ref, evidence);
  }

  private recordRunView(run: SparkRunView, includeUsage = true): void {
    this.hub.runs.set(run.id, run);
    this.recordCacheUsageStatus(run, includeUsage);
    this.recordActiveRunStatus();
    if (run.kind === "workflow") {
      const selector = stringFromRecord(run.metadata, "selector") ?? run.id;
      this.hub.workflows.set(selector, {
        selector,
        label: run.title ?? run.summary ?? run.id,
        description: run.summary,
        source: "run",
      });
      this.ensureWorkflowRunSelection();
    }
  }

  private recordCacheUsageStatus(run: SparkRunView, includeUsage: boolean): void {
    if (run.summary && /\bcache read=\d+ write=\d+/iu.test(run.summary)) {
      this.statuses.set("cache-usage", run.summary);
    }
    if (!includeUsage) return;
    const next = footerMetricsFromRun(run);
    if (!Object.values(next).some((value) => value !== undefined)) return;
    const current = this.runFooterMetrics.get(run.id) ?? {};
    this.runFooterMetrics.delete(run.id);
    this.runFooterMetrics.set(run.id, mergeFooterMetrics(current, next));
  }

  private taskCompletionEvidenceSummary(task: SparkTaskView): string | undefined {
    if (!isDoneTaskStatus(task.status)) return undefined;
    const key = `${task.ref}:${task.status}:${task.evidenceRefs.join(",")}`;
    if (this.completedTaskSummaryKeys.has(key)) return undefined;
    this.completedTaskSummaryKeys.add(key);
    const evidenceCount = task.evidenceRefs.length;
    const reviewStatus = this.taskReviewStatus(task);
    return [
      "✔ task done",
      `${evidenceCount} evidence`,
      reviewStatus ? `review ${reviewStatus}` : "review not recorded",
      `inspect locally with /inspect tasks (${task.ref})`,
    ].join(" · ");
  }

  private taskReviewStatus(task: SparkTaskView): string | undefined {
    const metadataStatus =
      stringFromRecord(task.metadata, "reviewStatus") ??
      stringFromRecord(task.metadata, "reviewOutcome") ??
      stringFromRecord(task.metadata, "review") ??
      stringFromRecord(task.metadata, "verdict") ??
      stringFromRecord(task.metadata, "outcome");
    if (metadataStatus) return metadataStatus;
    for (const ref of task.evidenceRefs) {
      const artifact = this.hub.artifacts.get(ref) ?? this.hub.evidence.get(ref) ?? undefined;
      if (!artifact || !isReviewArtifact(artifact)) continue;
      return (
        stringFromRecord(artifact.metadata, "outcome") ??
        stringFromRecord(artifact.metadata, "verdict") ??
        artifact.status ??
        "recorded"
      );
    }
    return undefined;
  }

  private recordActiveRunStatus(): void {
    const activeRuns = [...this.hub.runs.values()]
      .filter((run) => run.status === "queued" || run.status === "running")
      .sort((left, right) => runTimeMs(left) - runTimeMs(right));
    const active = activeRuns.at(-1);
    if (!active) {
      this.statuses.delete("active-run");
      return;
    }
    const label = active.summary?.trim() || active.title?.trim() || active.id;
    this.statuses.set("active-run", `${active.kind} ${active.status}: ${label}`);
  }

  private recordInteractionRequest(request: SparkInteractionRequest): void {
    this.hub.interactions.set(request.requestId, request);
    if (request.kind === "workflowPicker") {
      for (const option of request.options) {
        this.hub.workflows.set(option.selector, {
          selector: option.selector,
          label: option.label,
          description: option.description,
          source: "interaction",
        });
      }
    }
    this.invalidate();
    this.tui.requestRender();
  }

  toggleTools(): boolean {
    const state = this.controller.dispatch({ type: "tools.toggle" });
    this.invalidate();
    this.tui.requestRender();
    return state.toolsExpanded;
  }

  toggleThinking(): boolean {
    const state = this.controller.dispatch({ type: "thinking.toggle" });
    this.invalidate();
    this.tui.requestRender();
    return state.thinkingExpanded;
  }

  areToolsExpanded(): boolean {
    return this.controller.viewState.toolsExpanded;
  }

  isThinkingExpanded(): boolean {
    return this.controller.viewState.thinkingExpanded;
  }

  private handleSparkKeybinding(data: string): boolean {
    const key = parseKey(data) ?? data;
    const keybindings = this.keybindings;
    if (!keybindings || !keybindings.canExecuteKey(key, this.keybindingContext)) return false;
    void keybindings.executeKey(key, this.keybindingContext).then(
      (didHandle) => {
        if (didHandle) {
          this.invalidate();
          this.tui.requestRender();
        }
      },
      (error: unknown) => {
        this.session.addSystemMessage(
          nativeTuiStrings.keybindingFailed(error instanceof Error ? error.message : String(error)),
        );
        this.invalidate();
        this.tui.requestRender();
      },
    );
    return true;
  }

  private installAutocompleteProvider(options: SparkNativeTuiAppOptions): void {
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        this.autocompleteSlashCommands(),
        options.autocompleteBasePath ?? process.cwd(),
        options.autocompleteFdPath ?? null,
      ),
    );
  }

  private autocompleteSlashCommands(): SlashCommand[] {
    return catalogSparkNativeCommands(this.slashCommands, nativeKernelSlashCommandEntries()).map(
      (entry) => ({
        name: entry.name,
        description: entry.description,
        argumentHint: entry.argumentHint,
        getArgumentCompletions: entry.command?.getArgumentCompletions,
      }),
    );
  }

  private registerToggleKeybindings(keybindings: SparkKeybindings | undefined): void {
    if (!keybindings) return;
    keybindings.register({
      id: "app.toggleTools",
      defaultKey: "ctrl+o",
      description: nativeTuiStrings.keybindings.toggleTools,
      handler: () => void this.toggleTools(),
    });
    keybindings.register({
      id: "app.toggleThinking",
      defaultKey: "ctrl+t",
      description: nativeTuiStrings.keybindings.toggleThinking,
      handler: () => void this.toggleThinking(),
    });
    keybindings.register({
      id: "app.toggleHub",
      defaultKey: "ctrl+k",
      description: nativeTuiStrings.keybindings.toggleHub,
      handler: () => void this.toggleHubPanel(),
    });
    keybindings.register({
      id: "app.cycleHubPanel",
      defaultKey: "shift+ctrl+k",
      description: nativeTuiStrings.keybindings.cycleHubPanel,
      handler: () => void this.cycleHubPanel(),
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
    for (const widget of this.widgets.values()) widget.component?.invalidate?.();
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
      return this.cachedLines;
    }

    const header = [
      truncateToWidth(
        [
          this.renderTheme.bold(this.renderTheme.fg("accent", nativeTuiStrings.appTitle)),
          this.renderTheme.fg("muted", this.statusLine()),
        ].join(" · "),
        width,
      ),
    ];
    const context = this.renderWorkspaceSessionState(width);
    const detail = this.renderActiveHubPanel(width);
    const pinnedStatus = [...header, ...context, ...this.renderWidgets("aboveEditor", width)];
    const auxiliary = this.renderPendingAskPresentations(width);
    const transcript = this.session.messages.flatMap((message) =>
      this.renderMessage(message, width),
    );
    const queue = this.renderInputQueue(width);
    const composer = [this.separatorLine(width), ...this.editor.render(width)];
    const footer = [
      ...(this.widgets.has("spark-status") ? [] : this.renderTaskStatus(width)),
      ...this.renderWidgets("belowEditor", width),
      truncateToWidth(this.renderTheme.fg("muted", this.footerLine()), width),
    ];
    const runtimeFooter = this.runtimeFooterLines(width);

    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = composeSparkNativeFrame({
      width,
      height,
      sections: {
        header: [],
        context: [],
        detail,
        detailActive: detail.length > 0,
        auxiliary,
        transcript,
        pinnedStatus,
        queue,
        composer,
        footer,
        runtimeFooter,
      },
    });
    return this.cachedLines;
  }

  private renderWorkspaceSessionState(width: number): string[] {
    const state = this.workspaceSession;
    if (!state) return [];
    const title =
      state.mode === "attached"
        ? "Spark session attached"
        : state.mode === "mismatch"
          ? "Spark session attach blocked"
          : "Select Spark session";
    const details = [
      title,
      `workspace: ${state.workspaceDir}`,
      `workspace hash: ${state.workspaceHash}`,
      ...(state.controlPlaneSessionId
        ? [`control-plane session: ${state.controlPlaneSessionId}`]
        : []),
      ...(state.attachTarget ? [`attach target: ${state.attachTarget}`] : []),
      ...(state.mode === "select" ? ["attach a daemon-managed session"] : []),
      ...(state.mismatchDiagnostic ? [`diagnostic: ${state.mismatchDiagnostic}`] : []),
    ];
    return [truncateToWidth(this.renderTheme.fg("muted", details.join(" • ")), width)];
  }

  private renderInputQueue(width: number): string[] {
    const queued = this.session.queuedInputs;
    const daemonPending = this.session.daemonQueued;
    if (queued.length === 0 && daemonPending.length === 0) return [];

    const visible = queued.slice(0, MAX_NATIVE_QUEUE_ITEMS);
    const hidden = queued.length - visible.length;
    const daemonOwned = this.session.daemonOwnsQueue;
    const lines = [
      this.renderTheme.bold(
        this.renderTheme.fg(
          "accent",
          daemonOwned
            ? `◆ Daemon turn queue · admitting ${queued.length} · waiting ${daemonPending.length}`
            : `◆ Input queue · local ${queued.length}` +
                (daemonPending.length > 0 ? ` · daemon ${daemonPending.length}` : ""),
        ),
      ),
      this.renderTheme.fg(
        "muted",
        daemonOwned
          ? "│ daemon owns execution · Esc cancels the active invocation"
          : "│ Enter steer · Alt+Enter follow-up · Alt+Up restore all",
      ),
    ];
    for (const [index, input] of visible.entries()) {
      const isLast = index === visible.length - 1 && hidden === 0 && daemonPending.length === 0;
      const marker = isLast ? "└─" : "├─";
      const mode = input.mode === "followUp" ? "follow-up" : "steer";
      lines.push(`${marker} ${index + 1}. ${mode} · ${compactNativeQueuePreview(input.text)}`);
    }
    if (hidden > 0) {
      lines.push(`${daemonPending.length > 0 ? "├─" : "└─"} … +${hidden} more local`);
    }
    for (const [index, turn] of daemonPending.entries()) {
      const isLast = index === daemonPending.length - 1;
      const marker = isLast ? "└─" : "├─";
      lines.push(`${marker} daemon ${turn.status} · ${compactNativeQueuePreview(turn.prompt)}`);
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderMessage(message: SparkNativeMessage, width: number): string[] {
    if (message.display === false) return [];
    if (message.role === "tool") return this.renderToolMessage(message, width);
    if (message.role === "thinking") return this.renderThinkingMessage(message, width);
    if (message.role === "custom") return this.renderCustomMessage(message, width);

    const prefix = this.messagePrefix(message);
    const body = message.text || " ";
    const suffix = message.streaming ? " ▋" : "";
    const quoteLines = message.role === "user" ? this.renderChannelQuoteLines(message, width) : [];
    const lines =
      message.role === "assistant"
        ? this.renderPrefixedLines(
            prefix,
            this.renderMarkdownBlock(`${body}${suffix}`, width),
            width,
          )
        : this.renderPrefixedBlock(prefix, `${body}${suffix}`, width);
    return this.styleRoleLines(message.role, [...quoteLines, ...lines]);
  }

  private renderChannelQuoteLines(message: SparkNativeMessage, width: number): string[] {
    const quote = channelQuotePreviewFromDetails(message.details);
    if (!quote) return [];
    const label = quote.senderLabel
      ? this.renderTheme.fg("dim", `│ ${quote.senderLabel}`)
      : this.renderTheme.fg("dim", "│");
    const body = this.renderTheme.fg("dim", `│ ${quote.text}`);
    return [
      truncateToWidth(label, width),
      ...wrapTextWithAnsi(body, width).map((line) => truncateToWidth(line, width)),
    ];
  }

  private renderToolMessage(message: SparkNativeMessage, width: number): string[] {
    const toolName = message.toolName ?? "tool";
    const status = canonicalToolStatus(message.toolStatus ?? "succeeded");
    const header = `tool:${toolName} [${status}]`;
    const icon = toolStatusIcon(status);
    const preview = compactToolPreview(message.text);
    const styledHeader = this.renderToolHeader(header, status, icon);
    const previewDetails = isRecord(message.details?.preview) ? message.details.preview : undefined;
    const isMarkdownPreview =
      toolName === "artifact" &&
      status === "succeeded" &&
      stringFromRecord(message.details ?? {}, "action") === "open_preview" &&
      stringFromRecord(previewDetails ?? {}, "target") === "tui" &&
      (stringFromRecord(previewDetails ?? {}, "mediaType") === "text/markdown" ||
        stringFromRecord(previewDetails ?? {}, "format") === "md");
    if (isMarkdownPreview) {
      const id = message.toolCallId ? this.renderTheme.fg("dim", ` · ${message.toolCallId}`) : "";
      const innerWidth = Math.max(1, width - 2);
      const lines = [
        truncateToWidth(`${this.renderTheme.fg("border", "┌─")} ${styledHeader}${id}`, width),
      ];
      for (const line of this.renderMarkdownBlock(message.text || " ", innerWidth)) {
        lines.push(truncateToWidth(`${this.renderTheme.fg("border", "│")} ${line}`, width));
      }
      lines.push(
        truncateToWidth(
          `${this.renderTheme.fg("border", "└─")} ${this.renderTheme.fg("dim", "Markdown preview")}`,
          width,
        ),
      );
      return lines;
    }
    if (!this.controller.viewState.toolsExpanded) {
      const suffix = this.renderTheme.fg("dim", " • folded (Ctrl+O expand)");
      const previewText = preview ? ` ${this.renderTheme.fg("muted", `— ${preview}`)}` : "";
      return [truncateToWidth(`${styledHeader}${previewText}${suffix}`, width)];
    }

    const id = message.toolCallId ? this.renderTheme.fg("dim", ` · ${message.toolCallId}`) : "";
    const body = this.renderToolBody(message.text || " ");
    const innerWidth = Math.max(1, width - 2);
    const lines = [
      truncateToWidth(`${this.renderTheme.fg("border", "┌─")} ${styledHeader}${id}`, width),
    ];
    for (const line of body.split("\n")) {
      for (const wrapped of wrapTextWithAnsi(line || " ", innerWidth)) {
        lines.push(truncateToWidth(`${this.renderTheme.fg("border", "│")} ${wrapped}`, width));
      }
    }
    lines.push(
      truncateToWidth(
        `${this.renderTheme.fg("border", "└─")} ${this.renderTheme.fg("dim", "Ctrl+O collapse")}`,
        width,
      ),
    );
    return lines;
  }

  private renderToolHeader(header: string, status: SparkNativeToolStatus, icon: string): string {
    const color = toolStatusColor(status);
    return `${this.renderTheme.fg(color, icon)} ${this.renderTheme.fg("tool", header)}`;
  }

  private renderThinkingMessage(message: SparkNativeMessage, width: number): string[] {
    if (!this.controller.viewState.thinkingExpanded) {
      return this.styleRoleLines("thinking", [
        truncateToWidth(nativeTuiStrings.thinkingFolded(Boolean(message.streaming)), width),
      ]);
    }
    const suffix = message.streaming ? " ▋" : "";
    return this.styleRoleLines(
      "thinking",
      this.renderPrefixedBlock(
        nativeTuiStrings.thinkingPrefix,
        `${message.text || " "}${suffix}`,
        width,
      ),
    );
  }

  private renderCustomMessage(message: SparkNativeMessage, width: number): string[] {
    const customType = message.customType ?? "custom";
    const renderer = this.messageRenderers.get(customType);
    if (renderer) {
      const component = renderer(
        this.toCustomMessage(message, customType),
        { expanded: true },
        this.renderTheme,
      );
      if (component) return component.render(width).map((line) => truncateToWidth(line, width));
    }
    return this.styleRoleLines(
      "custom",
      this.renderPrefixedBlock(`custom:${customType}> `, message.text || " ", width),
    );
  }

  private renderMarkdownBlock(body: string, width: number): string[] {
    const markdown = new Markdown(
      body,
      0,
      0,
      createSparkMarkdownTheme(this.theme),
      this.markdownDefaultTextStyle(),
      { preserveOrderedListMarkers: true },
    );
    return markdown.render(
      Math.max(1, width - this.messagePrefix({ role: "assistant", text: "" }).length),
    );
  }

  private markdownDefaultTextStyle(): DefaultTextStyle {
    return { color: (text) => this.renderTheme.fg("assistant", text) };
  }

  private renderToolBody(body: string): string {
    return body
      .split("\n")
      .map((line) => styleSparkDiffLine(this.theme, line))
      .join("\n");
  }

  private separatorLine(width: number): string {
    return this.renderTheme.fg("border", "".padEnd(Math.max(1, width), "─"));
  }

  private styleRoleLines(role: SparkNativeMessageRole, lines: string[]): string[] {
    return lines.map((line) => styleSparkRoleLine(this.theme, role, line));
  }

  private renderPrefixedLines(prefix: string, bodyLines: string[], width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of bodyLines.entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderPrefixedBlock(prefix: string, body: string, width: number): string[] {
    const lines: string[] = [];
    for (const [index, line] of body.split("\n").entries()) {
      const label = index === 0 ? prefix : " ".repeat(prefix.length);
      lines.push(...wrapTextWithAnsi(`${label}${line}`, Math.max(1, width)));
    }
    return lines;
  }

  private renderWidgets(placement: "aboveEditor" | "belowEditor", width: number): string[] {
    return [...this.widgets.values()]
      .filter((widget) => widget.placement === placement)
      .sort((a, b) => a.key.localeCompare(b.key))
      .flatMap((widget) => {
        const lines = widget.component
          ? renderNativeWidgetComponent(widget.component, width)
          : (widget.lines ?? []);
        return lines.map((line) => truncateToWidth(line, width));
      });
  }

  private renderTaskStatus(width: number): string[] {
    const tasks = [...this.hub.tasks.values()]
      .filter((task) => task.status !== "done" && task.status !== "cancelled")
      .sort((left, right) => taskStatusRank(left.status) - taskStatusRank(right.status));
    return tasks.slice(0, MAX_HUB_PANEL_ROWS).map((task, index, visibleTasks) => {
      const marker = index === 0 ? "◆" : index === visibleTasks.length - 1 ? "└─" : "├─";
      const doneTodos = task.todos.filter((todo) => todo.status === "done").length;
      const todos = task.todos.length > 0 ? " · todos " + doneTodos + "/" + task.todos.length : "";
      const owner = task.owner?.trim() ? " · " + task.owner.trim() : "";
      return truncateToWidth(
        this.renderTheme.fg("dim", marker) +
          " " +
          this.renderTheme.fg(taskStatusColor(task.status), taskStatusIcon(task.status)) +
          " " +
          task.ref +
          " [" +
          task.status +
          "] " +
          task.title +
          todos +
          owner,
        width,
      );
    });
  }

  private renderActiveHubPanel(width: number): string[] {
    const activePanel = this.controller.viewState.activeHubPanel;
    if (!activePanel) return [];
    return this.renderHubPanel(activePanel, width).map((line) => truncateToWidth(line, width));
  }

  private renderHubPanel(panel: SparkNativeHubPanel, width?: number): string[] {
    switch (panel) {
      case "overview":
        return this.renderHubOverview();
      case "workflows":
        return this.renderWorkflowHub();
      case "runs":
        return this.renderRunHub();
      case "tasks":
        return this.renderTaskHub(width);
      case "artifacts":
        return this.renderArtifactHub();
      case "reviews":
        return this.renderReviewHub();
      case "graft":
        return this.renderGraftHub();
    }
  }

  private renderHubOverview(): string[] {
    const snapshot = this.hubSnapshot();
    return [
      "◆ Session inspector: overview",
      `├─ Workflow picker/progress: ${snapshot.workflows} option(s), ${snapshot.workflowRuns} workflow run(s)`,
      `├─ Role-run board: ${snapshot.roleRuns} role run(s), ${snapshot.interactions} interaction(s)`,
      `├─ Task/project board: ${snapshot.tasks} tracked task(s)`,
      `├─ Artifacts panel: ${snapshot.artifacts} artifact(s), ${snapshot.evidence} evidence item(s), ${snapshot.reviews} review item(s)`,
      `├─ Graft provenance/patch status: ${snapshot.graftItems} item(s)`,
      "└─ Cross-session Hub: run spark hub in another terminal.",
    ];
  }

  private renderWorkflowHub(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Session inspector: workflows",
      "│  Keys: ↑/↓ or j/k select · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Commands: /workflow runs [runRef] · /workflow inspect <runRef>",
      "│            /workflow pause|resume|stop|restart|save|ack <runRef>",
    ];
    const interactions = [...this.hub.interactions.values()].filter(
      (request) => request.kind === "workflowPicker",
    );
    for (const request of interactions.slice(0, MAX_HUB_PANEL_ROWS)) {
      lines.push(
        `├─ picker ${request.requestId}: ${request.title} (${request.options.length} option(s))`,
      );
    }
    for (const workflow of [...this.hub.workflows.values()].slice(0, MAX_HUB_PANEL_ROWS)) {
      const source = workflow.source === "interaction" ? "picker" : "run";
      lines.push(
        `├─ ${source} ${workflow.selector}: ${workflow.label}${workflow.description ? ` — ${workflow.description}` : ""}`,
      );
    }
    for (const run of this.runsByKind("workflow").slice(0, MAX_HUB_PANEL_ROWS)) {
      const marker = run.id === selected?.id ? "▸" : "├";
      lines.push(
        `${marker}─ workflow run ${run.id} [${workflowRunDisplayStatus(run)}] ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5)
      lines.push("└─ No workflow picker options or workflow runs have been published yet.");
    return lines;
  }

  private renderRunHub(): string[] {
    const selected = this.selectedWorkflowRun();
    const lines = [
      "◆ Session inspector: role/run board",
      "│  Keys: ↑/↓ or j/k select workflow run · Enter/i inspect · p pause · u resume · x stop · r restart · s save · a ack · Esc close",
      selected
        ? `│  Selected: ${selected.id} [${workflowRunDisplayStatus(selected)}]`
        : "│  Selected: none",
      "│  Workflow commands: /workflow runs [runRef] · /workflow inspect <runRef>",
      "│                     /workflow pause|resume|stop|restart|save|ack <runRef>",
    ];
    const runs = [...this.hub.runs.values()].sort(compareRunsForHub);
    for (const run of runs.slice(0, MAX_HUB_PANEL_ROWS)) {
      const progress = run.progress === undefined ? "" : ` ${(run.progress * 100).toFixed(0)}%`;
      const evidence = run.evidenceRefs.length > 0 ? ` evidence=${run.evidenceRefs.length}` : "";
      const marker = run.kind === "workflow" && run.id === selected?.id ? "▸" : "├";
      const status = run.kind === "workflow" ? workflowRunDisplayStatus(run) : run.status;
      lines.push(
        `${marker}─ ${run.kind} ${run.id} [${status}]${progress}${evidence} ${run.title ?? run.summary ?? ""}`.trimEnd(),
      );
      if (run.kind === "workflow" && run.id === selected?.id) {
        for (const hint of workflowRunControlHints(run)) lines.push(`│  ${hint}`);
      }
    }
    if (lines.length === 5) lines.push("└─ No run view-model updates have been published yet.");
    return lines;
  }

  private renderTaskHub(width?: number): string[] {
    const lines = ["◆ Session inspector: task/project board"];
    if (this.hub.sessionTitle) {
      lines.push(...wrapTextWithAnsi(`│  Project: ${this.hub.sessionTitle}`, width ?? 100));
    }
    for (const task of [...this.hub.tasks.values()].slice(0, MAX_HUB_PANEL_ROWS)) {
      const doneTodos = task.todos.filter((todo) => todo.status === "done").length;
      const todoSummary = task.todos.length > 0 ? ` todos=${doneTodos}/${task.todos.length}` : "";
      const artifacts = task.evidenceRefs.length > 0 ? ` evidence=${task.evidenceRefs.length}` : "";
      lines.push(`├─ ${task.ref} [${task.status}]${todoSummary}${artifacts} ${task.title}`);
    }
    if (lines.length === (this.hub.sessionTitle ? 2 : 1))
      lines.push("└─ No task/project view-model updates have been published yet.");
    return lines;
  }

  private renderArtifactHub(): string[] {
    const lines = ["◆ Session inspector: artifacts"];
    const rows = [...this.hub.artifacts.values(), ...this.hub.evidence.values()].slice(
      0,
      MAX_HUB_PANEL_ROWS,
    );
    for (const artifact of rows) {
      const producer = artifact.producer ? ` producer=${artifact.producer}` : "";
      const status = artifact.status ? ` status=${artifact.status}` : "";
      lines.push(
        `├─ ${artifact.ref} [${artifact.kind}/${artifact.format}]${producer}${status} ${artifact.title}`,
      );
      if (artifact.preview) lines.push(`│  ${artifact.preview}`);
    }
    if (lines.length === 1)
      lines.push("└─ No artifact view-model updates have been published yet.");
    return lines;
  }

  private renderReviewHub(): string[] {
    const lines = ["◆ Session inspector: reviewer verdicts"];
    for (const item of this.reviewItems().slice(0, MAX_HUB_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No reviewer verdict artifacts or run metadata have been published yet.");
    return lines;
  }

  private renderGraftHub(): string[] {
    const lines = ["◆ Session inspector: Graft provenance/patch status"];
    for (const item of this.graftItems().slice(0, MAX_HUB_PANEL_ROWS)) {
      lines.push(`├─ ${item}`);
    }
    if (lines.length === 1)
      lines.push("└─ No Graft candidate, patch, or provenance metadata has been published yet.");
    return lines;
  }

  private selectableWorkflowRuns(): SparkRunView[] {
    return this.runsByKind("workflow").sort(compareRunsForHub);
  }

  private selectedWorkflowRun(): SparkRunView | undefined {
    this.ensureWorkflowRunSelection();
    const selectedId = this.hub.selectedWorkflowRunId;
    if (!selectedId) return undefined;
    return this.hub.runs.get(selectedId);
  }

  private ensureWorkflowRunSelection(): void {
    const runs = this.selectableWorkflowRuns();
    if (runs.length === 0) {
      this.hub.selectedWorkflowRunId = undefined;
      return;
    }
    if (
      !this.hub.selectedWorkflowRunId ||
      !runs.some((run) => run.id === this.hub.selectedWorkflowRunId)
    ) {
      this.hub.selectedWorkflowRunId = runs[0]?.id;
    }
  }

  private runsByKind(kind: SparkRunView["kind"]): SparkRunView[] {
    return [...this.hub.runs.values()].filter((run) => run.kind === kind);
  }

  private reviewItems(): string[] {
    const artifactItems = [...this.hub.artifacts.values(), ...this.hub.evidence.values()]
      .filter(isReviewArtifact)
      .map((artifact) => {
        const outcome =
          stringFromRecord(artifact.metadata, "outcome") ?? artifact.status ?? "recorded";
        return `${artifact.ref} [${outcome}] ${artifact.title}`;
      });
    const runItems = [...this.hub.runs.values()]
      .filter((run) =>
        Boolean(
          stringFromRecord(run.metadata, "reviewer") ??
          stringFromRecord(run.metadata, "verdict") ??
          stringFromRecord(run.metadata, "outcome"),
        ),
      )
      .map((run) => {
        const outcome =
          stringFromRecord(run.metadata, "outcome") ??
          stringFromRecord(run.metadata, "verdict") ??
          run.status;
        return `${run.kind}:${run.id} [${outcome}] ${run.title ?? run.summary ?? "review"}`;
      });
    return [...artifactItems, ...runItems];
  }

  private graftItems(): string[] {
    const records: string[] = [];
    for (const artifact of [...this.hub.artifacts.values(), ...this.hub.evidence.values()]) {
      const summary = graftSummaryFromRecord(artifact.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${artifact.title} ${artifact.preview ?? ""}`)
      ) {
        records.push(`${artifact.ref} ${summary ?? artifact.title}`);
      }
    }
    for (const run of this.hub.runs.values()) {
      const summary = graftSummaryFromRecord(run.metadata);
      if (
        summary ||
        /\bgraft\b|candidate:|patch:/iu.test(`${run.title ?? ""} ${run.summary ?? ""}`)
      ) {
        records.push(`${run.kind}:${run.id} ${summary ?? run.title ?? run.summary ?? "graft"}`);
      }
    }
    return records;
  }

  private toCustomMessage(message: SparkNativeMessage, customType: string): SparkHostCustomMessage {
    return {
      customType,
      content: message.text,
      display: message.display,
      details: message.details,
    };
  }

  private statusLine(): string {
    const statusSuffix = this.extensionStatusSuffix();
    const commandSuffix = this.commandAvailabilitySuffix();
    const activeLoops = [...this.hub.loops.values()].filter(
      (loop) => loop.status !== "stopped" && loop.status !== "completed",
    );
    const loopSuffix =
      activeLoops.length === 0 ? "" : ` · loop=${activeLoops.map((loop) => loop.status).join(",")}`;
    const sessionLabel =
      this.hub.sessionTitle?.trim() ||
      this.hub.sessionId?.trim() ||
      this.workspaceSession?.controlPlaneSessionId?.trim() ||
      "local";
    const activeProvider = this.statusContext?.activeProvider?.()?.trim();
    const activeModel = this.statusContext?.activeModel?.()?.trim();
    const modelLabel =
      activeProvider && activeModel ? `${activeProvider}/${activeModel}` : activeModel;
    const thinkingLevel = this.statusContext?.thinkingLevel?.()?.trim();
    const queue = this.session.queueSummary;
    return (
      nativeTuiStrings.statusLine({
        session: sessionLabel,
        ...(modelLabel ? { model: modelLabel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        state: this.sessionStateLabel(),
        ...(queue.total > 0
          ? {
              queue: {
                steer: queue.steer,
                followUp: queue.followUp,
                daemonPending: queue.daemonPending,
              },
            }
          : {}),
      }) +
      loopSuffix +
      commandSuffix +
      statusSuffix
    );
  }

  private footerLine(): string {
    return this.session.isProcessing
      ? `${this.workingSpinner()} Working... • ${nativeTuiStrings.busyFooter(
          this.session.canRestoreQueuedInput,
          this.session.daemonOwnsQueue,
        )}`
      : nativeTuiStrings.footer;
  }

  private runtimeFooterLines(width: number): string[] {
    const cwd = this.hub.cwd ?? this.inputBasePath;
    const home = homedir();
    const compactCwd =
      cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
    const branch = this.hub.gitBranch?.trim();
    const pathLine = branch ? `${compactCwd} (${branch})` : compactCwd;
    const metrics = formatFooterMetrics(
      this.currentFooterMetrics(),
      this.statusContext?.autoCompactionEnabled?.() ?? true,
    );
    const identity = this.runtimeModelIdentity();
    const lines = [truncateToWidth(this.renderTheme.fg("muted", pathLine), width)];
    if (!metrics && !identity.full) return lines;
    const line = this.alignRuntimeFooter(metrics ?? "", identity, width);
    lines.push(truncateToWidth(this.renderTheme.fg("muted", line), width));
    return lines;
  }

  private currentFooterMetrics(): SparkNativeFooterMetrics {
    let metrics = { ...this.sessionFooterMetrics };
    for (const run of this.runFooterMetrics.values()) metrics = addFooterMetrics(metrics, run);
    const contextWindow = this.statusContext?.contextWindow?.() ?? metrics.contextWindow;
    return contextWindow ? { ...metrics, contextWindow } : metrics;
  }

  private runtimeModelIdentity(): { full?: string; compact?: string } {
    let provider = this.statusContext?.activeProvider?.()?.trim() ?? this.hub.model?.providerName;
    let model = this.statusContext?.activeModel?.()?.trim() ?? this.hub.model?.modelId;
    if (!provider && model?.includes("/")) {
      const separator = model.indexOf("/");
      provider = model.slice(0, separator);
      model = model.slice(separator + 1);
    }
    const thinking = this.statusContext?.thinkingLevel?.()?.trim() ?? this.hub.thinkingLevel;
    if (!model) return {};
    const compact = thinking ? `${model} • ${thinking}` : model;
    return { full: provider ? `(${provider}) ${compact}` : compact, compact };
  }

  private alignRuntimeFooter(
    metrics: string,
    identity: { full?: string; compact?: string },
    width: number,
  ): string {
    if (!identity.full) return truncateToWidth(metrics, width);
    let right = identity.full;
    const minimumGap = metrics ? 2 : 0;
    if (visibleWidth(metrics) + minimumGap + visibleWidth(right) > width && identity.compact) {
      right = identity.compact;
    }
    let left = metrics;
    const availableForLeft = Math.max(0, width - visibleWidth(right) - minimumGap);
    if (visibleWidth(left) > availableForLeft) left = truncateToWidth(left, availableForLeft, "…");
    if (!left) return truncateToWidth(right, width, "…");
    const availableForRight = Math.max(0, width - visibleWidth(left) - minimumGap);
    if (visibleWidth(right) > availableForRight) {
      right = truncateToWidth(right, availableForRight, "");
    }
    const padding = " ".repeat(
      Math.max(minimumGap, width - visibleWidth(left) - visibleWidth(right)),
    );
    return `${left}${padding}${right}`;
  }

  private workingSpinner(): string {
    return NATIVE_WORKING_SPINNER_FRAMES[
      this.workingSpinnerFrame % NATIVE_WORKING_SPINNER_FRAMES.length
    ];
  }

  private syncWorkingSpinner(): void {
    if (!this.session.isProcessing) {
      this.stopWorkingSpinner();
      return;
    }
    if (this.workingSpinnerTimer) return;
    this.workingSpinnerTimer = setInterval(() => {
      this.workingSpinnerFrame =
        (this.workingSpinnerFrame + 1) % NATIVE_WORKING_SPINNER_FRAMES.length;
      this.invalidate();
      this.tui.requestRender();
    }, NATIVE_WORKING_SPINNER_INTERVAL_MS);
    this.workingSpinnerTimer.unref?.();
  }

  private stopWorkingSpinner(): void {
    if (this.workingSpinnerTimer) clearInterval(this.workingSpinnerTimer);
    this.workingSpinnerTimer = undefined;
    this.workingSpinnerFrame = 0;
  }

  private sessionStateLabel(): string {
    if (this.session.isProcessing) return "running";
    if (this.session.queuedCount > 0) return "queued";
    switch (this.hub.sessionStatus) {
      case "streaming":
        return "running";
      case "succeeded":
        return "complete";
      case "timed_out":
        return "timed-out";
      default:
        return this.hub.sessionStatus ?? "idle";
    }
  }

  private async runSlashCommand(input: string): Promise<void> {
    const parsed = parseSlashCommand(input);
    if (!parsed) {
      this.session.addSystemMessage(nativeTuiStrings.emptyCommand);
      return;
    }

    // Compatibility aliases must execute their registered handler. Otherwise
    // a same-named local panel or legacy action bar can intercept the command
    // before it reaches the canonical command family.
    if (this.slashCommands[parsed.name]?.metadata?.deprecatedAliasFor) {
      await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
      return;
    }

    const builtIn = this.builtInSlashCommand(parsed.name, parsed.args);
    if (builtIn !== undefined) {
      if (builtIn) this.session.addSystemMessage(builtIn);
      return;
    }

    // `/sessions` is an explicit navigation command, not a palette request.
    // Execute it directly so the host can exit this TUI and reopen the same
    // selector used at startup. `/session` keeps the richer action bar.
    if (parsed.name === "sessions" && !parsed.args.trim()) {
      await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
      return;
    }

    // The canonical bare `/workflow` command owns the native workflow picker.
    // Hub uses the shared semantic action bar, but the TUI must not let
    // that presentation layer intercept its registered picker command.
    if (parsed.name === "workflow" && !parsed.args.trim() && this.slashCommands.workflow) {
      await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
      return;
    }

    const actionBar = sparkSlashActionBarForInput(input);
    if (actionBar) {
      this.openActionBar(actionBar);
      return;
    }

    await this.invokeRegisteredSlashCommand(parsed.name, parsed.args, true);
  }

  private async invokeRegisteredSlashCommand(
    name: string,
    args: string,
    emitResult: boolean,
  ): Promise<void> {
    const command = this.slashCommands[name];
    if (!command) {
      this.session.addSystemMessage(nativeTuiStrings.unknownCommand(name));
      return;
    }

    try {
      const result = await command.handler(args, {
        app: this,
        session: this.session,
        exit: this.onExit,
      });
      if (emitResult && result?.trim()) this.session.addSystemMessage(result.trim());
    } catch (error) {
      this.session.addSystemMessage(
        nativeTuiStrings.commandFailed(
          name,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private builtInSlashCommand(name: string, _args: string): string | undefined | false {
    switch (name) {
      case "help":
        return this.renderCommandHelp(_args);
      case "clear":
        this.session.clearTranscript();
        return false;
      case "reload":
        return "Reload requested. Restart Spark TUI to reload extension state.";
      case "stop": {
        const result = this.session.abort(_args.trim() || "user stop");
        if (result.restoredText) this.setEditorText(result.restoredText);
        if (result.aborted) return false;
        return result.clearedQueued > 0
          ? `Restored ${result.clearedQueued} queued input(s) to the editor.`
          : nativeTuiStrings.noTurnRunning;
      }
      case "retry":
        void this.session.retryLast();
        return false;
      case "inspect":
      case "hub":
        return this.openHubPanelFromArgs(_args);
      case "runs":
      case "run":
        return this.openHubPanel("runs");
      case "tasks":
      case "task":
        return this.openHubPanel("tasks");
      case "artifacts":
      case "artifact":
      case "evidence":
        return this.openHubPanel("artifacts");
      case "reviews":
      case "review":
        return this.openHubPanel("reviews");
      case "graft":
        return this.openHubPanel("graft");
      case "exit":
      case "quit":
        this.onExit();
        return nativeTuiStrings.exiting;
      default:
        return undefined;
    }
  }

  openHubPanelFromArgs(args: string): string | false {
    const requested = args.trim().toLowerCase();
    if (requested === "off" || requested === "close" || requested === "hide") {
      this.controller.dispatch({ type: "hub.close" });
      this.invalidate();
      this.tui.requestRender();
      return nativeTuiStrings.hubPanelClosed;
    }
    if (requested && !isSparkNativeHubPanel(requested)) {
      return `Unknown local session panel '${requested}'. Choose: ${SPARK_HUB_PANELS.join(", ")}, off.`;
    }
    return this.openHubPanel((requested as SparkNativeHubPanel | "") || "overview");
  }

  openHubPanel(panel: SparkNativeHubPanel): string | false {
    this.controller.dispatch({ type: "hub.open", panel });
    if (panel === "runs" || panel === "workflows") this.ensureWorkflowRunSelection();
    this.invalidate();
    this.tui.requestRender();
    return false;
  }

  private renderCommandHelp(args = ""): string {
    const requestedMode = args.trim().toLowerCase();
    const mode =
      requestedMode === "all" ? "all" : requestedMode === "commands" ? "commands" : "quick";
    const allCommands = catalogSparkNativeCommands(
      this.slashCommands,
      nativeKernelSlashCommandEntries(),
      { includeDeprecated: true },
    );
    const visibleCommands =
      mode === "all"
        ? allCommands
        : catalogSparkNativeCommands(this.slashCommands, nativeKernelSlashCommandEntries());
    const groups = SPARK_NATIVE_COMMAND_GROUP_ORDER.map((id) => ({
      id,
      commands: visibleCommands
        .filter((entry) => entry.group === id)
        .map((entry) => ({
          name: entry.name,
          description: entry.description,
          argumentHint: entry.argumentHint,
          source: entry.command?.metadata?.source ?? entry.source,
          canonicalCliTarget: entry.command?.metadata?.canonicalCliTarget,
          deprecatedAliasFor: entry.deprecatedAliasFor,
        })),
    }));
    return nativeTuiStrings.commandHelp({
      mode,
      groups,
      registeredCount: allCommands.filter((entry) => entry.source === "registered").length,
      hiddenAliasCount: allCommands.length - visibleCommands.length,
    });
  }

  private commandAvailabilitySuffix(): string {
    const count = catalogSparkNativeCommands(
      this.slashCommands,
      nativeKernelSlashCommandEntries(),
    ).filter(
      (entry) =>
        entry.source === "registered" &&
        entry.command &&
        !isSparkNativeLocalControlCommand(entry.command),
    ).length;
    if (count === 0) return "";
    return " • " + count.toString() + " registered command" + (count === 1 ? "" : "s");
  }

  private extensionStatusSuffix(): string {
    const statuses = [...this.statuses.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, text]) => text.trim())
      .filter(Boolean);
    return statuses.length > 0 ? " • " + statuses.join(" • ") : "";
  }

  private messagePrefix(message: SparkNativeMessage): string {
    if (message.role === "user") {
      const senderLabel = userSenderLabelFromDetails(message.details);
      return senderLabel ? `> ${senderLabel}: ` : "> ";
    }
    if (message.role === "assistant") return "";
    if (message.role === "custom") return `custom:${message.customType ?? "custom"}> `;
    if (message.role === "tool") return `tool:${message.toolName ?? "tool"}> `;
    if (message.role === "thinking") return "thinking> ";
    return "system> ";
  }
}

function taskStatusRank(status: SparkTaskView["status"]): number {
  switch (status) {
    case "running":
      return 0;
    case "blocked":
      return 1;
    case "ready":
      return 2;
    case "pending":
      return 3;
    case "failed":
      return 4;
    case "done":
      return 5;
    case "cancelled":
      return 6;
  }
}

function taskStatusIcon(status: SparkTaskView["status"]): string {
  switch (status) {
    case "running":
      return "→";
    case "blocked":
      return "⏸";
    case "ready":
      return "◇";
    case "pending":
      return "○";
    case "failed":
      return "✗";
    case "done":
      return "✓";
    case "cancelled":
      return "⊘";
  }
}

function taskStatusColor(status: SparkTaskView["status"]): string {
  switch (status) {
    case "running":
      return "accent";
    case "blocked":
      return "warning";
    case "failed":
      return "error";
    case "done":
      return "success";
    case "ready":
    case "pending":
    case "cancelled":
      return "dim";
  }
}
