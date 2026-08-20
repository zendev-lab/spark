import type { SparkLanguage } from "./index.ts";

export type SparkCliDispatcherTarget = "tui" | "daemon" | "hub" | "acp" | "mcp" | "update" | "web";

export interface SparkCliDispatcherStrings {
  unknownSubcommand: (subcommand: string, originalArgs: readonly string[]) => string;
  dispatchFailure: (targetLabel: string, detail: string) => string;
  signalExit: (targetLabel: string, signal: string) => string;
  helpText: string;
  targetLabel: (target: SparkCliDispatcherTarget) => string;
  tuiRequiresTty: string;
}

const DISPATCHER: Record<SparkLanguage, SparkCliDispatcherStrings> = {
  en: {
    unknownSubcommand: (subcommand, originalArgs) =>
      `Unknown spark subcommand: ${subcommand}\nRun "spark --help" for available subcommands. Use "spark tui ${originalArgs.join(
        " ",
      )}" to send text to the interactive TUI.`,
    dispatchFailure: (targetLabel, detail) => `Unable to dispatch to ${targetLabel}: ${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} exited due to signal ${signal}`,
    helpText: `spark - Spark command dispatcher

Usage:
  spark
  spark run [--json] [--wait] [--resume <session>] <prompt>
  spark bg [--session <id>] [--json] <prompt>
  spark paths [--json]
  spark doctor
  spark tui [initial message]
  spark install --managed [--version <version>] [--prefix <path>]
  spark daemon auth <status|login|logout|import> [args...]
  spark daemon model <list|status|set> [args...]
  spark daemon <command> [args...]
  spark hub [command] [args...]
  spark acp
  spark mcp
  spark web [--host <host>] [--port <port>] [--trusted-host <authority...>] [args...]
  spark update status|check|apply|rollback|retry|configure
  spark version [--json]
  spark --help
  spark --version

Companion executables:
  spark-tui       local interactive terminal client
  spark-daemon    local execution plane
  spark-hub       global control plane and embedded management UI
  spark-acp       ACP NDJSON stdio adapter
  spark-mcp       read-only MCP stdio adapter
  spark-web       DSH web profile boot
  spark-update    managed installation and rollback owner

The spaced plane forms are dispatcher aliases for the matching spark-* executable.
Unknown subcommands fail loudly instead of being interpreted as prompts.
`,
    tuiRequiresTty:
      'Spark TUI requires an interactive terminal (stdin and stdout must be TTYs). Use "spark run <prompt>", "spark-acp", or "spark-daemon submit ..." for non-interactive/headless use.',
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
    helpText: `spark - Spark 命令分发器

用法：
  spark
  spark run [--json] [--wait] [--resume <session>] <prompt>
  spark bg [--session <id>] [--json] <prompt>
  spark paths [--json]
  spark doctor
  spark tui [初始消息]
  spark install --managed [--version <version>] [--prefix <path>]
  spark daemon auth <status|login|logout|import> [参数...]
  spark daemon model <list|status|set> [参数...]
  spark daemon <命令> [参数...]
  spark hub [命令] [参数...]
  spark acp
  spark mcp
  spark web [--host <host>] [--port <port>] [--trusted-host <authority...>] [参数...]
  spark update status|check|apply|rollback|retry|configure
  spark version [--json]
  spark --help
  spark --version

配套可执行程序：
  spark-tui       本地交互式终端客户端
  spark-daemon    本地执行平面
  spark-hub       全局控制平面和内置管理界面
  spark-acp       ACP NDJSON 标准输入输出适配器
  spark-mcp       只读 MCP 标准输入输出适配器
  spark-web       DSH web profile 启动器
  spark-update    托管安装和回滚所有者

空格形式的 plane 命令仅负责分发到对应的 spark-* 可执行程序。
未知子命令会直接失败，不会被解释成 prompt。
`,
    tuiRequiresTty:
      'Spark TUI 需要交互式终端（stdin 和 stdout 必须是 TTY）。非交互/headless 使用请改用 "spark run <prompt>"、"spark-acp" 或 "spark-daemon submit ..."。',
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

export function sparkCliDispatcherStrings(
  language: SparkLanguage = "en",
): SparkCliDispatcherStrings {
  return DISPATCHER[language];
}
