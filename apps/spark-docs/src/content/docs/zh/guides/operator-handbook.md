---
title: 运维与完整使用手册
description: 端到端运行 Spark、连接 Cockpit、创建会话、检查 invocation，并按所有权安全恢复。
---

这份手册给出本地 Spark 的最短完整路径，也规定了出问题时应先做哪些只读检查。

## 先分清状态由谁拥有

- **daemon** 拥有执行、会话、invocation、工作区绑定和恢复状态。
- **TUI** 是交互式终端宿主；它展示 daemon 状态，并把用户意图提交给 daemon。
- **Cockpit** 是浏览器协调与投影界面，不能根据浏览器计时器或 transcript 文本推断执行状态。
- 产品 Artifact 只有 Issue、PR 和 Preview；内部验证 Evidence 使用独立命名空间，不是产品 Artifact。

多个界面的状态不一致时，先检查 daemon。

## 1. 固定安装版本和状态根

每次排查先运行只读命令：

```bash
spark version --json
spark paths --json
spark doctor
```

`spark paths --json` 是有效路径的事实来源。不要用复制状态或凭证到另一个根目录的方式修复问题。

需要隔离体验时，在启动任何 Spark 进程前指定一个绝对路径：

```bash
export SPARK_HOME=/absolute/path/to/isolated-spark-home
spark paths --json
```

这次体验里的全部命令（包括 daemon 和 Cockpit）都必须使用同一个 `SPARK_HOME`。

## 2. 配置可认证的模型

打开 TUI：

```bash
spark
```

运行 `/login` 配置 provider，再用 `/model` 选择可用模型。API Key 只应输入 Spark
提供的 secret prompt，不能写进仓库、命令历史或 Cockpit 注册命令。

没有已认证模型时，Cockpit 会禁用会话提交。JSON CLI 提交会返回可处理的错误：

```json
{
  "action": "error",
  "error": {
    "code": "cli_error",
    "message": "Configure a provider before selecting this model."
  }
}
```

配置 provider 后，只重试原提交一次。

## 3. 分别启动 daemon 和 Cockpit

启动并检查执行平面：

```bash
spark daemon start --json
spark daemon status --json
```

后台启动本地 Cockpit：

```bash
HOST=127.0.0.1 \
PORT=5174 \
SPARK_COCKPIT_PUBLIC_URL=http://127.0.0.1:5174 \
spark cockpit web start --json

spark cockpit web status --json
```

浏览器必须打开完全相同的 public URL，scheme、hostname 和 port 都要一致。例如，配置期间不要在
`localhost` 和 `127.0.0.1` 之间切换。

需要前台生产宿主时使用 `spark cockpit`。daemon 和 Cockpit 是两个独立进程，排查时也必须分开检查。

## 4. 创建并注册第一个工作区

1. 在 Cockpit 打开 `/workspaces/new`。
2. 选择 Fresh Profile，或 Git 托管的 Workspace Profile。
3. 输入 Cockpit 工作区名称、URL slug 和可选描述。
4. 生成一次性注册命令。
5. `cd` 到这个工作区应拥有的本地目录。
6. 原样运行生成的命令一次。
7. 等待已连接目录出现，然后进入工作区。

生成命令的形式如下：

```bash
spark daemon workspace register . \
  --server-url http://127.0.0.1:5174 \
  --token <one-time-workspace-token> \
  --name <workspace-name>
```

Token 只显示一次，只授权一个目录。它不是 provider 凭证，也不是可复用的 daemon login。

检查 daemon 拥有的绑定：

```bash
spark daemon workspace ls --json
```

注册过程中，daemon 可以先用本地目录 basename 作为占位身份。完成设置后，Cockpit
拥有用户配置的工作区名称和 URL slug；daemon 继续拥有规范本地路径和 binding display name。

## 5. 创建、检查并附着会话

从 `spark daemon workspace ls --json` 读取 server workspace ID，然后创建托管会话：

```bash
spark daemon session create \
  --workspace <server-workspace-id> \
  --role operator \
  --json

spark daemon session list --registry --json
spark daemon session show <session-id> --json
```

对托管会话，`role` 是稳定的职责身份，也会用作兼容 title。请在同一个规范工作区目录中附着：

```bash
spark tui --session-id <session-id>
```

Cockpit 的 Conversations 会列出同一个 daemon 会话；打开第二个前端不会创建第二个 executor。

## 6. 提交并观察持久执行

向已知会话提交：

```bash
spark daemon submit \
  --session <session-id> \
  --prompt "Inspect the repository and report the validation command." \
  --json
```

使用返回的 invocation ID 检查执行：

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after 0 --limit 500 --json
spark daemon invocation result <invocation-id> --json
```

只取消明确的 invocation：

```bash
spark daemon invocation cancel <invocation-id> \
  --reason "No longer needed" \
  --json
```

日常入口：

```bash
spark run --json "Return one foreground result."
spark bg --json "Queue durable background work."
spark bg --session <session-id> "Continue the existing work."
```

不要因为浏览器看起来空闲就重复提交。先检查 invocation；无法确认 mutation 或外部投递结果时，应
fail closed，不能自动 replay。

## 7. 体验产品工作流

在 TUI 中使用：

```text
/plan <goal>
/implement [focus]
/inspect
/goal start <objective>
/repro start <objective>
/workflow list
/help commands
```

这些界面应协同工作：

- **Conversations** 与 TUI 展示 daemon 拥有的会话和 turn。
- **Inbox** 展示内联问题与审批；Ask 不应变成全局 modal。
- **Artifacts** 只包含 Issue、PR 和 Preview。
- **Resources** 包含工作区仓库、文档、URL、文件、工具和 secret reference。
- Goal、Repro、Workflow 与后台 driver 保持不同语义；不能合并 scheduled、running、
  retry-waiting、dormant、blocked 和 stopped 状态。

继续阅读 [TUI](/zh/guides/tui/)、[运行与会话](/zh/guides/runs-and-sessions/)、
[Cockpit](/zh/guides/cockpit/) 和 [长期工作](/zh/guides/automation/)。

## 8. 远程访问

所有非 loopback Cockpit 都应使用 HTTPS 或加密私有链路。

机器连通性和浏览器访问权限互相独立：

```bash
spark daemon login --server-url https://cockpit.example
spark cockpit access create
spark cockpit workspace access create --workspace <cockpit-workspace-id>
```

- Cockpit Key 在 `/login` 兑换。
- Workspace Key 在 `/{slug}/login` 兑换。
- 每增加一个本地目录，都要生成新的 Workspace Registration Token。

所有一次性 Key 都应视为 secret，不能复制进日志或 PR。

## 9. 按所有权顺序排障

### Help 意外执行了命令

所有嵌套界面的 Help 都必须只读：

```bash
spark doctor --help
spark cockpit web start --help
spark daemon session create --help
```

如果已发布安装的行为不同，先对比 `spark version --json` 与预期源码或包版本。

### Cockpit 能打开，但设置或提交不继续

检查 canonical origin 和两个进程：

```bash
spark cockpit web status --json
spark daemon status --json
spark daemon workspace ls --json
spark daemon logs --lines 200
```

整个设置流程只使用一个 hostname。Token 一旦被消费，应重新签发，不能尝试恢复或 replay。

### Cockpit 报 binding 已属于另一个工作区

不要删除任一数据库。检查 `spark daemon workspace ls --json` 和 Cockpit Workspace
Settings。一个 binding 只能拥有一条 active Cockpit lease；要迁移时，先从当前 Cockpit
工作区显式 unbind，再注册到目标工作区。

### 没有已认证模型

回到 TUI，先运行 `/login`，再运行 `/model`。只有 daemon 报告可用的已认证模型后，
Cockpit 才应允许提交。

### Run 看起来卡住

```bash
spark daemon invocation list --session <session-id> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after 0 --limit 500 --json
```

先检查再重试；前端经过时间不是执行事实。

### Spark 读取了意外状态

```bash
spark paths --json
```

确认 terminal、daemon 和 Cockpit 使用同一个预期根。不要重启另一个 service manager
或另一个测试根拥有的进程。

## 10. 停止隔离体验

只停止选定状态根拥有的服务：

```bash
spark cockpit web stop --json
spark daemon stop --yes
```

最终验收命令：

```bash
spark doctor
spark daemon status --json
spark cockpit web status --json
spark daemon workspace ls --json
spark daemon session list --registry --json
spark daemon invocation list --json
```

报告问题时记录精确版本、`SPARK_HOME` 或 XDG roots、失败命令、退出码以及
invocation/session ID。绝不能包含 provider 凭证、一次性注册 Token 或浏览器 Key。
