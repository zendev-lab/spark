---
title: 故障排查
description: 按正确顺序诊断本地 Web、daemon、会话、路径和 Hub 故障。
---

## `spark tui` 提示 TUI 已移除

终端 UI 不再随安装分发。请改用本地工作台或 headless 界面：

```bash
spark web
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

## `spark web` 提示 daemon 启动失败

不要把 socket 缺失直接当作根因，先看错误中的 `details`。Web launcher 会等待
真实的 daemon RPC 响应；如果 service 在 ready 前退出，它会报告本次启动新写入的
最后一条 daemon 诊断。

```bash
spark doctor
spark daemon logs --lines 100
```

不要把删除或替换 daemon 状态当作第一步修复。如果 detail 是 schema 或 migration
错误，请保留数据库，并在问题报告中附上诊断代码、detail、Spark 版本与
`spark paths --json` 输出。

## 无法 attach 会话

会话与 workspace 绑定。切换到创建会话时使用的同一个 canonical workspace 后重试：

```bash
spark daemon session list --json
spark web
```

## Spark 读取了意外的配置

检查当前有效根目录：

```bash
spark paths --json
```

查找是否故意设置了 `SPARK_HOME` 以及相关 XDG 变量。不要把复制凭证或状态当作
第一步修复。

## managed update 失败

重试前先检查持久化的 updater 状态：

```bash
spark update status --json
```

失败候选会被隔离，不会自动重试。只有在处理完报告的失败后，才使用
`spark update retry <version> --yes`。回滚只切换可执行版本，不会恢复旧数据库
快照或丢弃会话。

## Hub 返回错误或没有 workspace

先确认 Hub 本身在运行，再检查 daemon 健康、workspace 注册和 daemon 使用的 URL：

```bash
spark daemon status --json
spark daemon workspace ls --json
```

远程访问时，分别确认 HTTPS、机器登录、workspace 注册和 browser-key 范围。

## 重试失败的外部投递之前

不要假设超时代表没有发送。外部投递结果不确定时，Spark 会 fail closed。
只有记录结果证明没有发送，或 provider 提供可去重 identity 时，才应重试。
