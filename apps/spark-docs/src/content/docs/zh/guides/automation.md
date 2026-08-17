---
title: 自动推进长期工作
description: 只有普通 Plan 与 Implement 路径不够时，才选择 Goal、Loop、Repro 或 Workflow。
---

普通项目修改先使用[规划并实现](/zh/guides/plan-and-execute/)。只有工作需要跨多个
步骤自主推进、重复、遵循复现门控或执行已保存流程时，才选择自动推进。

不确定该选哪一种模式时，使用：

```text
/automate
```

选择器只会预填下面某个 canonical 命令，不会直接启动，也不会创建第五种自动推进模式。

| 需要 | 使用 | 示例 |
| --- | --- | --- |
| 持续推进到明确结果完成 | Goal | `/goal start 完成发布检查清单` |
| 重复开放式工作 | Loop | `/loop start 持续发现并分类新的失败` |
| 在每个里程碑绑定证据后复现模型或系统 | Repro | `/repro start 在框架 Y 中复现模型 X` |
| 执行已保存的分阶段流程 | Workflow | `/workflow run builtin:research 比较两个设计` |

## Goal

Goal 围绕一个持久结果继续工作，在完成、失败或需要你的输入时停止。

Goal 仍只有一条 runtime 线。`active`、`waiting_decision`、`paused` 和 `complete`
都由 TaskGraph 推导；等待决定不会阻止互不相关的 ready Task 继续运行。

```text
/goal start <目标>
/goal status
/goal stop
/goal restart [目标]
```

## Loop

Loop 用于刻意保持开放的重复工作。只有当前步骤明确调度下一步时，它才会继续。

```text
/loop start <目标>
/loop status
/loop stop
/loop restart [目标]
```

如果每一步都应在新的 owned 子 Session 中运行，同时保留同一个工作区状态，使用
`/loop fresh <目标>`。子 Session 会在 tick 结束后关闭，通常删除完整 transcript；
删除前 daemon 会从 tick result 封存一份有界关闭回执。使用 driver 生命周期的 Loop
则在 driver Session 关闭时封存最终 evaluation result。父 Session 仍保留有界活动、
用量和显式 Evidence，但这些回执不会作为 transcript 消息注入父 Session。

## Repro

Repro 把证据门控工作组织为 Implementation Explore、Exactness Explore 和 Formalize。
两条 Explore 线可以独立推进，但不会改变正式进度；只有 Formalize 接受一次 retirement
才会更新 `formalizedTip`，它与正在演进的 Git Change stack tip 不同。

Implementation 把候选改动向前交给 Exactness，Exactness 把验证过的候选交给
Formalize；resolution 反向流动，用来消除临时工作。Exactness mismatch 必须记录首个
异常边界、分类、置信度和处置；跳过检查必须同时声明 isolate 与 resync。

当前用户 Session 就是 Repro Root。Implementation 或 Exactness 中每个可写 WorkItem
都在独立的受管 Task Session 和候选 worktree 中运行；Formalize 只有一个串行 canonical
integrator 和一个 Git Change，每个 WorkItem 对应一个 Draft stack entry。结构化 lane-result
Evidence 会自动向前路由；Formalize 完成后，再在原候选 worktree 中依次 refresh
Exactness 与 Implementation。Lane worker 不能直接 Ask，只有按稳定 decision key 去重的
结构化决策请求会进入 Root Inbox。缺少基线、关键决定或批准时，Repro 会暂停询问，
而不是猜测。可以用 `/inspect repro` 查看 binding、TaskRun、Git Change、route 和 refresh
状态的有界 daemon 投影。

```text
/repro start <目标>
/repro status
/repro stop
/repro restart [目标]
```

## Workflow

使用一个规范命令发现、运行和控制工作流：

```text
/workflow
/workflow list
/workflow run <builtin:foo|workspace:foo|user:foo> [关注点]
/workflow runs [runRef]
/workflow inspect <runRef>
/workflow pause <runRef>
/workflow resume <runRef>
/workflow stop <runRef>
/workflow restart <runRef>
/workflow save <runRef>
/workflow ack <runRef>
```

空的 `/workflow` 会打开选择器。`/workflows`、`/workflow-runs` 和
`/workflow-pause` 等旧命令仍可作为兼容别名执行，但不会出现在普通命令目录中。

Spark 自带三条仓库工程工作流：

- `workspace:repo-change` 对边界已明确的改动执行 owner 范围确认、实现、独立审查和
  交付验证；
- `workspace:maintainability-change` 先建立行为基线，分别审查正确性与非必要复杂度，
  再执行有限的等价优化并重新独立审查；
- `workspace:feature-change` 将仓库/外部调研、架构选型、计划、实现和独立审查拆成
  明确的结构化交接。

涉及 `.agents` 知识时会额外加入独立 curator 审查。三条工作流都只返回结构化的
accepted 或 rejected 证据，不会创建、推送、合并或发布 pull request。

## 监督执行，而不是背诵状态

使用 `/help` 查看最短日常路径，使用 `/help commands` 查看分组命令；只有诊断别名或
Extension 注册时才使用 `/help all`。

自动推进需要你决定时，在当前会话回答或打开 `/inbox`。Hub Web 提供 Session
活动，以及 Tasks、Artifacts 和 Inbox 视图。
