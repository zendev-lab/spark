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
checkpoint receipt 和 `formalizedRevision`。该文档来自 daemon 已有的 A2UI 投影；Hub 不保存
第二份 Repro store，也不调度 lane 工作。摘要先显示状态与数量；工作目录、模型、
session ID 和时间放在默认折叠的技术详情中。

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

## 设置与访问范围

Hub owner 会在控制台中同时看到控制面、当前 workspace 和已连接 daemon 的设置。
只持有 workspace 浏览器会话的用户仅看到该 workspace 的设置；控制面和 daemon
级设置不会显示。

Daemon 设置通过当前 workspace 的租约路由。模型页先使用 Hub 最近一次保存的
daemon 投影快速显示，再提供显式的 daemon 刷新；“已连接”只表示凭据存在。
使用**快速测试**会向所选模型发送一次受限、无工具的请求，以确认模型确实能够
响应。调用诊断复用同一条 runtime 连接，不要求 Hub 主机存在 daemon socket。

Channel 属于 daemon 全局设置，不是 Workspace 设置。打开 `/settings/channels`；当
Hub 发现多个 daemon 时，必须显式选择 installation/runtime。该页面按 adapter ID
展示所有已配置账号，并把 daemon Channel Session 与 Workspace 对话分开。远端投影
刻意保持窄范围：绝不暴露凭据、完整 cwd、外部对话 key、账号身份或 transcript。
配置与失败行为见 [Daemon 全局 Channel](/zh/guides/channels/)。

**Hub 更新**只报告 Hub 安装自身的状态；每个已连接 daemon 仍在其所在机器上独立
更新。

## 本地与远程访问

Loopback 使用本地 owner flow。对于非 loopback Hub，优先使用 Tailscale、
WireGuard 或 SSH forwarding 等加密私有路径。

在 Hub host 上创建一次性浏览器 key。每个 key 都要指明其会话可访问的
daemon，member 因此只能看到这些 daemon 拥有的 workspace：

```bash
spark hub access create --daemon <runtime-id>
```

重复 `--daemon`（或用逗号分隔多个 id）即可覆盖多个 daemon；加
`--user <name>` 可为该 key 创建的 member 命名。在 `/login` 交换 key。
owner 不需要 key 绑定的授权列表：该模型落地时现有 owner 已被授予所有
已注册 daemon，新 daemon 注册时也会授予所有活跃 owner。key 应视为秘密。
非 loopback 访问要求 HTTPS，除非你明确在受信任的私有网络上允许不安全
HTTP。

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

## 连接 daemon 并附加 workspace

workspace 身份在 daemon 上。先授权 daemon 机器；Hub 投影由 daemon 调度，不是 workspace 属性：

```bash
spark daemon login --server-url https://hub.example
spark daemon workspace register . --name <workspace-name>
spark daemon workspace register . --token <workspace-token>
```

`spark daemon login` 把 daemon 安装（每台机器一个）绑定到 Hub；第一条
`workspace register` 在本地登记 workspace，带 token 的形式则通过同一个 daemon
绑定宣告它的 Hub 投影。Hub 以 daemon 安装为绑定单位：workspace 都运行在该
daemon 上，并作为它的会话组织形式呈现。宣告 Hub 投影仍需要 enrollment token；
不带 token 时 workspace 保持 daemon 本地，直到被附加。
