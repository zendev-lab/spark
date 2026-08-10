---
title: Agent 工具
description: Spark canonical 工具、默认 profile、副作用和受限表面的完整目录。
---

Agent 工具面向模型，不是用户必须背诵的命令。请先描述目标；审计权限、构建 host
profile 或排查能力为何不可用时，再查看本页。

## 原生默认 profile

| 意图 | Canonical 工具 | 效果 |
| --- | --- | --- |
| 请求决策 | `ask` | 暂停并等待结构化用户输入 |
| 读取和修改文件 | `read`, `write`, `edit`, `grep`, `find` | 读取或 workspace 写入 |
| 管理代码交付 | `git` | worktree、原生 PR stack、commit、submit、sync 与 cleanup 生命周期 |
| 搜索和获取网页 | `web_search`, `code_search`, `fetch_content`, `get_search_content` | 外部读取；获取的文本不可信 |
| 查看和修改工作 | `task_read`, `task_write`, `assign`, `todo` | Task/session 状态；assign 可能执行工作 |
| 保存结果 | `artifact`, `evidence`, `memory`, `context` | 产品产物、内部账本、记忆和受限上下文 |
| 协调 agent | `role`, `skill_agent`, `session` | 定义、匿名调用、专属多 Skill Agent、持久 session 与 mail |
| 选择模型 | `models` | 模型目录与选择 |
| 选择 Session 行为或自主续跑 | `mode`, `goal`, `loop`, `repro` | Session `plan`/`execute` mode 与 daemon-owned continuation 状态 |
| 发现和运行流程 | `workflow` | 列出、读取或运行已选 `WORKFLOW.md` 定义 |

表中的文件工具属于 Spark 原生表面。外部 Pi 产品继续使用自己的文件与搜索工具；
Spark 不再替换 Pi 的 `read`、`write`、`edit`、`grep`、`find` 或 `ls` 实现。
Pi 产品兼容只提供增量能力，不承诺与 Spark 原生表面保持完整功能对等。

`artifact` 面向用户，只包含 Issue、GitChange 和 Document。一个 GitChange 拥有一个
worktree 和一个 GitHub 原生 PR stack，由 `git({ action })` 管理生命周期；preview
只是 Document 的视图，不是 Artifact kind。`evidence` 是 agent 内部账本，不会作为
产品产物展示。`context` 只能列出或预览已注册的受限 provider，不能接收任意 prompt。

### 替换 Task 依赖

`task_write({ action: "replace_dependencies" })` 会原子替换一个既有 Task 的完整依赖
集合。调用时必须且只能传入 `task` 或 `taskRef` 之一，并且始终传入 `dependsOn`；
空数组表示清除全部依赖。依赖 selector 可以是精确 Task ref、名称或标题。

该 action 只允许修改依赖，禁止在同一次调用中混入 Task 创建、metadata、plan 或
status 变更。未知或歧义 selector、已取消或跨 Project 的前置 Task、自依赖和循环依赖
都会返回稳定的失败分类。系统会在锁内重新加载后完成全部验证，再执行持久化；失败的
替换不会写入 Task graph 状态。

`skill_agent({ skills, instruction, inputs? })` 按精确名称解析一到八个允许模型调用的
Skill，并使用当前模型启动一个全新的匿名专属 Agent。Host 会把所有选中 Skill 的完整
内容各加载一次。Agent 只接收自包含 instruction 和受限 inputs，不继承父会话
transcript。它可以使用受限的直接工作工具，但不能递归调用 Role、Skill Agent 或持久
Session，不能修改协调状态，也不能发布 Git、Artifact 或 Evidence 状态。只有父 Session
本身需要查看并遵循 `SKILL.md` 时，才改用 `read`。

## Shell 与脚本工具

原生 profile 包含十个 cue-shell 工具：

| 工具 | 用途 |
| --- | --- |
| `cue_exec`, `cue_run` | 直接命令和托管 job |
| `cue_script`, `script_run`, `script_eval` | 已保存或受控 inline script |
| `cue_jobs` | 查看和控制 job |
| `cue_resources` | 查看 resource provider 与 snapshot |
| `cue_schedule` | 管理 schedule |
| `cue_scope` | 查看或管理执行 scope |
| `cue_history` | 读取执行历史 |

这些工具可能执行代码或产生本地/外部副作用。Host 在执行前解析 approval、effect
和串并行策略；未知或冲突的策略会 fail closed。

## 受限与可选 profile

- 消息平台 Channel 只开放 `session`、`ask`、`context` 和 `todo`。
- `fusion` 是显式启用的受限多模型 deliberation，不负责写最终答案，也不能证明运行结果。
- `graft` 是已封存、显式启用的 scratch/candidate/patch 能力，不属于当前 Git 工作流。
- `ls` 只保留给显式配置的 Spark 原生兼容 profile，原生默认 profile 不注册它；
  文件发现使用 `find`，内容搜索使用 `grep`。
- 外部 Pi 兼容可以只开放更小的增量能力子集；当兼容成本高于保留的产品收益时，
  该能力会从 Pi 兼容表面移除。

私有实现与编排 helper 不会出现在公开目录中。

## 执行策略

已注册不代表已激活。Host 可以按表面、mode、permission 或 extension 配置缩小
active tool 集合。只有明确标记为 parallel、无需 approval 的纯读取调用可以并行；
混合、未知、写入、策略修改和外部副作用 batch 都保持串行。
