---
title: Spark 功能地图
description: 按产品表面、状态所有者和用户意图理解 Spark 全部能力，而不是背 slash 命令。
---

按「想完成什么」来分组，比按 slash 命令数量更容易理解 Spark。命令和 agent
工具只是能力内部的控制入口，不是产品功能分类。

## 0. 产品表面与分发

| 使用入口 | 用途 | 状态所有者 |
| --- | --- | --- |
| `spark` CLI | 安装、分发、脚本、诊断和打开其他表面 | 只负责分发 |
| TUI | 描述工作、引导单个会话、查看本地投影 | 终端展示 |
| Daemon | 前端断开后仍保持会话和任务运行 | 执行真相 |
| Hub | 在浏览器监督工作空间和对话 | Web 展示与协调 |
| ACP | 把兼容编辑器接入 daemon 会话 | 只负责适配 |
| Updater | 安装、升级、回滚和报告构建版本 | 已安装版本 |

完整安装用的 meta package 是 `@zendev-lab/spark`：它锁定各包版本，但不包含
dispatcher 实现。`@zendev-lab/spark-cli` 拥有真实的 `spark` 命令；Daemon、
TUI 与 Hub 也可作为独立 app package 安装。其他源码 workspace 仍是私有实现
边界，不是受支持的产品。详情见
[界面与所有权](/zh/concepts/surfaces/)和 [CLI 参考](/zh/reference/cli/)。

贡献者只需按家族理解源码拓扑：

| 源码家族 | 职责 |
| --- | --- |
| `apps/spark-cli`、`spark-tui`、`spark-daemon`、`apps/spark-hub` | 可执行分发器与交互/运行时 host |
| `packages/spark-extension`、`spark-daemon-client` | 产品组合根与共享 daemon client 边界 |
| 能力与运行时 `packages/spark-*` | 文件、Web、任务、产物、记忆、工作流、模式、Role、Session 等可复用行为 |
| `spark-protocol`、`spark-core`、`spark-runtime`、`spark-system`、`spark-tui-adapter` | 跨表面契约与低依赖基础层 |
| `packages/spark-hub-*` | Hub 私有数据库、协调与本地化实现 |

贡献者可查看 `docs/specs/package-architecture.md` 的依赖规则，以及
`architecture/packages.json` 的完整 owner/stability 清单。普通用户不必记住各个
workspace package。

## 1. 核心运行时：一个 daemon

Daemon 拥有持久会话、排队和运行中的工作、事件流、恢复、workspace 绑定、
channel listener 与自主续跑。前台运行、后台提交、TUI prompt 和 Hub Web
消息最终都进入同一个执行所有者。

用 `spark doctor` 和 `spark daemon status --json` 检查健康状态；前台、后台、
attach、resume 和取消操作见[运行与会话](/zh/guides/runs-and-sessions/)。

## 2. 交互式设计：Hub Web 与 TUI

- [TUI](/zh/guides/tui/) 适合本地快速对话、Plan/Implement、引导当前运行、
  选择模型和查看当前会话。
- [Hub Web](/zh/guides/hub/) 适合工作空间概览、对话、收件箱、产品产物、
  资源和跨 daemon 监督。
- 已经知道具体操作并需要脚本结果时，使用 CLI。

TUI 的 `/inspect` 只查看当前会话；`spark hub` 打开 Hub Web 管理界面。

## 3. 基础 agent 工具

Spark 提供文件、搜索、shell/script、任务、产物、询问、记忆与上下文、模型、
角色、会话、workflow 和持久驱动工具。用户通常只需描述目标；agent 会选择工具，
并在策略要求时请求确认。

参见 [Agent 工具激活与权限模型](/zh/reference/tools/)。

## 4. 任务与自主推进

普通项目工作遵循：

```text
Project → Task plan → claim 或 assign → Run → Artifact → Review
```

`/plan` 创建可验证工作，但不实施；`/execute` 持续处理 ready task，直到完成、
阻塞、验证失败或需要决策。Goal、Loop、Repro 和 Workflow 为需要持续或重复的
工作提供 daemon 所有的续跑能力。`/automate` 只是这些已有模式的选择器。

先读[规划并实现一个修改](/zh/guides/plan-and-execute/)，需要长期工作时再读
[长期自动推进](/zh/guides/automation/)。

## 5. 渠道与多会话协作

Spark 区分可复用 Role、持久 Session、只读 Side Thread 和消息平台 Channel。
飞书、如流（Infoflow）和 QQ Bot 对话会绑定到 daemon session，不会产生第二个
执行所有者。Session 可以发送 request 或 notification，并通过 Inbox 接收完成摘要。

详情见[协作与渠道](/zh/guides/collaboration/)和
[Side Threads](/zh/guides/side-threads/)。

## 6. 模型、上下文、扩展与运维

- Provider、模型选择和推理强度属于共享运行时控制。
- Memory、受限 context provider、产品 Artifact 和内部 Evidence 以不同可见性保存结果。
- Saved workflow 扩展可重复流程；Fusion 和 Graft 需要显式启用。
- 托管更新、备份、访问 key、workspace 注册、诊断和恢复支持更复杂的运行场景。

修改运行时存储前先看[配置与路径](/zh/reference/configuration-and-paths/)；
界面与 daemon 状态不一致时看[故障排查](/zh/troubleshooting/)。
