---
title: 运行与会话
description: 在前台、后台、交互式与恢复执行之间选择。
---

## 前台 headless 工作

`spark run` 会等待 headless 运行结束并打印结果：

```bash
spark run "审查当前 diff。"
spark run --json "返回机器可读的仓库摘要。"
```

需要延续上下文时，恢复一个已知会话：

```bash
spark run --resume <session-id> "继续下一个经过验证的步骤。"
```

## 后台工作

`spark bg` 向 daemon 提交 invocation 并返回 receipt。没有显式会话时，
Spark 会创建 invocation session 标识：

```bash
spark bg --json "运行仓库验证并报告失败项。"
```

向现有会话继续提交工作：

```bash
spark bg --session <session-id> "只重新运行失败的检查。"
```

使用 daemon 命令检查 invocation，不要启动另一个执行器：

```bash
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason "不再需要" --json
```

## 交互式会话

列出 daemon 会话，并从同一个 workspace attach：

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

会话标识会保留对话与执行连续性，但不会绕过 workspace 绑定或权限检查。

每个 workspace 只有一个受保护的 Administrator 根 Session。Role、Skill、Task 与
Workflow 工作运行在 owner-bound 子 Session 中；活跃状态由 queued/running
Invocation 推导，不依赖 UI 计时器。原生会话视图的 `status` 使用同一组三个值
（`idle`、`queued`、`running`）；queued Invocation 不会被折叠成 `running`。临时 owned 子 Session 会随 owner 关闭并默认删除
完整 transcript；只有保留公开记录的 Session 才能用同一稳定 ID、incarnation 和
transcript 恢复。新的 TUI、Hub 和 ACP 对话是该根 Session 下保留内容的 scoped 子
Session。Channel 对话使用同一父级，但保留 Channel 路由与 state binding。Loop 的活动从
`driver` 或 `driver_tick` 子 Session 上卷，且不会暴露子 Session 的私有 prompt。

owned 临时 Session 删除内容前，Spark 会先封存一份有界关闭摘要。Role 与 Skill 子
Session 复用其结构化 outcome 和最终 assistant result；Task 与 Repro 子 Session
复用 Task completion summary，`task_revision` 还会聚合当前 incarnation 的
Invocation、Evidence 与 Artifact 引用。没有有效语义结果时，Spark 会保存仅含元数据
的确定性 fallback，并继续清理内容。该 receipt 是可查询的 Session 元数据，不是
Evidence 或 Memory。

## 创建 Role-bound Session

先创建或选择静态 Role。在可使用工具的 Session 中，`spawn` 创建空子 Session，
`fork` 则把当前 Session 的稳定 transcript 前缀复制到一份独立子 Session：

```ts
session({ action: "spawn", roleRef: "role:project-executor", name: "实现" })
session({ action: "fork", roleRef: "role:builtin-reviewer", name: "审查" })
```

CLI 调用必须显式指定 supervisor：

```bash
spark daemon session spawn --supervisor <session-id> --role-ref <RoleRef> --json
spark daemon session fork --supervisor <session-id> --role-ref <RoleRef> --json
```

两个命令都不接收 instruction，也不会创建 Invocation。拿到子 Session 后，再单独触发工作：

```ts
session({
  action: "send",
  kind: "request",
  toSessionId: "<child-session-id>",
  message: "运行聚焦验证并报告证据。"
})
```

fork 不会与父 Session 共享可写 transcript tail；父子后续 append 与 compact 完全独立。
复制稳定前缀期间父 transcript 若发生变化，Spark 会重试一次，之后返回
`session_transcript_changed`，不会创建撕裂快照。

## 在 Session 之间发送工作

未设置 `onActive` 的 Session request 只尝试投递给空闲目标。目标空闲时，Spark 会立即提交；目标处于 queued 或 running 状态时，Spark 不会持久化消息，并返回 `session_mail_target_active`，提示调用方显式选择一种重试策略：

- `onActive: "queue"`：把 request 放入目标的持久 FIFO 队列。每个目标最多保留三个 pending request；队列已满时不会再写入消息。
- `onActive: "interrupt"`：先取消目标当前的 invocation，再提交新 request。

Notification 仍然只做持久化，不会触发目标执行。

## 应该使用哪一种？

- 只要一个前台结果时使用 `spark run`。
- 希望 shell 在持久提交后立即返回时使用 `spark bg`。
- 需要交互探索与 steering 时使用 `spark` 或 `spark tui`。
- 需要从浏览器观察和控制现有 daemon 工作时使用 Hub Web。
