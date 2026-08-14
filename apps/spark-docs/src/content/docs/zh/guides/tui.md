---
title: TUI
description: 优先使用自然语言，只在需要时展开当前会话的本地控制。
---

在 Spark 应当操作的工作空间中启动终端界面：

```bash
spark
```

## 从结果开始

普通输入是主要交互方式：

```text
修复登录测试，但不要修改公开 API。验证通过并展示证据后再宣布完成。
```

不需要先选择工具、Loop 或 command plane。多步骤修改先用 `/plan`，计划确认后
用 `/execute`；当确认后的 ready Task 具有互不冲突的现有 worktree 目标时，使用
`/fleet`。

## 日常控制

短帮助只保留常用路径：

```text
/help
/plan <目标>
/execute [范围]
/fleet [范围]
/status
/stop [原因]
/retry
/reload
/inbox
```

模型、推理强度、会话选择和输入队列会在需要时出现。它们是当前交互的控制项，
不是独立产品功能。新会话的默认推理强度为 `high`；会话显式设置或已保存的用户设置
仍然优先。

`/status` 会直接输出 daemon、当前 session、活跃工作、用量和输入队列的完整汇总，
不会先打开 action picker。

可重试的 daemon invocation 失败后，`/retry` 会通过 daemon 创建一个带血缘关系的
新 attempt，并观察新的 invocation；它不会重放失败记录，也不会复用旧 idempotency
key 再次提交 prompt。若模型正常结束却没有可见文本或 tool call，Spark 会先使用同一
invocation 内有上限的 continuation 策略；预算耗尽后再由 `/retry` 显式恢复。
admission 结果未知属于另一类情况：Spark 会自动使用同一提交身份对账，避免产生重复
turn。

`/reload` 会完整替换 TUI worker 进程，同时保留当前 daemon session 及其有效工作目录。
新 worker 会重新 attach，并恢复持久 history 与 daemon 持有的运行中工作；首次启动
Spark 时传入的 prompt 不会被重放。编辑器草稿、overlay、滚动位置和其他内存 UI
状态会重置。如果 command、submission 或 retry 仍在处理中，或已提交的 prompt 尚未
获得持久 daemon 身份，Spark 会拒绝本次 reload，避免本地工作随旧进程消失。

不带参数的 slash command 会直接进入最终 TUI 目标，不再先打开中间 action bar。
例如，`/model` 直接打开模型 selector，`/settings` 显示设置概览，`/queue` 检查
实时队列，裸 `/goal`、`/loop`、`/repro` 则直接显示对应 lifecycle 的状态；
`/thinking` 直接打开最终 thinking-level selector。

编辑器的上、下方向键会按当前 session 中持久化的 `user` prompt 回溯，包括本次
TUI 进程启动之前的 prompt；本地 slash command 不会混入这份 prompt history。
PageUp、PageDown 用来滚动可见对话记录；Ctrl+PageUp、Ctrl+PageDown 仍用于在
多行编辑草稿中移动。提交新输入时，对话会回到最新一行。

Esc 仍会优先取消正在执行的工作。session 空闲且编辑器为空时，在 500 ms 内连续
按两次 Esc，会离开当前对话并打开统一 session hierarchy。

## 查看当前会话

用 `/inspect` 或 Ctrl+K 打开本地会话检查器：

```text
/inspect
/inspect tasks
/inspect artifacts
/inspect repro
/inspect off
```

这里只展示已经发布到当前 TUI 的投影，不是 Hub Web，也不会创建新的执行
所有者。需要跨会话和工作空间监督时，在另一个终端运行 `spark hub`。

daemon 投影活跃 Repro 时，transcript 顶部会常驻一行紧凑的 Implementation / Exactness /
Formalize 摘要，显示计数、阻塞、待交接和最近的 `formalizedTip`。Ctrl+K 会先打开
Repro panel；Shift+Ctrl+K 循环 inspector panel。在 Repro panel 中，用 1、2、3 选择
lane，用方向键或 J/K 选择有界 work item，按 Enter 打开已有 Task、Run、Git Change
和 Evidence 投影组成的详情。Esc 按“详情 → panel → transcript”返回。

TUI 不会从 transcript 文本、prompt 或经过时间推断 lane 状态。窄终端优先保留最新
对话和 composer，再显示 inspector 详情。`/reload` 后 panel 焦点和选择会重置，新
worker 会重新投影同一份 daemon 所有的 Session 与 Repro 状态；已完成 Ask 不会重放。

旧的 `/hub` 拼写仍可作为兼容别名执行，但不会出现在普通补全中。

## 需要时再展开

- `/help` 显示日常短路径。
- `/help commands` 按常用工作、自动推进、workflow、session 和高级控制分组。
- `/help all` 额外显示兼容别名和诊断 metadata。
- `/automate` 帮助选择 Goal、Loop、Repro 或 Workflow，只预填已有 canonical
  命令，不会直接启动。

这套层级让完整命令目录仍然可搜索，同时避免用户在第一个任务前先学习所有
extension 命令。
