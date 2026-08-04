---
title: Hub Web
description: 启动 Hub Web 界面，理解它与 daemon 的关系，并保护远程浏览器访问。
---

## 何时使用 Hub Web

当单个终端会话视野不足时，使用 Hub Web。Workspace workbench 提供：

- **概览**：连接状态与常用入口；
- 固定的**对话**侧栏：继续已有 session 或开始新对话；
- **收件箱**：处理问题与确认；
- **产物**：查看 Issue、PR 与 preview；
- **资源**：管理仓库、文档、链接和工具。

进入对话后，会话检查器把摘要、产物、变更和任务分开。摘要先显示状态与数量；
工作目录、模型、session ID 和时间放在默认折叠的技术详情中。

TUI 的 `/inspect` 只展示当前终端 session 的本地投影；Hub Web 是跨 session 和
workspace 的浏览器控制面。两者都把执行提交给 Spark daemon。

## 启动 Hub Web

```bash
spark hub
```

打开命令输出的 URL。Hub Web 是控制与投影界面；持久执行仍由 Spark daemon 拥有。

如果页面无法加载会话数据，应分别检查两个进程：

```bash
spark daemon status --json
spark hub
```

## 本地与远程访问

Loopback 使用本地 owner flow。对于非 loopback Hub，优先使用 Tailscale、
WireGuard 或 SSH forwarding 等加密私有路径。

在 Hub host 上创建一次性浏览器 key：

```bash
spark hub access create
```

在 `/login` 交换该 key。Workspace 范围的浏览器访问使用另一种一次性 key：

```bash
spark hub workspace access create --workspace <id>
```

在 `/{slug}/login` 交换它。两种 key 都应视为秘密。非 loopback 访问要求 HTTPS，
除非你明确在受信任的私有网络上允许不安全 HTTP。

## 注册远程 workspace

先授权 daemon 机器，再用独立的新 registration token 注册每个 workspace：

```bash
spark daemon login --server-url https://cockpit.example
spark daemon workspace register . \
  --server-url https://cockpit.example \
  --token <workspace-token> \
  --name <workspace-name>
```

机器连接凭据和一次性 workspace registration token 的 scope 不同，不能互相复用。
