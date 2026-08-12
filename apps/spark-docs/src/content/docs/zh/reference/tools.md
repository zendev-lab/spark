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

- Role 定义类型化能力与责任叠加，包括语义 Model Type；它不决定
  Session 生命周期。
- Session 是拥有 continuity、binding、call 和 mail 的运行实例。唯一
  Owner 推导出 `persistent | scoped | ephemeral` 生命周期。
- `skill_agent({ skills, instruction, inputs? })` 按精确名称解析一到八个 Skill，
  在一个全新的 owned 子 Session 中各加载一次。它只接收显式 packet，不继承父
  transcript，也不能递归调用 Role 或 Skill Agent，或管理其他 Session。

Role 与 Skill Agent 子 Session 通过语义 Model Type 选择模型。缺少绑定时返回
`role_model_type_unconfigured`，不会回退到父 Session 模型。Owned 子 Session 关闭时
会先封存一份有界 receipt，再删除完整 transcript 和 Invocation 内容载荷。该 receipt
是 Session 运维元数据，不是 Evidence。

父 Session 仍负责拆解、持久协调、验证重要结论和面向用户的综合。

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
- `none` 操作不需要人工批准。
- `manual_only` 操作必须有界、低风险且可撤销。手动推进时需要请求批准；活动
  Goal、Loop 或 Repro driver 在已确认目标与 target 范围内可以直接执行，无需重复询问。
  使用 `git submit` 创建或更新 Draft PR 是典型操作。`git sync` 可能发现并修改
  仅存在于远端的 stack 成员，因此仍需人工批准。
- `required` 操作始终需要人工批准，包括破坏性、不可逆、安全敏感、高成本、高影响或
  实质扩大范围的操作，以及发布、部署、合并和把 Draft PR 提升为 Ready。
  未结构化的命令、脚本与定时任务执行也属于 `required`，不能继承受限 Git capability。
- WorkflowRun 不是 continuation driver；只有启动它的 driver 权限仍然有效时，它才继承
  该审批上下文，且自身不能保留 driver 权限。
- Draft submit 或 sync 前，Git 会刷新原生 PR stack；如果已有 Ready 层或 stack 为 mixed，
  则 fail closed。此时必须通过人工批准并使用 `ready=true` 重试；对于 sync，该 flag 只是
  授权修改已有 Ready/mixed stack，不会把 Draft 层提升为 Ready。
- Driver-local Draft delivery 只绑定一个精确 `git_change`：要么是 daemon 解析出的当前
  worktree owner，要么是在稳定 driver Session 的不可变 cwd 仓库内初始化的唯一 Artifact。
  第二个 Artifact 或显式 `repositoryPath` 不能扩大这份权限。daemon 还会冻结规范 GitHub
  仓库及 `origin` 的全部有效 fetch/push URL，Git 会在 delivery 前立即重新检查它们。
- 最后一次成功的远端 Draft 状态刷新，加上 daemon 的副作用边界 claim，构成本地授权点。
  它发生在隔离 Git/GitHub 环境准备完成之后、固定 stack 可执行文件启动之前；后续每次
  操作都会重新执行完整检查。
- 审批属于执行权限，不是展示文本。未知或冲突策略会 fail closed。
- 兼容与 Channel profile 可以比原生 TUI 或 Hub Session 暴露更小的集合。

私有实现 helper 不是公开工具。要查看当前安装版本的命令，请阅读
[命令发现](/zh/reference/cli/)。
