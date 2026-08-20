import type { SparkLanguage } from "./index.ts";

export {
  sparkCliDispatcherStrings,
  type SparkCliDispatcherStrings,
  type SparkCliDispatcherTarget,
} from "./dispatcher.ts";

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

const DAEMON_HELP_TEXT = `spark daemon - daemon execution plane\n\nUsage:\n  spark daemon [--workspace <name>]\n  spark daemon login --server-url <url> [--no-open]\n  spark daemon auth status [--json]\n  spark daemon auth login [provider]\n  spark daemon auth logout <provider> [--json]\n  spark daemon auth import pi [--overwrite] [--json]\n  spark daemon model list [--all] [--json]\n  spark daemon model status [--session <id>] [--json]\n  spark daemon model set <provider/model> (--session <id>|--default) [--json]\n  spark daemon status [--json]\n  spark daemon start [--no-wait] [--json]\n  spark daemon stop [--yes] [--wait]\n  spark daemon restart [--yes] [--no-wait]\n  spark daemon logs [--follow] [--lines <n>]\n  spark daemon submit --session <id> --prompt <text> [--reset] [--json]\n  spark daemon ask list [--session <id>] [--json]\n  spark daemon ask answer <interaction-request-id> --answers <json> [--session <id>] [--json]\n  spark daemon ask cancel <interaction-request-id> [--session <id>] [--json]\n  spark daemon invocation list [--status <state>] [--session <id>] [--since <iso>] [--limit <n>] [--offset <n>] [--json]\n  spark daemon invocation status <invocation-id> [--json]\n  spark daemon invocation result <invocation-id> [--json]\n  spark daemon invocation stream <invocation-id> [--after <cursor>] [--limit <n>] [--json]\n  spark daemon invocation cancel <invocation-id> [--reason <text>] [--json]\n  spark daemon invocation retry <invocation-id> [--json]\n  spark daemon invocation retention --before <iso> [--limit <n>] [--json]\n  spark daemon session list [--json] [--registry] [--include-archived]\n  spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] [--json]\n  spark daemon session show <session-id> [--json]\n  spark daemon session tree <session-id> [--json]\n  spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> [--name <text>] [--cwd <path>] [--cwd-artifact-ref <artifact:ref>] [--json]\n  spark daemon session bind <session-id> --external-key <key> [--json]\n  spark daemon session unbind <session-id> --external-key <key> [--json]\n  spark daemon session archive <session-id> [--json]\n  spark daemon session export --session <id|path> [--format jsonl|json|text] [--leaf <entry-id|root>] [--json]\n  spark daemon session replay --session <id|path> [--leaf <entry-id|root>] [--json]\n  spark daemon session inbox --session <session-id> [--all] [--json]\n  spark daemon session inbox read <message-id> --session <session-id> [--json]\n  spark daemon session inbox ack <message-id> --session <session-id> [--json]\n  spark daemon channel list --workspace <id> [--json]\n  spark daemon channel status --workspace <id> [--json]\n  spark daemon channel reload --workspace <id> [--json]\n  spark daemon channel notify --workspace <id> [--action test|send] [--json]\n  spark daemon run list [--state <state>] [--limit <n>] [--json]\n  spark daemon run show <run-id> [--json]\n  spark daemon run cancel <run-id> [--json]\n  spark daemon events watch [--limit <n>] [--json]\n  spark daemon workspace register [path] [--name <name>]\n  spark daemon workspace register [path] --token <token|-> [--server-url <url>] [--name <name>]\n  spark daemon workspace ls [--json] [--all] [--full]\n  spark daemon workspace show [name] [--json]\n  spark daemon workspace stop <name> [--yes]\n\nDaemon login grants machine connectivity only; provider credentials live under daemon auth. Hub origin is daemon-owned; workspace announce consumes a fresh one-time workspace token. Spark CLI starts/wakes the Spark daemon and talks over local IPC; SQLite-backed invocations are execution truth. Hub coordination and Web lifecycle commands live under spark hub; the retired spark cockpit namespace is rejected. Session registry and channel listeners are daemon-owned (see .agents/notes/contracts/sessions-and-channels.md).`;

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
      interactive: "Spark local web",
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
      interactive: "Spark local web",
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

export function sparkDaemonCliStrings(language: SparkLanguage = "en"): SparkDaemonCliStrings {
  return DAEMON_STRINGS[language];
}
