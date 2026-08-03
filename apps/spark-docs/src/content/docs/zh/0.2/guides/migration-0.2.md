---
title: 迁移到 Spark 0.2.0
description: 替换已删除的 Pi 风格 CLI 别名、导入 Pi 认证，并验证 Spark 原生界面。
slug: zh/0.2/guides/migration-0.2
---

Spark 0.2.0 对命令面做硬切。旧别名会以用法错误退出码 `2` 失败；Spark 不会静默
启动 Pi。

## 命令替换

| 已删除命令 | 0.2.0 命令 |
| --- | --- |
| `spark --print <prompt>` 或 `spark -p <prompt>` | `spark run <prompt>` |
| `spark --mode json --print <prompt>` | `spark run --json <prompt>` |
| `spark --list-models` | `spark daemon model list --all` |
| `spark session ...` / `spark sessions ...` | `spark daemon session ...` |
| 根级 Pi 风格 resource 命令 | 使用 managed installation，或显式编辑 Spark 拥有的配置 |

`spark`、`spark run`、`spark bg`、`spark version`、`spark paths`、
`spark doctor`、`spark update` 和 `spark install --managed` 仍是产品入口。

## 一次性导入 Pi 认证

```bash
spark daemon auth import pi --json
spark daemon auth status --json
spark daemon model list --all --json
```

设置了 `PI_CODING_AGENT_DIR` 时，导入器读取其中的 `auth.json`；否则读取
`~/.pi/agent/auth.json`。只接受已注册且类型匹配 provider 的字面 API Key 和
OAuth 记录。环境变量或命令动态引用会报告为
`dynamic_reference_unsupported`，绝不会被求值。

默认保留 Spark 已有凭证。只有检查完仅包含 provider 信息的报告后才使用
`--overwrite`。源文件或 store 失败时，Spark auth 文件保持不变。

## 验证硬切

```bash
spark --print "must fail"
spark --list-models
spark daemon auth status --json
spark daemon model status --json
spark
```

前两条命令必须失败。TUI 内检查 `/help`、`/login`、`/model`、`/status` 和
`/sessions`；`/help` 必须留在本地，Esc 取消模型 picker 不得改变 session model。

Spark 0.2.0 仍在 Spark-owned adapter 后保留 Pi AI/TUI kernel。产品 extension
与公开 CLI 已原生化；renderer 替换属于另一份通过门禁后才能提交的架构决策。
