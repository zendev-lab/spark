import type { SparkLanguage } from "./index.ts";

export interface SparkCliDispatcherStrings {
  unknownSubcommand: (subcommand: string, originalArgs: readonly string[]) => string;
  dispatchFailure: (targetLabel: string, detail: string) => string;
  signalExit: (targetLabel: string, signal: string) => string;
  helpText: string;
  targetLabel: (target: "tui" | "daemon" | "hub" | "acp" | "mcp" | "update" | "web") => string;
  tuiRequiresTty: string;
}

export interface SparkTuiCliStrings {
  helpText: string;
  printRequiresPrompt: string;
  tuiRequiresTty: string;
  headlessDisplayName: string;
  interactiveDisplayName: string;
  modelCommandDescription: string;
  modelCommandArgumentHint: string;
  noActiveModel: string;
  activeModelSuffix: string;
  noModelsRegistered: string;
  noModelsMatching: (query: string) => string;
  headlessAccepted: string;
  rpcRequiresMessage: (command: string) => string;
  unsupportedRpcCommand: (command: string) => string;
}

const DISPATCHER: Record<SparkLanguage, SparkCliDispatcherStrings> = {
  en: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `Unknown spark subcommand: ${subcommand}\nRun "spark --help" for available subcommands. Use "spark tui ${originalArgs.join(
        " ",
      )}" to send text to the interactive TUI.`,
    dispatchFailure: (targetLabel, detail) => `Unable to dispatch to ${targetLabel}: ${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} exited due to signal ${signal}`,
    helpText:
      'spark - Spark command dispatcher\n\nUsage:\n  spark\n  spark run [--json] [--wait] [--resume <session>] <prompt>\n  spark bg [--session <id>] [--json] <prompt>\n  spark paths [--json]\n  spark doctor\n  spark tui [initial message]\n  spark install --managed [--version <version>] [--prefix <path>]\n  spark update status|check|apply|rollback|retry|configure\n  spark version [--json]\n  spark daemon auth <status|login|logout|import> [args...]\n  spark daemon model <list|status|set> [args...]\n  spark daemon <command> [args...]\n  spark hub [command] [args...]\n  spark hub web <start|status|stop|logs> [args...]\n  spark acp\n  spark mcp\n  spark web [--host 127.0.0.1] [--port 4310] [--no-open]\n  spark --help\n  spark --version\n\nDispatches to Spark surfaces:\n  spark run       foreground headless run\n  spark bg        submit a background daemon invocation and return its receipt\n  spark paths     print public Spark configuration and state paths\n  spark doctor    top-level Spark health check via the daemon CLI\n  spark tui       tui local control plane: interactive terminal UI, attach/resume, local UI settings\n  spark update    managed installation, update policy, and rollback owner\n  spark daemon    daemon execution plane: auth, model, session, invocation, events, logs, process state\n  spark hub       global coordination plane, embedded Web presentation, and lifecycle\n  spark acp       ACP NDJSON stdio adapter backed by canonical daemon sessions\n  spark mcp       read-only MCP stdio adapter backed by canonical Memory\n  spark web       local single-workspace browser workbench bound to loopback and the daemon\n\nFlags:\n  --wait, -w    Wait for invocation to reach terminal status before exiting\n\nUnknown subcommands fail loudly instead of being interpreted as prompts. Use "spark tui ..." for interactive TUI input.\n',
    tuiRequiresTty:
      'Spark TUI requires an interactive terminal (stdin and stdout must be TTYs). Use "spark run <prompt>", "spark acp", or "spark daemon submit ..." for non-interactive/headless use.',
    targetLabel: (target) => {
      switch (target) {
        case "tui":
          return "Spark TUI";
        case "daemon":
          return "Spark daemon";
        case "hub":
          return "Spark Hub";
        case "acp":
          return "Spark ACP adapter";
        case "mcp":
          return "Spark MCP adapter";
        case "update":
          return "Spark updater";
        case "web":
          return "Spark web";
      }
    },
  },
  zh: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `未知 spark 子命令：${subcommand}\n运行 "spark --help" 查看可用子命令。使用 "spark tui ${originalArgs.join(
        " ",
      )}" 将文本发送到交互式 TUI。`,
    dispatchFailure: (targetLabel, detail) => `无法分发到 ${targetLabel}：${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} 因信号 ${signal} 退出`,
    helpText:
      'spark - Spark 命令分发器\n\n用法：\n  spark\n  spark run [--json] [--wait] [--resume <session>] <prompt>\n  spark bg [--session <id>] [--json] <prompt>\n  spark paths [--json]\n  spark doctor\n  spark tui [初始消息]\n  spark install --managed [--version <version>] [--prefix <path>]\n  spark update status|check|apply|rollback|retry|configure\n  spark version [--json]\n  spark daemon auth <status|login|logout|import> [参数...]\n  spark daemon model <list|status|set> [参数...]\n  spark daemon <命令> [参数...]\n  spark hub [命令] [参数...]\n  spark hub web <start|status|stop|logs> [参数...]\n  spark acp\n  spark mcp\n  spark web [--host 127.0.0.1] [--port 4310] [--no-open]\n  spark --help\n  spark --version\n\n分发到 Spark 界面：\n  spark run       前台 headless 执行\n  spark bg        将后台 turn 提交到 Spark daemon 队列\n  spark paths     打印公开的 Spark 配置和状态路径\n  spark doctor    通过 daemon CLI 执行顶层 Spark 健康检查\n  spark tui       tui local control plane：interactive terminal UI、attach/resume、local UI settings\n  spark update    托管安装、更新策略和回滚状态所有者\n  spark daemon    daemon execution plane：auth、model、session、invocation、events、logs、process state\n  spark hub       全局协调面、内嵌 Web 展示与生命周期\n  spark acp       使用 canonical daemon session 的 ACP NDJSON stdio adapter\n  spark mcp       使用 canonical Memory 的只读 MCP stdio adapter\n  spark web       本地单 workspace 浏览器工作台：仅绑定回环并直连 daemon\n\nFlags：\n  --wait, -w    等待调用到达终态后再退出\n\n未知子命令会直接失败，不会被解释成 prompt。交互式 TUI 输入请使用 "spark tui ..."。\n',
    tuiRequiresTty:
      'Spark TUI 需要交互式终端（stdin 和 stdout 必须是 TTY）。非交互/headless 使用请改用 "spark run <prompt>"、"spark acp" 或 "spark daemon submit ..."。',
    targetLabel: (target) => {
      switch (target) {
        case "tui":
          return "Spark TUI";
        case "daemon":
          return "Spark daemon";
        case "hub":
          return "Spark Hub";
        case "acp":
          return "Spark ACP adapter";
        case "mcp":
          return "Spark MCP adapter";
        case "update":
          return "Spark 更新器";
        case "web":
          return "Spark web";
      }
    },
  },
};

const TUI_CLI: Record<SparkLanguage, SparkTuiCliStrings> = {
  en: {
    helpText:
      "spark-tui - Spark terminal UI host\n\nUse the public Spark command surface:\n  spark\n  spark tui [initial message]\n  spark run [--json] <prompt>\n  spark acp\n  spark daemon session list --json\n  spark tui --session-id <session-id>\n\nSpark session selection is workspace-bound; attach a session from the same canonical cwd/workspace hash. Prompts are submitted to the Spark daemon over local IPC.",
    printRequiresPrompt: "spark --print requires a prompt",
    tuiRequiresTty:
      'spark-tui requires an interactive terminal (stdin and stdout must be TTYs). Use "spark run <prompt>", "spark acp", or "spark daemon submit ..." for non-interactive/headless use.',
    headlessDisplayName: "Spark headless submit",
    interactiveDisplayName: "Spark TUI",
    modelCommandDescription: "Switch or inspect the active Spark model",
    modelCommandArgumentHint: "[model-id]",
    noActiveModel: "No Spark model is registered yet.",
    activeModelSuffix: " (active)",
    noModelsRegistered: "No Spark models registered",
    noModelsMatching: (query) => `No Spark models matching ${query}`,
    headlessAccepted: "Spark daemon accepted the headless prompt.",
    rpcRequiresMessage: (command) => `${command} requires message`,
    unsupportedRpcCommand: (command) => `unsupported rpc command: ${command}`,
  },
  zh: {
    helpText:
      "spark-tui - Spark 终端 UI host\n\n请使用公开 Spark 命令面：\n  spark\n  spark tui [初始消息]\n  spark run [--json] <prompt>\n  spark acp\n  spark daemon session list --json\n  spark tui --session-id <session-id>\n\nSpark session 选择受 workspace 约束；请从相同 canonical cwd/workspace hash attach。Prompt 通过本地 IPC 提交给 Spark daemon。",
    printRequiresPrompt: "spark --print 需要 prompt",
    tuiRequiresTty:
      'spark-tui 需要交互式终端（stdin 和 stdout 必须是 TTY）。非交互/headless 使用请改用 "spark run <prompt>"、"spark acp" 或 "spark daemon submit ..."。',
    headlessDisplayName: "Spark headless submit",
    interactiveDisplayName: "Spark TUI",
    modelCommandDescription: "切换或查看当前 Spark 模型",
    modelCommandArgumentHint: "[model-id]",
    noActiveModel: "尚未注册 Spark 模型。",
    activeModelSuffix: "（当前）",
    noModelsRegistered: "尚未注册 Spark 模型",
    noModelsMatching: (query) => `没有匹配 ${query} 的 Spark 模型`,
    headlessAccepted: "Spark daemon 已接受 headless prompt。",
    rpcRequiresMessage: (command) => `${command} 需要 message`,
    unsupportedRpcCommand: (command) => `不支持的 rpc 命令：${command}`,
  },
};

export function sparkCliDispatcherStrings(
  language: SparkLanguage = "en",
): SparkCliDispatcherStrings {
  return DISPATCHER[language];
}

export type SparkNativeCommandHelpMode = "quick" | "commands" | "all";

export type SparkNativeCommandHelpGroup =
  | "common"
  | "automation"
  | "workflow"
  | "session"
  | "advanced";

export interface SparkNativeCommandHelpEntry {
  name: string;
  description: string;
  argumentHint?: string;
  source?: string;
  canonicalCliTarget?: string;
  deprecatedAliasFor?: string;
}

export interface SparkNativeCommandHelpInput {
  mode: SparkNativeCommandHelpMode;
  groups: Array<{
    id: SparkNativeCommandHelpGroup;
    commands: SparkNativeCommandHelpEntry[];
  }>;
  registeredCount: number;
  hiddenAliasCount: number;
}

export interface SparkNativeTuiStrings {
  welcome: string;
  stoppedTurn: (reason: string, clearedQueued: number) => string;
  admissionRejected: (error: string) => string;
  admissionUnconfirmed: (submissionId: string, error: string) => string;
  cancellationRequested: (invocationId?: string) => string;
  cancellationAlreadyTerminal: (invocationId: string, status: string) => string;
  cancellationUnconfirmed: (invocationId: string, error: string) => string;
  observationInterrupted: (invocationId: string, error: string) => string;
  turnFailed: (error: string) => string;
  steeringUpdate: (body: string) => string;
  defaultHelp: string;
  capturedCommand: (input: string) => string;
  capturedIntent: (input: string) => string;
  widgetRenderFailed: (error: string) => string;
  inputPreparationFailed: (error: string) => string;
  keybindingFailed: (error: string) => string;
  noQueuedInputToRestore: string;
  noWorkflowRunSelected: string;
  selectedWorkflowNotLive: (id: string) => string;
  hostCommandNotRegistered: (name: string) => string;
  noInteractionHandler: string;
  builtinCommands: Array<{ name: string; description: string; argumentHint?: string }>;
  keybindings: {
    toggleTools: string;
    toggleThinking: string;
    toggleHub: string;
    cycleHubPanel: string;
  };
  appTitle: string;
  footer: string;
  busyFooter: (hasQueuedInput: boolean, daemonOwnsQueue?: boolean) => string;
  statusLine: (input: {
    session: string;
    model?: string;
    thinkingLevel?: string;
    state: string;
    queue?: { steer: number; followUp: number; daemonPending?: number };
  }) => string;
  queuedInput: (mode: "steer" | "followUp", position: number) => string;
  queuedUserPrefix: (mode: "steer" | "followUp") => string;
  thinkingFolded: (streaming: boolean) => string;
  thinkingPrefix: string;
  toolFolded: (header: string) => string;
  emptyCommand: string;
  unknownCommand: (name: string) => string;
  commandFailed: (name: string, error: string) => string;
  noTurnRunning: string;
  reloadBlocked: string;
  noRetryableFailure: string;
  exiting: string;
  hubPanelClosed: string;
  hubPanelOpen: (panel: string, countsLine: string) => string;
  commandHelp: (input: SparkNativeCommandHelpInput) => string;
}

function zhNativeSessionState(state: string): string {
  const labels: Record<string, string> = {
    idle: "空闲",
    running: "运行中",
    queued: "已排队",
    waiting: "等待中",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消",
    "timed-out": "已超时",
    unknown: "未知",
  };
  return labels[state] ?? state;
}

const COMMAND_HELP_GROUP_LABELS: Record<
  SparkLanguage,
  Record<SparkNativeCommandHelpGroup, string>
> = {
  en: {
    common: "Common",
    automation: "Automation",
    workflow: "Workflows",
    session: "Sessions & context",
    advanced: "Advanced",
  },
  zh: {
    common: "常用",
    automation: "自动推进",
    workflow: "工作流",
    session: "会话与上下文",
    advanced: "高级",
  },
};

function renderNativeCommandHelp(
  language: SparkLanguage,
  input: SparkNativeCommandHelpInput,
): string {
  const labels = COMMAND_HELP_GROUP_LABELS[language];
  const diagnostic = input.mode === "all";
  const renderCommand = (command: SparkNativeCommandHelpEntry): string => {
    const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
    const source = diagnostic && command.source ? ` [${command.source}]` : "";
    const target =
      diagnostic && command.canonicalCliTarget ? ` → ${command.canonicalCliTarget}` : "";
    const alias =
      diagnostic && command.deprecatedAliasFor
        ? language === "zh"
          ? `（兼容别名，改用 ${command.deprecatedAliasFor}）`
          : ` (compatibility alias for ${command.deprecatedAliasFor})`
        : "";
    return `- /${command.name}${hint} — ${command.description}${source}${target}${alias}`;
  };
  const renderGroups = (groups: SparkNativeCommandHelpInput["groups"]): string[] =>
    groups.flatMap((group) =>
      group.commands.length > 0 ? [labels[group.id], ...group.commands.map(renderCommand)] : [],
    );

  if (input.mode === "quick") {
    const common = input.groups.find((group) => group.id === "common")?.commands ?? [];
    return [
      language === "zh" ? "Spark — 从这里开始" : "Spark — start here",
      language === "zh"
        ? "- 普通输入 — 直接描述目标；Spark 忙碌时会安全排队"
        : "- ordinary input — describe your goal; Spark queues it safely while busy",
      ...common.map(renderCommand),
      language === "zh"
        ? "使用 /help commands 查看分组命令；使用 /help all 查看兼容别名和诊断信息。"
        : "Use /help commands for grouped commands; use /help all for aliases and diagnostics.",
    ].join("\n");
  }

  const footer =
    input.mode === "all"
      ? language === "zh"
        ? `已注册 ${input.registeredCount} 个命令；包含兼容别名和诊断目标。`
        : `${input.registeredCount} commands registered; compatibility aliases and diagnostic targets included.`
      : input.hiddenAliasCount > 0
        ? language === "zh"
          ? `已隐藏 ${input.hiddenAliasCount} 个兼容别名；使用 /help all 查看。`
          : `${input.hiddenAliasCount} compatibility alias${input.hiddenAliasCount === 1 ? "" : "es"} hidden; use /help all to inspect them.`
        : language === "zh"
          ? "当前没有隐藏的兼容别名。"
          : "No compatibility aliases are hidden.";
  return [
    input.mode === "all"
      ? language === "zh"
        ? "Spark 命令注册表（诊断）"
        : "Spark command registry (diagnostic)"
      : language === "zh"
        ? "Spark 命令"
        : "Spark commands",
    ...renderGroups(input.groups),
    footer,
  ].join("\n");
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[.!?。！？]+$/u, "");
}

const NATIVE_TUI: Record<SparkLanguage, SparkNativeTuiStrings> = {
  en: {
    welcome: ["Type a task, /plan for durable work, or /model to switch models."].join("\n"),
    stoppedTurn: (reason, clearedQueued) =>
      `Stopped current Spark turn (${reason}).${
        clearedQueued > 0 ? ` Restored ${clearedQueued} queued input(s) to the editor.` : ""
      }`,
    admissionRejected: (error) =>
      `Spark daemon rejected the turn: ${withoutTerminalPunctuation(error)}. The input can be restored with Alt+Up or resubmitted with /retry.`,
    admissionUnconfirmed: (submissionId, error) =>
      `Daemon admission ${submissionId} has an unknown outcome: ${error}. Spark will retry the same request identity; do not resubmit it as a new turn.`,
    cancellationRequested: (invocationId) =>
      invocationId
        ? `Cancellation requested for daemon invocation ${invocationId}; the daemon remains the source of truth until it reaches a terminal state.`
        : "Cancellation will be requested as soon as daemon admission is acknowledged.",
    cancellationAlreadyTerminal: (invocationId, status) =>
      `Daemon invocation ${invocationId} was already ${status}; no new cancellation was recorded.`,
    cancellationUnconfirmed: (invocationId, error) =>
      `Cancellation for daemon invocation ${invocationId} could not be confirmed: ${error}. Do not assume it stopped; inspect /status or /queue.`,
    observationInterrupted: (invocationId, error) =>
      `Live observation of daemon invocation ${invocationId} was interrupted: ${error}. Daemon ownership is retained; inspect /status or reconnect for the latest projection.`,
    turnFailed: (error) =>
      `Spark turn failed: ${withoutTerminalPunctuation(error)}. If the daemon marks it retryable, use /retry to create a linked attempt; use /status to inspect the daemon.`,
    steeringUpdate: (body) =>
      `Steering update for the previous Spark turn. Use this to adjust or correct the in-progress response before continuing.\n\n${body}`,
    defaultHelp: [
      "Spark native TUI commands:",
      "- /help: show this help",
      "- /clear: restart the visible transcript by reopening the TUI",
      "- ordinary input is accepted as Spark intent and queued safely while busy",
    ].join("\n"),
    capturedCommand: (input) =>
      `Command '${input}' was captured by the Spark native TUI. Command dispatch will be wired to Spark-owned runtime services here, without the Pi agent SDK runtime.`,
    capturedIntent: (input) =>
      `Captured Spark intent: ${input}\n\nNative Spark agent/runtime wiring will live here on top of pi-tui and Spark packages, not Pi's SDK TUI wrapper.`,
    widgetRenderFailed: (error) => `widget render failed: ${error}`,
    inputPreparationFailed: (error) => `Input preparation failed: ${error}`,
    keybindingFailed: (error) => `Shortcut action failed: ${error}`,
    noQueuedInputToRestore: "No queued input to restore.",
    noWorkflowRunSelected: "No workflow run is selected in the local session inspector.",
    selectedWorkflowNotLive: (id) =>
      `Selected workflow ${id} is not a live dynamic workflow runRef. Use /workflow runs to list dynamic runs.`,
    hostCommandNotRegistered: (name) => `/${name} is not registered in this Spark host.`,
    noInteractionHandler:
      "Spark native TUI received an interaction request but no handler is installed.",
    builtinCommands: [
      { name: "help", description: "show native TUI commands" },
      { name: "clear", description: "clear the visible transcript" },
      {
        name: "stop",
        description: "request cancellation of the current Spark invocation",
        argumentHint: "[reason]",
      },
      { name: "retry", description: "retry the latest failed daemon invocation" },
      {
        name: "inspect",
        description: "show the local session inspector",
        argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      },
      { name: "workflows", description: "open workflows in the local session inspector" },
      { name: "runs", description: "open runs in the local session inspector" },
      { name: "tasks", description: "open tasks in the local session inspector" },
      {
        name: "artifacts",
        description: "open local artifacts (issue/git_change/document)",
      },
      {
        name: "evidence",
        description:
          "deprecated alias; opens Artifacts (issue/git_change/document), not the internal evidence ledger",
      },
      { name: "reviews", description: "open reviewer verdicts in the local session inspector" },
      { name: "graft", description: "open Graft provenance in the local session inspector" },
      { name: "exit", description: "exit the native TUI" },
      { name: "quit", description: "exit the native TUI" },
    ],
    keybindings: {
      toggleTools: "Toggle tool output expansion",
      toggleThinking: "Toggle thinking block expansion",
      toggleHub: "Toggle the local session inspector",
      cycleHubPanel: "Cycle local workflow/run/task/artifact panels",
    },
    appTitle: "Spark",
    footer: "Enter submit • /help commands • Ctrl+C/Ctrl+D exit",
    busyFooter: (hasQueuedInput, daemonOwnsQueue) =>
      daemonOwnsQueue
        ? "Enter queue next • Esc cancel active"
        : `Enter steer • Alt+Enter follow-up • Esc cancel active${hasQueuedInput ? " • Alt+Up restore queue" : ""}`,
    statusLine: ({ session, model, thinkingLevel, state, queue }) =>
      [
        `session ${session}`,
        ...(model ? [`model ${model}`] : []),
        ...(thinkingLevel ? [`thinking ${thinkingLevel}`] : []),
        `state ${state}`,
        ...(queue
          ? [
              `queue steer=${queue.steer} follow-up=${queue.followUp}${
                queue.daemonPending ? ` daemon=${queue.daemonPending}` : ""
              }`,
            ]
          : []),
      ].join(" • "),
    queuedInput: (mode, position) =>
      `Queued ${mode === "followUp" ? "follow-up" : "steering message"} #${position}. Use /stop to cancel the active turn; Alt+Up restores local queued input.`,
    queuedUserPrefix: (mode) =>
      mode === "followUp" ? "you follow-up queued> " : "you steer queued> ",
    thinkingFolded: (streaming) =>
      `thinking${streaming ? " [streaming]" : ""} • hidden (Ctrl+T to show)`,
    thinkingPrefix: "thinking> ",
    toolFolded: (header) => `${header} • folded (Ctrl+O to expand)`,
    emptyCommand: "Empty command. Type /help for available commands.",
    unknownCommand: (name) => `Unknown command: /${name}. Type /help for available commands.`,
    commandFailed: (name, error) => `Command /${name} failed: ${error}`,
    noTurnRunning: "No Spark turn is currently running.",
    reloadBlocked:
      "Reload was not started because a command, submission, or retry is still settling. Wait for it to finish or receive a durable daemon identity, or restore and resubmit rejected input first.",
    noRetryableFailure: "No retryable failed TUI invocation is available.",
    exiting: "Exiting Spark native TUI.",
    hubPanelClosed: "Local session inspector closed.",
    hubPanelOpen: (panel, countsLine) =>
      `Local session inspector ${panel} panel open.\n${countsLine}`,
    commandHelp: (input) => renderNativeCommandHelp("en", input),
  },
  zh: {
    welcome: ["直接输入任务，或用 /plan 规划、/model 切换模型。"].join("\n"),
    stoppedTurn: (reason, clearedQueued) =>
      `已停止当前 Spark turn（${reason}）。${
        clearedQueued > 0 ? `已将 ${clearedQueued} 条 queued input 恢复到编辑器。` : ""
      }`,
    admissionRejected: (error) =>
      `Spark daemon 拒绝了该 turn：${withoutTerminalPunctuation(error)}。可用 Alt+Up 恢复输入，或用 /retry 重新提交。`,
    admissionUnconfirmed: (submissionId, error) =>
      `daemon admission ${submissionId} 的结果未知：${error}。Spark 将使用同一请求身份重试；不要把它作为新 turn 再次提交。`,
    cancellationRequested: (invocationId) =>
      invocationId
        ? `已请求取消 daemon invocation ${invocationId}；在进入终态前仍以 daemon 状态为准。`
        : "daemon 接纳完成后将立即请求取消。",
    cancellationAlreadyTerminal: (invocationId, status) =>
      `daemon invocation ${invocationId} 已处于 ${status} 终态；没有记录新的取消请求。`,
    cancellationUnconfirmed: (invocationId, error) =>
      `无法确认 daemon invocation ${invocationId} 的取消结果：${error}。不要假定它已停止；请用 /status 或 /queue 检查。`,
    observationInterrupted: (invocationId, error) =>
      `daemon invocation ${invocationId} 的实时观察已中断：${error}。执行所有权仍在 daemon；请用 /status 检查或重新连接以获取最新投影。`,
    turnFailed: (error) =>
      `Spark turn 失败：${withoutTerminalPunctuation(error)}。若 daemon 将其标记为可重试，可用 /retry 创建关联 attempt；用 /status 检查 daemon。`,
    steeringUpdate: (body) =>
      `上一轮 Spark turn 的 steering update。用于在继续前调整或纠正进行中的回复。\n\n${body}`,
    defaultHelp: [
      "Spark native TUI 命令：",
      "- /help：显示此帮助",
      "- /clear：通过重新打开 TUI 重置可见 transcript",
      "- 普通输入会作为 Spark intent 接收；忙碌时会安全排队",
    ].join("\n"),
    capturedCommand: (input) => `命令 '${input}' 已被 Spark native TUI 捕获。`,
    capturedIntent: (input) => `已捕获 Spark intent：${input}`,
    widgetRenderFailed: (error) => `widget 渲染失败：${error}`,
    inputPreparationFailed: (error) => `输入准备失败：${error}`,
    keybindingFailed: (error) => `快捷键操作失败：${error}`,
    noQueuedInputToRestore: "没有可恢复的 queued input。",
    noWorkflowRunSelected: "本地会话检查器中尚未选择 workflow run。",
    selectedWorkflowNotLive: (id) => `选中的 workflow ${id} 不是 live dynamic workflow runRef。`,
    hostCommandNotRegistered: (name) => `/${name} 没有在此 Spark host 中注册。`,
    noInteractionHandler: "Spark native TUI 收到 interaction request，但未安装 handler。",
    builtinCommands: [
      { name: "help", description: "显示 native TUI 命令" },
      { name: "clear", description: "清空可见 transcript" },
      {
        name: "stop",
        description: "请求取消当前 Spark invocation",
        argumentHint: "[reason]",
      },
      { name: "retry", description: "重试最近失败的 daemon invocation" },
      {
        name: "inspect",
        description: "显示本地会话检查器",
        argumentHint: "[overview|workflows|runs|tasks|artifacts|reviews|graft|off]",
      },
      { name: "workflows", description: "在本地会话检查器中打开 workflow" },
      { name: "runs", description: "在本地会话检查器中打开 run" },
      { name: "tasks", description: "在本地会话检查器中打开 task" },
      {
        name: "artifacts",
        description: "打开本地产物（issue/git_change/document）",
      },
      {
        name: "evidence",
        description:
          "已弃用别名；打开产品 Artifacts（issue/git_change/document），不是内部 evidence 账本",
      },
      { name: "reviews", description: "在本地会话检查器中打开 reviewer verdict" },
      { name: "graft", description: "在本地会话检查器中打开 Graft provenance" },
      { name: "exit", description: "退出 native TUI" },
      { name: "quit", description: "退出 native TUI" },
    ],
    keybindings: {
      toggleTools: "切换 tool output 展开状态",
      toggleThinking: "切换 thinking block 展开状态",
      toggleHub: "切换本地会话检查器",
      cycleHubPanel: "循环切换本地 workflow/run/task/artifact 面板",
    },
    appTitle: "Spark",
    footer: "Enter 提交 • /help 命令 • Ctrl+C/Ctrl+D 退出",
    busyFooter: (hasQueuedInput, daemonOwnsQueue) =>
      daemonOwnsQueue
        ? "Enter 排队下一轮 • Esc 取消当前 invocation"
        : `Enter 引导当前运行 • Alt+Enter 排队下一轮 • Esc 取消当前 invocation${hasQueuedInput ? " • Alt+Up 恢复本地队列" : ""}`,
    statusLine: ({ session, model, thinkingLevel, state, queue }) =>
      [
        `会话 ${session}`,
        ...(model ? [`模型 ${model}`] : []),
        ...(thinkingLevel ? [`思考级别 ${thinkingLevel}`] : []),
        `状态 ${zhNativeSessionState(state)}`,
        ...(queue
          ? [
              `队列 引导=${queue.steer} 下一轮=${queue.followUp}${
                queue.daemonPending ? ` daemon=${queue.daemonPending}` : ""
              }`,
            ]
          : []),
      ].join(" • "),
    queuedInput: (mode, position) =>
      `已排队第 ${position} 条${mode === "followUp" ? "下一轮消息" : "引导消息"}。使用 /stop 取消当前运行；Alt+Up 可恢复本地队列输入。`,
    queuedUserPrefix: (mode) =>
      mode === "followUp" ? "你（下一轮已排队）> " : "你（引导已排队）> ",
    thinkingFolded: (streaming) =>
      `思考${streaming ? " [流式生成中]" : ""} • 已隐藏（Ctrl+T 显示）`,
    thinkingPrefix: "思考> ",
    toolFolded: (header) => `${header} • 已折叠（Ctrl+O 展开）`,
    emptyCommand: "空命令。输入 /help 查看可用命令。",
    unknownCommand: (name) => `未知命令：/${name}。输入 /help 查看可用命令。`,
    commandFailed: (name, error) => `命令 /${name} 失败：${error}`,
    noTurnRunning: "当前没有运行中的 Spark turn。",
    reloadBlocked:
      "尚未开始 reload：有 command、submission 或 retry 仍在处理中。请等待其完成或获得持久 daemon 身份，或先恢复并重新提交被拒绝的输入。",
    noRetryableFailure: "当前没有可重试的失败 TUI invocation。",
    exiting: "正在退出 Spark native TUI。",
    hubPanelClosed: "本地会话检查器已关闭。",
    hubPanelOpen: (panel, countsLine) => `本地会话检查器 ${panel} 面板已打开。\n${countsLine}`,
    commandHelp: (input) => renderNativeCommandHelp("zh", input),
  },
};

export interface SparkTuiResourceStrings {
  installRequiresSource: string;
  removeRequiresSource: string;
  installedPackage: (kind: string, source: string) => string;
  packageAlreadyInstalled: (kind: string, source: string) => string;
  removedResource: (kind: string, source: string) => string;
  resourceWasNotInstalled: (kind: string, source: string) => string;
  packageNotInstalled: (source: string) => string;
  noPackagesInstalled: (packageRoot: string) => string;
  updatedPackage: (source: string) => string;
  updatedPackages: (count: number) => string;
  configMessage: (configPath: string, packageRoot: string) => string;
  configuredAndInstalled: string;
  noResourcesConfigured: string;
}

export interface SparkTuiPiParityStrings {
  descriptions: Record<string, string>;
  noAssistantMessage: string;
  changelog: string;
  trust: (cwd: string) => string;
  newTranscript: string;
  reload: string;
  settingsUsageThinking: (levels: readonly string[]) => string;
  thinkingLevelSet: (level: string) => string;
  settingsUsageTheme: (themes: readonly string[]) => string;
  themeSet: (themeId: string) => string;
  settingsHeader: string;
  noModelsRegistered: string;
  enabledModelsMutationUsage: string;
  enabledModelsSaved: string;
  enabledModelsSavedEmpty: string;
  noExternalUpload: string;
  importUsage: string;
  sessionNameUnset: string;
  nativeSessionHeader: string;
  authStoreUnavailable: string;
  logoutUsageStored: (providers: readonly string[]) => string;
  logoutUsageEmpty: string;
  removedCredential: (provider: string) => string;
  noCredential: (provider: string) => string;
  providerAuthHeader: string;
  storedCredentials: (providers: readonly string[]) => string;
  noStoredCredentials: string;
  noProvidersRegistered: string;
}

export interface SparkDaemonCliStrings {
  submitRequiresSession: string;
  submitRequiresPrompt: string;
  unknownCommand: (command: string) => string;
  unknownSessionsCommand: (command: string) => string;
  sessionsExportRequiresSession: string;
  sessionsReplayRequiresSession: string;
  serviceCommandMustUseServiceRunner: string;
  helpText: string;
  ignoredEmptyPrompt: string;
  queuedSession: (sessionId: string, invocationId: string) => string;
  completedSession: (sessionId: string, invocationId: string) => string;
  nativeCommandDescriptions: {
    ask: string;
    status: string;
    start: string;
  };
  displayName: Record<"interactive" | "headless" | "executor", string>;
  buildServiceFailed: string;
  notReachable: (message: string) => string;
  localRpcFailed: string;
  invalidStreamResponse: string;
  deviceAuthorizationVerification: (verificationUri: string, userCode: string) => string;
  deviceAuthorizationOpenFailed: (verificationUriComplete: string) => string;
  deviceAuthorizationWaiting: string;
  deviceAuthorizationSucceeded: (runtimeId: string, serverUrl: string) => string;
  workspaceTokenRequired: (serverUrl: string) => string;
}

const RESOURCE_STRINGS: Record<SparkLanguage, SparkTuiResourceStrings> = {
  en: {
    installRequiresSource: "spark install requires a resource source",
    removeRequiresSource: "spark remove requires a resource source",
    installedPackage: (kind, source) => `Installed Spark ${kind} package: ${source}`,
    packageAlreadyInstalled: (kind, source) => `Spark ${kind} package already installed: ${source}`,
    removedResource: (kind, source) => `Removed Spark ${kind} resource: ${source}`,
    resourceWasNotInstalled: (kind, source) =>
      `Spark ${kind} resource was not installed: ${source}`,
    packageNotInstalled: (source) => `Spark package not installed: ${source}`,
    noPackagesInstalled: (packageRoot) => `No Spark packages installed in ${packageRoot}.`,
    updatedPackage: (source) => `Updated Spark package: ${source}`,
    updatedPackages: (count) => `Updated ${count} Spark package${count === 1 ? "" : "s"}.`,
    configMessage: (configPath, packageRoot) =>
      `Spark resource config: ${configPath}\nSpark package root: ${packageRoot}`,
    configuredAndInstalled: "Spark configured and installed resources",
    noResourcesConfigured: "No Spark resources configured or installed.",
  },
  zh: {
    installRequiresSource: "spark install 需要 resource source",
    removeRequiresSource: "spark remove 需要 resource source",
    installedPackage: (kind, source) => `已安装 Spark ${kind} package：${source}`,
    packageAlreadyInstalled: (kind, source) => `Spark ${kind} package 已安装：${source}`,
    removedResource: (kind, source) => `已移除 Spark ${kind} resource：${source}`,
    resourceWasNotInstalled: (kind, source) => `Spark ${kind} resource 未安装：${source}`,
    packageNotInstalled: (source) => `Spark package 未安装：${source}`,
    noPackagesInstalled: (packageRoot) => `${packageRoot} 中没有已安装的 Spark package。`,
    updatedPackage: (source) => `已更新 Spark package：${source}`,
    updatedPackages: (count) => `已更新 ${count} 个 Spark package。`,
    configMessage: (configPath, packageRoot) =>
      `Spark resource config：${configPath}\nSpark package root：${packageRoot}`,
    configuredAndInstalled: "Spark 已配置和已安装 resource",
    noResourcesConfigured: "没有配置或安装 Spark resource。",
  },
};

const PI_PARITY_DESCRIPTIONS = {
  settings: "show Spark settings and provider/session configuration",
  enabledModels: "edit models enabled for Spark model selection/cycling",
  export: "export visible Spark transcript or a persisted session",
  import: "import a Spark/Pi JSONL session and show resume guidance",
  share: "write a share-safe local HTML transcript export (no secret upload)",
  copy: "copy/show the last Spark assistant message",
  name: "set or show the current Spark session display name",
  session: "show Spark native session info and transcript stats",
  changelog: "show Spark native TUI capability highlights",
  hotkeys: "show all Spark keyboard shortcuts",
  tree: "show persisted session tree or append a branch summary",
  trust: "show Spark project trust status and safe next steps",
  login: "store a Spark API key, log in to OAuth, or show auth status",
  logout: "remove a stored Spark OAuth/API credential",
  new: "start a new visible Spark transcript",
  compact: "summarize visible Spark transcript and clear older context",
  resume: "list or preview a persisted Spark session for resume",
  reload: "restart the TUI process and keep the current session",
} as const;

const PI_PARITY_STRINGS: Record<SparkLanguage, SparkTuiPiParityStrings> = {
  en: {
    descriptions: PI_PARITY_DESCRIPTIONS,
    noAssistantMessage: "No assistant message to copy yet.",
    changelog: [
      "Spark native TUI capabilities:",
      "- daemon-first native pi-tui host",
      "- slash autocomplete and /model selection",
      "- native widget factory rendering",
      "- local session inspector for workflows, runs, tasks, artifacts, reviews, and Graft",
    ].join("\n"),
    trust: (cwd) =>
      `Spark trusts this workspace only through explicit config and tool-approval flows. cwd=${cwd}`,
    newTranscript: "Started a new Spark native transcript.",
    reload:
      "Use /reload to replace the native Spark TUI process, reattach the current daemon session, and reload extensions, providers, skills, prompts, themes, and keybindings from disk.",
    settingsUsageThinking: (levels) => `Usage: /settings set thinking <${levels.join("|")}>`,
    thinkingLevelSet: (level) => `Spark thinking level set for this session: ${level}.`,
    settingsUsageTheme: (themes) =>
      `Usage: /settings set theme <${themes.join("|") || "dark|light"}>`,
    themeSet: (themeId) =>
      `Spark theme set: ${themeId}. Restart or /reload to apply it to the active TUI.`,
    settingsHeader: "Spark settings",
    noModelsRegistered: "No Spark models registered.",
    enabledModelsMutationUsage:
      "Usage: /enabled-models [inspect|add <provider/model>|remove <provider/model>|set <provider/model>...]",
    enabledModelsSaved: "Updated Spark enabledModels:",
    enabledModelsSavedEmpty: "Updated Spark enabledModels: (none)",
    noExternalUpload:
      "No external upload was performed. Review the file before sharing it outside this machine.",
    importUsage: "Usage: /import <spark-jsonl-session-path>",
    sessionNameUnset: "(unset)",
    nativeSessionHeader: "Spark native session",
    authStoreUnavailable: "Spark auth store is not available in this host.",
    logoutUsageStored: (providers) => `Usage: /logout <provider>. Stored: ${providers.join(", ")}`,
    logoutUsageEmpty: "Usage: /logout <provider>",
    removedCredential: (provider) => `Removed stored Spark credential for ${provider}.`,
    noCredential: (provider) => `No stored Spark credential for ${provider}.`,
    providerAuthHeader: "Spark provider auth",
    storedCredentials: (providers) => `Stored credentials: ${providers.join(", ")}`,
    noStoredCredentials: "Stored credentials: none",
    noProvidersRegistered: "No OAuth-capable Spark providers registered.",
  },
  zh: {
    descriptions: PI_PARITY_DESCRIPTIONS,
    noAssistantMessage: "还没有可复制的 assistant 消息。",
    changelog: [
      "Spark native TUI capabilities:",
      "- daemon-first native pi-tui host",
      "- slash autocomplete and /model selection",
      "- native widget factory rendering",
      "- 用本地会话检查器查看 workflow、run、task、artifact、review 和 Graft",
    ].join("\n"),
    trust: (cwd) => `Spark 只通过显式 config 和 tool approval 信任此 workspace。cwd=${cwd}`,
    newTranscript: "已开始新的 Spark native transcript。",
    reload:
      "使用 /reload 替换 native Spark TUI 进程、重新 attach 当前 daemon session，并从磁盘重新加载 extensions/providers/skills/prompts/themes/keybindings。",
    settingsUsageThinking: (levels) => `用法：/settings set thinking <${levels.join("|")}>`,
    thinkingLevelSet: (level) => `Thinking level 已设为 ${level}。`,
    settingsUsageTheme: (themes) =>
      `用法：/settings set theme <${themes.join("|") || "dark|light"}>`,
    themeSet: (themeId) => `Theme 已设为 ${themeId}。重启 TUI 以重新加载样式。`,
    settingsHeader: "Spark settings",
    noModelsRegistered: "尚未注册 Spark 模型。",
    enabledModelsMutationUsage:
      "用法：/enabled-models [inspect|add <provider/model>|remove <provider/model>|set <provider/model>...]",
    enabledModelsSaved: "已更新 Spark enabledModels：",
    enabledModelsSavedEmpty: "已更新 Spark enabledModels：（空）",
    noExternalUpload: "未执行外部上传。",
    importUsage: "用法：/import <spark-jsonl-session-path>",
    sessionNameUnset: "（未设置）",
    nativeSessionHeader: "Spark native session",
    authStoreUnavailable: "此 host 中 Spark auth store 不可用。",
    logoutUsageStored: (providers) => `用法：/logout <provider>。已存储：${providers.join(", ")}`,
    logoutUsageEmpty: "用法：/logout <provider>",
    removedCredential: (provider) => `已移除 ${provider} 的存储凭据。`,
    noCredential: (provider) => `未找到 ${provider} 的存储凭据。`,
    providerAuthHeader: "Spark provider auth",
    storedCredentials: (providers) => `已存储凭据：${providers.join(", ")}`,
    noStoredCredentials: "已存储凭据：无",
    noProvidersRegistered: "尚未注册支持 OAuth 的 Spark provider。",
  },
};

const DAEMON_HELP_TEXT = `spark daemon - daemon execution plane\n\nUsage:\n  spark daemon [--workspace <name>]\n  spark daemon login --server-url <url> [--no-open]\n  spark daemon auth status [--json]\n  spark daemon auth login [provider]\n  spark daemon auth logout <provider> [--json]\n  spark daemon auth import pi [--overwrite] [--json]\n  spark daemon model list [--all] [--json]\n  spark daemon model status [--session <id>] [--json]\n  spark daemon model set <provider/model> (--session <id>|--default) [--json]\n  spark daemon status [--json]\n  spark daemon start [--no-wait] [--json]\n  spark daemon stop [--yes] [--wait]\n  spark daemon restart [--yes] [--no-wait]\n  spark daemon logs [--follow] [--lines <n>]\n  spark daemon submit --session <id> --prompt <text> [--reset] [--json]\n  spark daemon ask list [--session <id>] [--json]\n  spark daemon ask answer <interaction-request-id> --answers <json> [--session <id>] [--json]\n  spark daemon ask cancel <interaction-request-id> [--session <id>] [--json]\n  spark daemon invocation list [--status <state>] [--session <id>] [--since <iso>] [--limit <n>] [--offset <n>] [--json]\n  spark daemon invocation status <invocation-id> [--json]\n  spark daemon invocation result <invocation-id> [--json]\n  spark daemon invocation stream <invocation-id> [--after <cursor>] [--limit <n>] [--json]\n  spark daemon invocation cancel <invocation-id> [--reason <text>] [--json]\n  spark daemon invocation retry <invocation-id> [--json]\n  spark daemon invocation retention --before <iso> [--limit <n>] [--json]\n  spark daemon session list [--json] [--registry] [--include-archived]\n  spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] [--json]\n  spark daemon session show <session-id> [--json]\n  spark daemon session tree <session-id> [--json]\n  spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] [--json]\n  spark daemon session bind <session-id> --external-key <key> [--json]\n  spark daemon session unbind <session-id> --external-key <key> [--json]\n  spark daemon session archive <session-id> [--json]\n  spark daemon session export --session <id|path> [--format jsonl|json|text] [--leaf <entry-id|root>] [--json]\n  spark daemon session replay --session <id|path> [--leaf <entry-id|root>] [--json]\n  spark daemon session inbox --session <session-id> [--all] [--json]\n  spark daemon session inbox read <message-id> --session <session-id> [--json]\n  spark daemon session inbox ack <message-id> --session <session-id> [--json]\n  spark daemon channel list --workspace <id> [--json]\n  spark daemon channel status --workspace <id> [--json]\n  spark daemon channel reload --workspace <id> [--json]\n  spark daemon channel notify --workspace <id> [--action test|send] [--json]\n  spark daemon run list [--state <state>] [--limit <n>] [--json]\n  spark daemon run show <run-id> [--json]\n  spark daemon run cancel <run-id> [--json]\n  spark daemon events watch [--limit <n>] [--json]\n  spark daemon workspace register [path] --server-url <url> --token <token|-> --name <name>\n  spark daemon workspace ls [--json] [--all] [--full]\n  spark daemon workspace show [name] [--json]\n  spark daemon workspace stop <name> [--yes]\n\nDaemon login grants machine connectivity only; provider credentials live under daemon auth. Every workspace registration consumes a fresh one-time workspace token. Spark CLI starts/wakes the Spark daemon and talks over local IPC; SQLite-backed invocations are execution truth. Hub coordination and Web lifecycle commands live under spark hub; the retired spark cockpit namespace is rejected. Session registry and channel listeners are daemon-owned (see .agents/notes/contracts/sessions-and-channels.md).`;

const DAEMON_STRINGS: Record<SparkLanguage, SparkDaemonCliStrings> = {
  en: {
    submitRequiresSession: "spark daemon submit requires --session <id>",
    submitRequiresPrompt: "spark daemon submit requires --prompt <text> or trailing text",
    unknownCommand: (command) => `unknown spark daemon command: ${command}`,
    unknownSessionsCommand: (command) => `unknown spark daemon session command: ${command}`,
    sessionsExportRequiresSession: "spark daemon session export requires --session <id|path>",
    sessionsReplayRequiresSession: "spark daemon session replay requires --session <id|path>",
    serviceCommandMustUseServiceRunner:
      "spark daemon service commands must be run through runSparkDaemonCliCommand",
    helpText: DAEMON_HELP_TEXT,
    ignoredEmptyPrompt: "ignored empty prompt",
    queuedSession: (sessionId, invocationId) =>
      `queued for Spark daemon session ${sessionId}: ${invocationId}`,
    completedSession: (sessionId, invocationId) =>
      `Spark daemon completed session ${sessionId}: ${invocationId}`,
    nativeCommandDescriptions: {
      ask: "open a pending Ask overlay for this session or workspace",
      status: "show Spark daemon status",
      start: "start or wake the Spark daemon, then show status",
    },
    displayName: {
      interactive: "Spark interactive TUI",
      headless: "Spark headless CLI",
      executor: "Spark executor",
    },
    buildServiceFailed: "Spark daemon CLI service build failed before launch.",
    notReachable: (message) => `Spark daemon is not reachable: ${message}`,
    localRpcFailed: "Spark daemon local RPC request failed",
    invalidStreamResponse: "Spark daemon stream response was not readable.",
    deviceAuthorizationVerification: (verificationUri, userCode) =>
      `Authorize this daemon at ${verificationUri}\nCode: ${userCode}`,
    deviceAuthorizationOpenFailed: (verificationUriComplete) =>
      `Could not open a browser. Open ${verificationUriComplete}`,
    deviceAuthorizationWaiting: "Waiting for daemon authorization...",
    deviceAuthorizationSucceeded: (runtimeId, serverUrl) =>
      `✓ daemon ${runtimeId} authorized for ${serverUrl}`,
    workspaceTokenRequired: (serverUrl) =>
      `Workspace registration for ${serverUrl} requires a new one-time workspace token. Pass --token <token>.`,
  },
  zh: {
    submitRequiresSession: "spark daemon submit 需要 --session <id>",
    submitRequiresPrompt: "spark daemon submit 需要 --prompt <text> 或 trailing text",
    unknownCommand: (command) => `未知 spark daemon 命令：${command}`,
    unknownSessionsCommand: (command) => `未知 spark daemon session 命令：${command}`,
    sessionsExportRequiresSession: "spark daemon session export 需要 --session <id|path>",
    sessionsReplayRequiresSession: "spark daemon session replay 需要 --session <id|path>",
    serviceCommandMustUseServiceRunner:
      "spark daemon service 命令必须通过 runSparkDaemonCliCommand 运行",
    helpText: DAEMON_HELP_TEXT,
    ignoredEmptyPrompt: "已忽略空 prompt",
    queuedSession: (sessionId, invocationId) =>
      `已排队到 Spark daemon session ${sessionId}：${invocationId}`,
    completedSession: (sessionId, invocationId) =>
      `Spark daemon 已完成 session ${sessionId}：${invocationId}`,
    nativeCommandDescriptions: {
      ask: "打开当前 session 或同 workspace 的 pending Ask overlay",
      status: "显示 Spark daemon 状态",
      start: "启动或唤醒 Spark daemon，然后显示状态",
    },
    displayName: {
      interactive: "Spark interactive TUI",
      headless: "Spark headless CLI",
      executor: "Spark executor",
    },
    buildServiceFailed: "Spark daemon CLI service build failed before launch.",
    notReachable: (message) => `Spark daemon 不可达：${message}`,
    localRpcFailed: "Spark daemon local RPC request failed",
    invalidStreamResponse: "Spark daemon stream response was not readable.",
    deviceAuthorizationVerification: (verificationUri, userCode) =>
      `请在 ${verificationUri} 授权此 daemon\n验证码：${userCode}`,
    deviceAuthorizationOpenFailed: (verificationUriComplete) =>
      `无法打开浏览器，请手动打开 ${verificationUriComplete}`,
    deviceAuthorizationWaiting: "正在等待 daemon 授权……",
    deviceAuthorizationSucceeded: (runtimeId, serverUrl) =>
      `✓ daemon ${runtimeId} 已授权连接 ${serverUrl}`,
    workspaceTokenRequired: (serverUrl) =>
      `在 ${serverUrl} 注册 workspace 需要新的 workspace 一次性 token。请传入 --token <token>。`,
  },
};

export function sparkTuiCliStrings(language: SparkLanguage = "en"): SparkTuiCliStrings {
  return TUI_CLI[language];
}

export function sparkNativeTuiStrings(language: SparkLanguage = "en"): SparkNativeTuiStrings {
  return NATIVE_TUI[language];
}

export function sparkTuiResourceStrings(language: SparkLanguage = "en"): SparkTuiResourceStrings {
  return RESOURCE_STRINGS[language];
}

export function sparkTuiPiParityStrings(language: SparkLanguage = "en"): SparkTuiPiParityStrings {
  return PI_PARITY_STRINGS[language];
}

export function sparkDaemonCliStrings(language: SparkLanguage = "en"): SparkDaemonCliStrings {
  return DAEMON_STRINGS[language];
}
