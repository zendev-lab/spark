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
| 工作协调 | Task、Session `plan`/`execute`/`fleet` mode、Goal、Loop、Repro 与 Workflow | 各领域 owner；持久调度仍由 daemon 拥有 |
| 成果归属 | 产品 Artifact 与内部 Evidence | Artifact store 与 Evidence store 保持分离 |
| Agent 组合 | Role 定义、ephemeral Role call、Owner 派生的 scoped Session 与 Skill Agent | Session/Role registry 与 Skill loader |
| 外部 adapter | Channel、ACP、MCP、Git 与 provider 能力 | Spark 契约后的对应 adapter |

`ask` 会在异步投递或 reviewer timeout takeover 前验证 host interaction capability。
异步接受必须返回关联同一 `interactionRequestId` 的持久 ACK（同时包含
`humanRequestId`）；能力缺失、ACK 畸形、transport 拒绝或 request-id 不匹配都会
fail closed。阻塞 timeout 由 host policy 持有，工具调用方不能自行指定。

## Artifact 与 Evidence

面向用户的 Artifact kind 只有 `issue | git_change | document`。一个
`git_change` 拥有一个 worktree 和一个原生 PR stack；Preview 是 Document
的视图，不是新的 Artifact kind。

Evidence 记录内部 claim 与验证。Artifact 和 Evidence ref 使用不同的命名空间、
store、权限和生命周期。工具不能把文件路径、transcript 陈述或未验证结果静默提升为
任一种对象。

## 替换 Task 依赖

`task_write({ action: "replace_dependencies", taskRef, dependsOn })` 会原子替换一个
既有 Task 的完整依赖集合；空 `dependsOn` 数组表示清除全部依赖。selector 可以是精确
Task ref、名称或标题；旧 `task` 拼写只保留为受限 decoder 输入，不再作为模型字段。

该 action 只允许修改依赖，禁止在同一次调用中混入 Task 创建、metadata、plan 或
status 变更。未知或歧义 selector、已取消或跨 Project 的前置 Task、自依赖和循环依赖
都会返回稳定的失败分类。系统会在锁内重新加载后完成全部验证，再执行持久化；失败的
替换不会写入 Task graph 状态。

## Role、Session 与 Skill Agent

- Role 定义类型化能力与责任叠加，包括语义 Model Type。它可以声明最多八个有序
  Skill；Spark 在创建子 Session 前解析并预载完整指令正文。Role 不决定 Session
  生命周期。
- Session 是拥有 continuity、binding、call 和 mail 的运行实例。唯一
  Owner 推导出 `persistent | scoped | ephemeral` 生命周期。
- `skill_agent({ skills, instruction, inputs?, timeoutMs?, model?, thinking?, allowedTools?, allowedToolEffects? })`
  按精确名称解析一到八个 Skill，在一个全新的 owned 子 Session 中各加载一次。
  它只接收显式 packet，不继承父 transcript，也不能递归调用 Role 或 Skill Agent，
  或管理其他 Session。

预定义 Role 在同一个 Session 中直接遵循预载 Skill，不会为它们调用
`skill_agent`。Definition revision 包含 Skill 名称，执行时的 composition revision
还会冻结 Skill source digest。

Role 子 Session 通过语义 Model Type 选择模型。Skill Agent 则默认继承父 Session
精确的 model、thinking level、active tools 与 allowed effects。调用方可以覆盖 model
和 thinking，但 tools 与 effects 只能同时收窄父包络与固定的 Skill Agent 安全上限；
旧宿主若不提供精确 delegation envelope 会直接拒绝。Owned 子 Session 关闭时会先
封存一份有界 receipt，再删除完整 transcript 和 Invocation 内容载荷。该 receipt 是
Session 运维元数据，不是 Evidence。

父 Session 仍负责拆解、持久协调、验证重要结论和面向用户的综合。

Workflow 子调用可以提供 `role` selector 或精确 `roleRef`，但不能同时提供。Spark
会在审批前把 selector 解析为唯一的 Role ref 与 revision，并将该绑定写入审批与运行
溯源。如果绑定无法解析或在子 Role 启动前发生变化，执行会 fail closed。

## Task 与 Workflow 所有权

`task_read` 严格只读；其 `run_status` 只接受 `status`、`list` 和 `inspect`。
WorkflowRun 的 reconcile、ack、输入投递和终止统一使用
`workflow({ action: "runs", runAction: ... })`。`assign` 表示显式派发：模型可以选择
`taskRefs`，而 concurrency、timeout 与 preview 策略由 host 持有，不再作为每次调用的
scheduler 参数。

`todo({ action: "update", items })` 与 `task_write({ action: "plan_update",
items })` 都会原子 reconcile 一份完整目标 checklist。每项必须给出显式 status，且最多一个
`in_progress`；遗漏的旧项会成为 deleted history。旧的 transition 动词不再面向模型。

## Task finish 审查

把 Task 完成到 `done` 时，Lens、plan、Evidence 与 follow-up 的确定性 gate
保持不变。Spark 通常使用独立配置的 `verification` Model Type，对准备好的有界 packet
执行一次无工具的结构化审查。只有显式返回 `needs_deep_review`，才会升级到完整 Reviewer
Session；leaf 的模型、路由或协议失败会阻止状态迁移，不会静默放行。

## Effect、审批与并行

每个 active tool 都携带由 Host 执行的 effect 与权限策略。未知或冲突策略会
fail closed。

- 只有明确允许并行的纯读取调用可以并发。
- 写入、策略变更、混合 batch 和外部副作用保持串行，除非所属契约证明了安全替代。
- 必需审批属于执行权限，不是展示文本。
- 兼容与 Channel profile 可以比原生 TUI 或 Hub Session 暴露更小的集合。

私有实现 helper 不是公开工具。要查看当前安装版本的命令，请阅读
[命令发现](/zh/reference/cli/)。
