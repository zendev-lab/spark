import type { SparkLanguage } from "./index.ts";

export type SparkCliDispatcherTarget =
  | "daemon"
  | "hub"
  | "acp"
  | "mcp"
  | "update"
  | "web"
  | "web-dsh";

export interface SparkCliDispatcherStrings {
  unknownSubcommand: (subcommand: string, originalArgs: readonly string[]) => string;
  dispatchFailure: (targetLabel: string, detail: string) => string;
  signalExit: (targetLabel: string, signal: string) => string;
  helpText: string;
  targetLabel: (target: SparkCliDispatcherTarget) => string;
}

const DISPATCHER: Record<SparkLanguage, SparkCliDispatcherStrings> = {
  en: {
    unknownSubcommand: (subcommand, _originalArgs) =>
      `Unknown spark subcommand: ${subcommand}\nRun "spark --help" for available subcommands. Use "spark web" for the local browser workbench or "spark run <prompt>" for a headless turn.`,
    dispatchFailure: (targetLabel, detail) => `Unable to dispatch to ${targetLabel}: ${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} exited due to signal ${signal}`,
    helpText: `spark - Spark command dispatcher

Usage:
  spark
  spark run [--json] [--wait] [--resume <session>] <prompt>
  spark bg [--session <id>] [--json] <prompt>
  spark paths [--json]
  spark doctor
  spark install --managed [--version <version>] [--prefix <path>]
  spark update status|check|apply|rollback|retry|configure
  spark version [--json]
  spark daemon auth <status|login|logout|import> [args...]
  spark daemon model <list|status|set> [args...]
  spark daemon <command> [args...]
  spark hub [command] [args...]
  spark hub web <start|status|stop|logs> [args...]
  spark acp
  spark mcp
  spark web [--host 127.0.0.1] [--port 4310] [--no-open]
  spark web-dsh [--host 127.0.0.1] [--port 3080]
  spark --help
  spark --version

Dispatches to Spark surfaces:
  spark             print this help
  spark run         foreground headless run via the daemon
  spark bg          submit a background daemon invocation and return its receipt
  spark paths       print public Spark configuration and state paths
  spark doctor      top-level Spark health check via the daemon CLI
  spark update      managed installation, update policy, and rollback owner
  spark daemon      daemon execution plane: auth, model, session, invocation, events, logs, process state
  spark hub         global coordination plane, embedded Web presentation, and lifecycle
  spark acp         ACP NDJSON stdio adapter backed by canonical daemon sessions
  spark mcp         read-only MCP stdio adapter backed by canonical Memory
  spark web         local single-workspace browser workbench bound to loopback and the daemon
  spark web-dsh     optional DeepSeek Harness compatibility workbench

Companion executables:
  spark-daemon    local execution plane
  spark-hub       global control plane and embedded management UI
  spark-acp       ACP NDJSON stdio adapter
  spark-mcp       read-only MCP stdio adapter
  spark-web       local single-workspace browser workbench
  spark-web-dsh   optional DeepSeek Harness compatibility workbench
  spark-update    managed installation and rollback owner

Flags:
  --wait, -w    Wait for invocation to reach terminal status before exiting

Unknown subcommands fail loudly instead of being interpreted as prompts. Use "spark web" for the local browser workbench or "spark run <prompt>" for a headless turn.
`,
    targetLabel: (target) => {
      switch (target) {
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
        case "web-dsh":
          return "Spark DSH web";
        default: {
          const exhaustive: never = target;
          return exhaustive;
        }
      }
    },
  },
  zh: {
    unknownSubcommand: (subcommand, _originalArgs) =>
      `未知 spark 子命令：${subcommand}\n运行 "spark --help" 查看可用子命令。本地浏览器工作台请使用 "spark web"，headless 执行请使用 "spark run <prompt>"。`,
    dispatchFailure: (targetLabel, detail) => `无法分发到 ${targetLabel}：${detail}`,
    signalExit: (targetLabel, signal) => `${targetLabel} 因信号 ${signal} 退出`,
    helpText: `spark - Spark 命令分发器

用法：
  spark
  spark run [--json] [--wait] [--resume <session>] <prompt>
  spark bg [--session <id>] [--json] <prompt>
  spark paths [--json]
  spark doctor
  spark install --managed [--version <version>] [--prefix <path>]
  spark update status|check|apply|rollback|retry|configure
  spark version [--json]
  spark daemon auth <status|login|logout|import> [参数...]
  spark daemon model <list|status|set> [参数...]
  spark daemon <命令> [参数...]
  spark hub [命令] [参数...]
  spark hub web <start|status|stop|logs> [参数...]
  spark acp
  spark mcp
  spark web [--host 127.0.0.1] [--port 4310] [--no-open]
  spark web-dsh [--host 127.0.0.1] [--port 3080]
  spark --help
  spark --version

分发到 Spark 界面：
  spark             打印本帮助
  spark run         通过 daemon 前台 headless 执行
  spark bg          将后台 turn 提交到 Spark daemon 队列
  spark paths       打印公开的 Spark 配置和状态路径
  spark doctor      通过 daemon CLI 执行顶层 Spark 健康检查
  spark update      托管安装、更新策略和回滚状态所有者
  spark daemon      daemon execution plane：auth、model、session、invocation、events、logs、process state
  spark hub         全局协调面、内嵌 Web 展示与生命周期
  spark acp         使用 canonical daemon session 的 ACP NDJSON stdio adapter
  spark mcp         使用 canonical Memory 的只读 MCP stdio adapter
  spark web         本地单 workspace 浏览器工作台：仅绑定回环并直连 daemon
  spark web-dsh     可选的 DeepSeek Harness 兼容工作台

配套可执行程序：
  spark-daemon    本地执行平面
  spark-hub       全局控制平面与内嵌管理 UI
  spark-acp       ACP NDJSON 标准输入输出适配器
  spark-mcp       只读 MCP 标准输入输出适配器
  spark-web       本地单 workspace 浏览器工作台
  spark-web-dsh   可选的 DeepSeek Harness 兼容工作台
  spark-update    托管安装和回滚所有者

Flags：
  --wait, -w    等待调用到达终态后再退出

未知子命令会直接失败，不会被解释成 prompt。本地浏览器工作台请使用 "spark web"，headless 执行请使用 "spark run <prompt>"。
`,
    targetLabel: (target) => {
      switch (target) {
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
        case "web-dsh":
          return "Spark DSH web";
        default: {
          const exhaustive: never = target;
          return exhaustive;
        }
      }
    },
  },
};

export function sparkCliDispatcherStrings(
  language: SparkLanguage = "en",
): SparkCliDispatcherStrings {
  return DISPATCHER[language];
}
