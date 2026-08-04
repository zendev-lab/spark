---
title: 协作与渠道
description: 在协调工作前，先区分 Role、Session、Side Thread 和消息平台 Channel。
slug: zh/0.2/guides/collaboration
---

## 四种协作对象

| 对象 | 用途 | 生命周期与权限 |
| --- | --- | --- |
| Role | 可复用的职责、模型和指令 | 是定义，不是执行身份 |
| Session | 持续对话、执行身份和 mailbox | 持久，由 daemon 拥有 |
| Side Thread | 绑定到父会话的只读旁支问题 | 子 session，通过显式 handoff 回传 |
| Channel | 飞书（Feishu）、如流（Infoflow）或 QQ Bot 对话 | 绑定到 daemon session 的适配器 |

职责需要复用时选择 Role；工作需要独立历史、队列或持久身份时选择 Session；
受限的只读旁支问题使用 [Side Thread](/zh/0.2/guides/side-threads/)。

## Session request 与 notification

Session 可以向另一个本地 session 发送：

* **request**：把原始正文排队为工作；
* **notification**：只记录信息，不启动工作。

默认 accepted wait 只确认已接收，不代表完成。completed wait 可以等待受限时长并
返回终态结果。超时只停止发送方等待，不会取消目标执行。完成摘要会回到原 session，
使其不必轮询即可继续。

`session` agent 工具、TUI `/inbox` 与 `spark daemon session inbox` 的
list/read/ack 都通过 daemon RPC；frontend 和 extension host 不会直接打开另一个
session 的 mailbox 文件。

## 消息平台 Channel

Channel adapter 会规范化平台入站消息，将它绑定到 workspace session，再通过
daemon 提交。它不拥有 task、session 或执行真相。Provider 返回结果不明确时，
出站投递会 fail closed，避免自动重复发送。

为了缩小远程攻击面，channel-bound agent 只获得四个 canonical 工具：

* `session` 向其他 session 发送 request 或 notification。
* `ask` 暂停并等待结构化用户输入。
* `context` 预览已注册的受限上下文 provider。
* `todo` 跟踪当前 session 的清单。

Shell 执行、role fan-out、assign 和 workflow execution 在该表面保持禁用。

## ACP 客户端

`spark acp` 是兼容编辑器客户端的 stdio adapter。文本 prompt、取消、流式更新和
tool permission 都使用 canonical daemon session。它是适配器，不是新的 session
store 或执行器。
