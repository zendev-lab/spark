---
title: 故障排查
description: 按正确顺序诊断 TUI、daemon、会话、路径和 Hub 故障。
---

## TUI 提示需要交互式终端

`spark` 和 `spark tui` 要求 stdin 与 stdout 都是 TTY。脚本或重定向输出应使用
headless 界面：

```bash
spark run --json "检查这个仓库。"
```

## 运行或 Hub Web 页面看起来卡住

分别检查前端健康和 daemon 执行：

```bash
spark doctor
spark daemon status --json
spark daemon logs --lines 200
```

如果已经有 invocation identifier，应检查它的状态与事件流，不要再次提交相同工作。

## 无法 attach 会话

会话与 workspace 绑定。切换到创建会话时使用的同一个 canonical workspace 后重试：

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

## Spark 读取了意外的配置

检查当前有效根目录：

```bash
spark paths --json
```

检查是否有意设置了 `SPARK_HOME` 和相关 XDG 变量。不要把复制凭据或状态作为第一修复手段。

## Managed update 失败

重试前先检查持久化的 updater 状态：

```bash
spark update status --json
```

失败的 candidate 会被 quarantine，不会自动重复尝试。只有修复报告的问题后，才使用
`spark update retry <version> --yes`。回滚只切换 executable 版本，不会恢复旧数据库
快照，也不会丢弃会话。

## Hub 返回错误或没有 workspace

先确认 Hub 本身正在运行，再分别检查 daemon 健康、workspace registration
以及 daemon 使用的 URL：

```bash
spark daemon status --json
spark daemon workspace ls --json
```

远程访问需要分别确认 HTTPS、机器登录、workspace registration 与浏览器 key scope。

## 重试失败的外部投递之前

不要假设超时代表没有发送。外部投递结果不确定时，Spark 会 fail closed。
只有记录结果证明没有发送，或 provider 提供可去重 identity 时，才应重试。

## `spark web` 在 DSH 启动前停止

如果已安装 DSH 不是精确的 `0.1.0-rc.7`，或其自带 preset 源文件与锁定摘要不一致，
Cue adapter 会在写入 bundle 或 preset 前失败。请安装受支持版本，不要修改 DSH 自带
preset 目录。

如果已有未带 Spark marker 的 `spark-standard` / `spark-code`，或者受管目录在安装后
被用户修改，Spark 也会拒绝覆盖。把冲突目录移动到其他 preset id 后重试；Spark
绝不会静默覆盖用户修改。

Cue 调用提示需要 `danger-full-access` 时，应先修改当前 DSH Session policy。此
adapter 不会发起 approval，因为外部 daemon 不在 DSH 文件沙箱内。

SSH 模式必须配置显式 `remoteCwd`，并在远端先启动 `cued`。本地 cwd 永不复用于
远端，只有本地 daemon 不可达时才可能自动启动。连接或协议错误属于基础设施失败；
job 失败或取消则作为可检查的结构化 Cue 结果返回。

## `spark web` 打印 loader 失败链

DSH 插件树加载失败时，Spark 会把完整的 AggregateError/cause 链打印为逐层
缩进的 `spark web:` 行。读最内层，而不是首行摘要：每一层都指明失败的
loader entry 和底层原因（例如某个 package 无法从 profile 解析）。应修复
被点名的 entry——通常是失效的插件链接或被手工改过的 profile——而不是
盲目重试。

Spark 以 Node `--expose-internals` 拉起 profile，裸插件名经 Node 内部 ESM
loader 解析，不依赖 loader 的可选原生 addon。如果绕过 `spark web` 直接运行
生成的 boot 脚本，必须保留该 flag——否则所有裸包名 entry 会同时失败并
汇成一个 AggregateError。
