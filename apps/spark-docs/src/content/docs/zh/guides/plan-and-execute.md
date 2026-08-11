---
title: 规划并实现一个修改
description: 把目标转换成可验证任务，执行确认后的计划，并检查最终结果。
---

先描述希望得到的结果。在 Spark 理解任务之前，不需要先选择执行机制。

```bash
cd <工作区>
spark
```

然后用自然语言描述目标：

```text
修复登录失败，但不要改变公开 API。运行相关测试，并在宣布完成前展示验证证据。
```

## 只需要理解五个名称

| 名称 | 含义 |
| --- | --- |
| 工作区（Workspace） | Spark 正在处理的仓库或目录 |
| 会话（Session） | 持续的对话及其上下文 |
| 任务（Task） | 目标中一个可以独立验证的部分 |
| 运行（Run） | 一次执行尝试 |
| 产物（Artifact） | Preview、Issue 或 Pull Request 等持久结果 |

这五个名称足以完成主路径。需要时再到 CLI 参考中查看运维细节。

## 建立计划

当修改需要调查或包含多个有效步骤时，使用 `/plan`：

```text
/plan 修复登录失败。先检查当前实现，创建可验证任务，但暂时不要实现。
```

Spark 会调查工作区并创建或完善持久任务。检查建议的范围、成功条件、依赖和
验证命令，然后直接用自然语言调整：

```text
这次不修改数据库迁移。把浏览器回归测试加入成功条件。
```

## 执行确认后的计划

计划确认后：

```text
/execute 执行刚刚确认的计划；如果缺少必须由我决定的信息，就停下来询问。
```

Spark 会处理所有已就绪任务，直到计划完成、验证失败或需要你的输入。遇到无法安全
代替你做出的实质决策时，可以在当前会话回答，或者打开 `/inbox`。

## 用 Fleet 并行推进独立前沿

当确认后的计划至少有两个 ready Task，且它们的 GitChange 目标互不重叠时，可以使用
Fleet：

```text
/fleet 派发当前安全的 ready frontier；隔离预检失败或遇到实质决策时停止并询问。
```

Fleet 父会话只负责协调，不直接修改源码、变更 Git、执行 Cue，也不会通过 Role、
Skill 或 Workflow 启动旁路 worker。`assign` 是唯一派发入口。每个 Task 必须已经关联
一个 attached `git_change` Artifact：只有一个时 Spark 可以推导；有多个时，执行策略
必须明确 primary target 和精确 writable target 集合。Fleet 不创建或猜测 worktree。

任何 writable target 重叠的 Task 都会串行执行；完全不相交的目标集合才可以并行。
同一 owner Session、Project、Role、primary target 和完整 writable target 集合组成一个
可复用 worker 执行流。同一执行流的连续 Task 复用 worker Session 及上下文；
`continuity: "fresh"` 会强制新建 Session。多仓库 Task 默认在 primary worktree 中运行，
同时锁定并授权本次运行使用所有列出的目标。

Fleet 状态投影包括：

- `recommended`：当前至少可以安全派发两个不冲突的目标集合；
- `running` 和 `workers`：活跃 TaskRun 与可复用 worker Session 数；
- `ready`：目标和资源预检前、依赖已经满足的 Task 数；
- `attention`：需要父会话处理的 blocked 或 failed Task 数；
- `done`：已完成 Task 数。

worker 结束后，completion mail 只负责唤醒父会话。Spark 会先幂等 reconcile TaskRun
和资源租约，不会把邮件文本当作完成事实。随后父会话明确选择：在 `maxAttempts` 内
recover 后重试、继续派发无关 ready Task、向你 Ask，或等待。离开 Fleet 只停止新派发，
不会取消已经接纳的 worker；重新进入后从持久 TaskGraph、TaskRun、租约和 Session
Registry 恢复。

每次运行都会冻结 execution scope。worktree 文件写入、Git 目标和本地 Cue
执行必须位于授权集合；readonly Task 禁止写入，isolated-results Task 只能写入自己的
`.spark/task-results/<jobId>`。缺失、移动、过期、跨 Workspace、路径穿越、symlink
逃逸、未授权 secondary repo 和远程 Cue 目标都会 fail closed。

## 检查结果

当前会话会显示实现摘要和验证结果。需要更完整的视图时，启动 Hub Web：

```bash
spark hub
```

打开同一个工作区和会话，然后检查：

- **Summary**：当前结果和剩余工作，
- **Tasks**：计划进度和阻塞，
- **Changes**：运行时提供的结构化变更，
- **Artifacts**：本次运行实际生成的 Preview、Issue 或 Pull Request。

Changes 或 Artifacts 为空，表示运行时没有发布对应结果；Hub Web 不会从聊天文本中
猜测它们。

## 只在需要时选择其他执行方式

- 只需要一个前台结果时使用 [`spark run`](/zh/guides/runs-and-sessions/)。
- 希望 shell 立即返回时使用 [`spark bg`](/zh/guides/runs-and-sessions/)。
- 需要持久目标、重复工作、证据门控复现或已保存工作流时使用[自动推进](/zh/guides/automation/)。
