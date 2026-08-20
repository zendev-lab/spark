---
title: 界面与所有权
description: 理解 CLI 分发器、本地 Web 工作台、daemon 与 Hub，避免产生相互竞争的真相来源。
---

Spark 提供的是同一个系统的多个视图，而不是多个可以互换的执行器。

| 界面 | 用途 | 所有权 |
| --- | --- | --- |
| `spark` CLI | 稳定的公开命令路由 | 只负责分发 |
| 本地 Web | 这颗 daemon 上的交互式 prompt 与会话 UI | 该 daemon 所绑定全部 workspace 的浏览器展示 |
| Daemon | 持久会话、invocation、本地 RPC、channel、恢复 | 执行真相与持久本地运行状态 |
| Hub | 多 daemon 代理、认证、注册表、审计、远程接入 | 控制面展示与 Hub 自有协调状态 |
| Updater | managed install、升级策略、原子切换、回滚 | 已安装版本与升级 transaction 状态 |

## 唯一执行所有者

前台 `spark run`、后台 `spark bg`、本地 Web prompt 和 Hub Web 提交最终都使用
daemon 拥有的执行路径。某个前端断开不会把 invocation 的所有权转移给另一个前端。

Updater 是独立的状态所有者，不是另一个执行器。只有在 updater 完成版本切换后，
daemon 才参与带健康检查与目标 fence 的 handoff。

排查状态不一致时，先检查 daemon：

```bash
spark daemon status --json
spark daemon session list --json
```

## Workspace 绑定

workspace 身份绑定到一颗 daemon。本地 Web 列出该 daemon 上的全部
workspace；cwd 只是启动上下文。Hub 转发到多颗 daemon，不拥有
workspace 身份。会话仍落在 daemon workspace 内。

Workspace 内的 Spark 状态位于 `.spark/`。用户配置和服务状态在显式设置时使用
`SPARK_HOME`，否则使用标准 XDG 根目录。详情见[配置与路径](/zh/reference/configuration-and-paths/)。

## 产品边界

`@zendev-lab/spark` 是完整安装用的 meta package：它锁定 CLI 与各 app 的
同版本依赖，但不包含 dispatcher 实现。`@zendev-lab/spark-cli` 拥有真实的
`spark` 命令；`@zendev-lab/spark-daemon`、`@zendev-lab/spark-hub` 与
`@zendev-lab/spark-web` 仍可独立安装。其他源码 workspace 是私有实现边界，
不是受支持的安装目标。
