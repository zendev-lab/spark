---
title: 协作与渠道
description: 在协调工作前，先区分 Role 定义、Session lineage 与消息平台路由。
---

## 三种协作概念

| 对象 | 用途 | 生命周期与权限 |
| --- | --- | --- |
| Role | 单一可复用职责、权限叠加与可选预载 Skill | 每次 Invocation 冻结定义与精确 Skill 组合 |
| Session | 执行上下文、历史、队列和 mailbox | 由 Owner 派生 persistent、scoped 或 ephemeral 生命周期 |
| Channel | 飞书（Feishu）、如流（Infoflow）或 QQ Bot 对话 | 绑定 daemon root Session 的全局 ingress |

行为和能力策略需要复用时选择 Role。Role Session 直接遵循其声明的预载 Skill；
`skill_agent` 只用于没有预定义 Role 的临时、自包含能力。Session 默认使用 `none`，不增加 Role prompt；
每个 Workspace 有一个受保护的 persistent Administrator，其他持续对话是 scoped
Session，Role call 使用仅一次 Invocation 的 ephemeral Session。
受限的只读旁支问题使用 [Side Thread](/zh/guides/side-threads/)；它是 origin 为
`side_thread` 的子 Session，不是另一种运行时实体。所有 child origin 都作为
subsession 显示在同一棵递归本地 Web / Hub Session tree 中。Daemon Channel
Session 是顶层 root，与该 Workspace tree 分开展示。

## Session request 与 notification

Session 可以向另一个本地 session 发送：

- **request**：把原始正文排队为工作；
- **notification**：只记录信息，不启动工作。

默认 accepted wait 只确认已接收，不代表完成。completed wait 可以等待受限时长并
返回终态结果。超时只停止发送方等待，不会取消目标执行。完成摘要会回到原 session，
使其不必轮询即可继续。

`session` agent 工具与 `spark daemon session inbox` 的 list/read/ack 都通过
daemon RPC；本地 Web 与 Hub 只呈现对应 session 拥有的请求，不会直接打开另一个
session 的 mailbox 文件。

## 消息平台 Channel

Channel adapter 会规范化平台入站消息，在不需要 Workspace 的前提下解析私有
daemon-scoped root Session，再通过 daemon 提交。它不拥有 task、session 或执行
真相。Provider 返回结果不明确时，出站投递会 fail closed，避免自动重复发送。
账号身份、存储、迁移与操作见 [Daemon 全局 Channel](/zh/guides/channels/)。

为了缩小远程攻击面，channel-bound agent 只获得四个 canonical 工具：

- `session` 向其他 session 发送 request 或 notification。
- `ask` 暂停并等待结构化用户输入。
- `context` 预览已注册的受限上下文 provider。
- `todo` 跟踪当前 session 的清单。

`session` 工具只能在同一 daemon scope 内 list/send。Shell、files、Git、Workspace
或 repository Memory、role fan-out、assignment、Task 和 Workflow execution 在该
表面保持禁用。

## MCP 客户端

`spark mcp`（或 companion executable `spark-mcp`）是供 MCP client 显式启动的
只读 stdio adapter。Memory status/list 会委托给 canonical Spark Memory owner；
它不会增加新的 store、session 或 executor。

## ACP 客户端

`spark acp` 是兼容编辑器客户端的 stdio adapter。文本 prompt、取消、流式更新和
tool permission 都使用 canonical daemon session。它是适配器，不是新的 session
store 或执行器。
