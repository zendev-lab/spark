---
title: Hub Web
description: 启动 Hub Web 界面，理解它与 daemon 的关系，并保护远程浏览器访问。
---

## 何时使用 Hub Web

当单个终端会话视野不足时，使用 Hub Web。Workspace workbench 提供：

- **概览**：连接状态与常用入口；
- 固定的**对话**侧栏：继续已有 session 或开始新对话；
- **收件箱**：处理问题与确认；
- **产物**：查看 Issue、Git Change 与 Document；
- **资源**：管理仓库、文档、链接和工具。

进入对话后，会话检查器把摘要、产物、变更、任务和 Lanes 分开。活跃 Repro 的
Lanes 会显示 Implementation、Exactness、Formalize 三张有界卡片，以及向前 handoff、
向后 resolution 和 `formalizedTip`。该文档来自 daemon 已有的 A2UI 投影；Hub 不保存
第二份 Repro store，也不调度 lane 工作。摘要先显示状态与数量；工作目录、模型、
session ID 和时间放在默认折叠的技术详情中。

TUI 的 `/inspect` 只展示当前终端 session 的本地投影；Hub Web 是跨 session 和
workspace 的浏览器控制面。两者都把执行提交给 Spark daemon。

## 启动 Hub Web

```bash
spark hub
```

打开命令输出的 URL。Hub Web 是控制与投影界面；持久执行仍由 Spark daemon 拥有。

如果此安装之前运行过 Spark Cockpit，请先停止旧进程再启动 Hub。首次打开 Hub
数据库时会迁移已退役的 XDG 或 `SPARK_HOME` 应用目录，包括 `cockpit.toml` 与
`cockpit.sqlite`。检测到仍活动的旧锁或源/目标冲突时，迁移会拒绝覆盖。完整映射
与环境变量兼容窗口见[配置与路径](/zh/reference/configuration-and-paths/)。

如果页面无法加载会话数据，应分别检查两个进程：

```bash
spark daemon status --json
spark hub
```

## 设置与访问范围

Hub owner 会在控制台中同时看到控制面、当前 workspace 和已连接 daemon 的设置。
只持有 workspace 浏览器会话的用户仅看到该 workspace 的设置；控制面和 daemon
级设置不会显示。

Daemon 设置通过当前 workspace 的租约路由。模型页先使用 Hub 最近一次保存的
daemon 投影快速显示，再提供显式的 daemon 刷新；“已连接”只表示凭据存在。
使用**快速测试**会向所选模型发送一次受限、无工具的请求，以确认模型确实能够
响应。调用诊断复用同一条 runtime 连接，不要求 Hub 主机存在 daemon socket。

**Hub 更新**只报告 Hub 安装自身的状态；每个已连接 daemon 仍在其所在机器上独立
更新。

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

在 `/{slug}/login` 交换它。如果浏览器已持有另一个 workspace 范围的会话，打开
目标 workspace 的活跃路由时会跳转到该目标的登录页，并在交换 key 后返回原路由。
一个浏览器 Cookie 同时只授权一个 workspace；如需保留多个并行会话，请使用独立
浏览器 profile 或隐私窗口。两种 key 都应视为秘密。非 loopback 访问要求 HTTPS，
除非你明确在受信任的私有网络上允许不安全 HTTP。

## 受信任的反向代理

让 Hub 自身继续只监听 loopback，由受信任代理终止公网 HTTPS：

```bash
HOST=127.0.0.1 \
SPARK_HUB_PUBLIC_URL=https://spark.example.com \
SPARK_HUB_TRUST_PROXY=loopback \
spark hub
```

`SPARK_HUB_PUBLIC_URL` 必须是根路径 `/` 上的 `http(s)` origin，不支持挂载到子路径。
代理必须保留预期公网 host、清理 forwarding headers、提供
`X-Forwarded-For` 与 `X-Forwarded-Proto`、转发 WebSocket upgrade 和未缓冲的
streaming response，并拒绝未知公网 host。

当 forwarding chain 中存在多个受信任代理时，可设置
`SPARK_HUB_PROXY_HOPS=1..10`。`SPARK_HUB_PUBLIC_URL=auto` 只能在同一个受信任
loopback proxy 后使用。公网 origin 改变会改变 daemon 的 server identity，因此应
显式重新注册受影响的 workspace。

## 注册远程 workspace

先授权 daemon 机器，再用独立的新 registration token 注册每个 workspace：

```bash
spark daemon login --server-url https://hub.example
spark daemon workspace register . \
  --server-url https://hub.example \
  --token <workspace-token> \
  --name <workspace-name>
```

机器连接凭据和一次性 workspace registration token 的 scope 不同，不能互相复用。
