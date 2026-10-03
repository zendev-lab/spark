---
title: Daemon 全局 Channel
description: 把飞书、如流和 QQ Bot 账号连接到 daemon 拥有的私有 Channel Session。
---

Spark Channel 把消息平台对话接入拥有 Session 与 Invocation 的同一个 daemon。
Channel 不要求先注册 Workspace。每个对话会解析为顶层 daemon Channel Session，
与所有 Workspace Session tree 分开。

## 配置 daemon

把账号与路由配置保存在本地文件中，再显式替换 daemon 的全局配置：

```bash
spark daemon channel configure --file <channels.json> --json
spark daemon channel status --json
spark daemon channel reload --json
```

这些命令属于 daemon scope，不接受 `--workspace`。配置位于
`<paths.configDir>/channels.json`；使用 `spark paths --json` 解析当前平台的实际目录。
Spark 以 `0600` 权限写入该文件。不要提交它，也不要把凭据值粘贴到诊断信息中。

每个飞书、如流或 QQ Bot 账号独立运行。Spark 会拒绝重复的账号身份。reload 会先
启动并验证替代 generation，再进行切换；如果新 generation 无法启动，当前
generation 会继续服务，status 会报告失败。

当前 adapter 字段与 notify action 以已安装版本的帮助为准：

```bash
spark daemon channel --help
spark daemon channel notify --action test --json
```

## 对话身份与存储

Spark 使用稳定账号身份与规范化平台对话 key 共同标识自动对话。轮换 secret 不会
改变该身份。两个账号即使收到相同 external key，也会创建不同的 Session 和 cwd；
自动 ingress 从不合并它们。只有显式 binding 操作才能让多个对话共享一个 Session。

每个 Channel Session 都有私有目录：

```text
<paths.dataDir>/channels/sessions/<sessionId>/workspace
```

路径只使用经过校验的 Spark Session ID，不使用 provider user、group 或 conversation
标识。Spark 以 `0700` 权限创建目录，并在每次执行前检查 real path 和目录边界。
关闭或归档 Session 不会删除该目录。临时 transport 状态位于
`<paths.runtimeDir>/channels/`。

## 投递与恢复

Spark 会先持久化入站 receipt，再接纳 Invocation，因此 provider event 重放不会
重复提交工作。出站投递只有在 provider 证明尚未发送，或提供可去重身份时才自动
重试。已 dispatch 但无法证明结果的记录会成为 `uncertain`，之后绝不自动重发。

升级时，只有无歧义的旧 Channel Session 与配置才会通过 backup、journal 和回读
校验迁移。账号、route、secret、Session owner 或 cwd 事实发生歧义时会 fail closed：
Channel listener 保持停止或 degraded，而 daemon 的其他能力继续可用。

## 安全边界

Channel-bound agent 只获得四个 canonical 工具：`session`、`ask`、`context` 和
`todo`。它不能使用 shell、files、Git、GitChange、Workspace 或 repository Memory、
Task、Role fan-out、assignment 或 Workflow execution。`session` 访问只允许在同一
daemon scope 内 list/send，不能直接联系 Workspace Session。

Hub 在 daemon 级 `/settings/channels` 页面展示 Channel。连接多个 daemon 时必须
显式选择 installation/runtime。Daemon Channel Session 与 Workspace 对话分开展示；
远端摘要不会暴露完整 cwd、外部对话 key、账号身份、transcript 或 secret。

更完整的 Session 模型见[运行与会话](/zh/guides/runs-and-sessions/)和
[协作](/zh/guides/collaboration/)；平台实际目录见
[配置与路径](/zh/reference/configuration-and-paths/)。
