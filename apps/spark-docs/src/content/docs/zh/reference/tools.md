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
| 协调 agent | `role`, `skill_delegate`, `session` | 定义、匿名调用、专属 Skill Worker、持久 session 与 mail |
| 选择模型 | `models` | 模型目录与选择 |
| 自主续跑 | `phase`, `goal`, `loop`, `workflow`, `repro` | Session phase 与 daemon-owned Goal、WorkflowRun、Loop 状态 |
| 发现和运行流程 | `workflow`, `workflow_run` | 读取 saved workflow 或执行已选流程 |

`artifact` 面向用户，只包含 Issue、GitChange 和 Document。一个 GitChange 拥有一个
worktree 和一个 GitHub 原生 PR stack，由 `git({ action })` 管理生命周期；preview
只是 Document 的视图，不是 Artifact kind。`evidence` 是 agent 内部账本，不会作为
产品产物展示。`context` 只能列出或预览已注册的受限 provider，不能接收任意 prompt。

`skill_delegate({ skill, instruction, inputs? })` 按精确名称解析一个允许模型调用的
Skill，并使用当前模型启动一个全新匿名 Worker。Worker 只接收 Skill 指令和显式、
自包含的委派请求，不继承父会话 transcript。它可以使用受限的直接工作工具，但不能
递归调用 Role 或 Skill、管理持久 Session、修改 Task，或发布 Git、Artifact、Evidence
状态。只有父会话本身需要查看并遵循 `SKILL.md` 时，才改用 `read`。

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
- `ls` 只保留给显式配置的兼容 profile，原生默认 profile 不注册它；文件发现使用
  `find`，内容搜索使用 `grep`。
- 兼容 host 可以启用 Pi alias，但原生默认 profile 会隐藏它们。

私有实现与编排 helper 不会出现在公开目录中。

## 执行策略

已注册不代表已激活。Host 可以按表面、phase、permission 或 extension 配置缩小
active tool 集合。只有明确标记为 parallel、无需 approval 的纯读取调用可以并行；
混合、未知、写入、策略修改和外部副作用 batch 都保持串行。
