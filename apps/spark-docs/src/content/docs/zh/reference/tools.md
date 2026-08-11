---
title: Agent 工具与权限
description: 理解 Spark 如何激活工具、确定状态 owner，并执行 effect 与权限策略。
---

Host 和 Session 向 Agent 提供的 active tool schema，是本次运行的工具表面事实来源。
已注册不代表已激活：surface、mode、permission、extension 配置和兼容策略都可以
缩小可用集合。

本页描述稳定领域与策略，不穷举所有工具名。需要某次运行的精确名称、action 和参数时，
应检查 Host 展示的 active schema。

## 稳定工具领域

当一组 action 共享同一个 owner、状态、权限、渲染和结果契约时，Spark 使用规范化
`tool({ action })` 表面。

| 领域 | 用途 | 权威 owner |
| --- | --- | --- |
| 人机交互 | 结构化问题、审批与关联回答 | 共享交互协议与 daemon 生命周期 |
| 文件与执行 | 读取、搜索、编辑和获准的本地执行 | 在所选工作区运行的 Host adapter |
| 工作协调 | Task、Session、Goal、Loop、Repro 与 Workflow | 各领域 owner；持久调度仍由 daemon 拥有 |
| 成果归属 | 产品 Artifact 与内部 Evidence | Artifact store 与 Evidence store 保持分离 |
| Agent 组合 | Role 与匿名 Skill Agent | Session/Role registry 与 Skill loader |
| 外部 adapter | Channel、ACP、MCP、Git 与 provider 能力 | Spark 契约后的对应 adapter |

## Artifact 与 Evidence

面向用户的 Artifact kind 只有 `issue | git_change | document`。一个
`git_change` 拥有一个 worktree 和一个原生 PR stack；Preview 是 Document
的视图，不是新的 Artifact kind。

Evidence 记录内部 claim 与验证。Artifact 和 Evidence ref 使用不同的命名空间、
store、权限和生命周期。工具不能把文件路径、transcript 陈述或未验证结果静默提升为
任一种对象。

## Role、Session 与 Skill Agent

- Role 定义类型化能力与责任 profile。
- Session 是拥有 continuity、binding、call 和 mail 的持久或临时运行实例。
- `skill_agent({ skills, instruction, inputs? })` 为一次自包含的多 Skill 调用创建
  全新的匿名 Agent。它接收所选 Skill 内容和显式 packet，不继承父 transcript，
  也不能创建第二套持久生命周期。

父 Session 仍负责拆解、持久协调、验证重要结论和面向用户的综合。

## Effect、审批与并行

每个 active tool 都携带由 Host 执行的 effect 与权限策略。未知或冲突策略会
fail closed。

- 只有明确允许并行的纯读取调用可以并发。
- 写入、策略变更、混合 batch 和外部副作用保持串行，除非所属契约证明了安全替代。
- 必需审批属于执行权限，不是展示文本。
- 兼容与 Channel profile 可以比原生 TUI 或 Hub Session 暴露更小的集合。

私有实现 helper 不是公开工具。要查看当前安装版本的命令，请阅读
[命令发现](/zh/reference/cli/)。
