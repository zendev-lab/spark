---
title: 配置与路径
description: 查看 Spark 配置、凭据、运行状态和 workspace 自有文件。
---

不要根据旧安装推断当前路径，应直接询问分发器：

```bash
spark paths
spark paths --json
```

这些命令只检查有效路径，不会创建文件。

## 自包含的 SPARK_HOME

需要一个显式根目录时设置 `SPARK_HOME`：

```bash
export SPARK_HOME=/path/to/spark-home
```

该根目录中的重要路径包括：

```text
$SPARK_HOME/config.json
$SPARK_HOME/auth.json
$SPARK_HOME/sessions/
$SPARK_HOME/agent/
$SPARK_HOME/prompts/
$SPARK_HOME/themes/
$SPARK_HOME/apps/daemon/{data,cache,state,run}
$SPARK_HOME/apps/hub/{data,cache,state,run}
```

`auth.json` 包含 provider 凭据。不要提交它，也不要把它复制到 workspace 中。

## XDG 默认值

没有设置 `SPARK_HOME` 时，Spark 使用平台的 XDG 配置、数据、缓存、状态和运行根目录：

```text
$XDG_CONFIG_HOME/spark
$XDG_DATA_HOME/spark
$XDG_CACHE_HOME/spark
$XDG_STATE_HOME/spark
$XDG_RUNTIME_DIR/spark
```

某个 XDG 变量没有设置时使用对应的平台默认值。

## Daemon invocation 并发

Daemon 默认最多同时接纳来自不同 session 的 4 个 root invocation。可以把启动值
设置为 `1` 到 `64`，随后重启 daemon 使其生效：

```bash
spark daemon configure --invocation-concurrency 8
spark daemon restart --yes
spark daemon status --json
```

有效运行值位于 `execution.rootConcurrency`；status 还会显示 `in_process` backend
以及为阻塞式问题保留的 1 个 overflow slot。该设置只控制 root invocation 的接纳，
不会创建操作系统 worker 进程；同一 session 内的工作仍然串行执行。

## Cockpit 到 Hub 的升级迁移

首次使用默认 Hub 数据库时，Spark 会自动把已退役的 `cockpit.toml`、
Cockpit XDG 应用目录和 `cockpit.sqlite` 迁移到上面的 Hub 路径。升级前应停止旧
Cockpit 与 Hub 进程。迁移可重复执行并采用 fail-closed 策略：检测到仍活动的旧
数据库锁，或源路径与目标路径同时存在时，启动会停止，不会覆盖任一目录。

请把已有 `SPARK_COCKPIT_*` 值复制到对应的 `SPARK_HUB_*` 名称。升级窗口内
仍会读取旧别名，但新旧名称的值发生冲突时会拒绝启动。新状态只写入 Hub 名称。
已经注册的 daemon 会保留稳定 deployment ID；旧 Cockpit snapshot-v1 备份仍可
检查与恢复。

## Managed installation 路径

Managed installation 使用 XDG data、configuration、state 与 cache 根目录，
不与 `SPARK_HOME` 混为同一状态所有者：

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
```

可用 `SPARK_UPDATE_POLICY` 与 `SPARK_UPDATE_CHANNEL` 临时覆盖策略。运行
`spark update status --json` 查看有效策略与 transaction 状态。持久化的
`checkIntervalHours` 默认为 `24`，可通过
`spark update configure --interval-hours <hours>` 修改。

## Workspace 与 agent 定义

Role、Workflow 和 Skill 共用以下加载优先级（后面的同名资源覆盖前面的）：

```text
builtin -> user -> workspace -> cwd -> configured -> repository
```

- `.spark/` 保存 workspace 自有的 Spark 运行状态。
- `~/.agents/{roles,skills,workflows}` 保存用户级可复用定义。
- `.agents/{roles,skills,workflows}` 保存仓库和 cwd 定义；先扫描仓库祖先，再扫描 cwd 根目录。
- 显式配置的 user 根目录会替换默认 user 根目录。
- 显式配置的 Skill 目录在 cwd 之后扫描。
- 仓库 Skill 由请求匹配或显式 Skill Agent 渐进式聚焦，不会注入启动 catalog。

Workflow 和 Role selector 保持现有 source 名称，其项目根目录共用上述优先级。
`.spark/skills` 保存 workspace 专用的 Spark skills。

不存在 `$SPARK_HOME/skills` 或 `$SPARK_HOME/workflows` 目录。
