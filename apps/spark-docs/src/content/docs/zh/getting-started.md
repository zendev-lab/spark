---
title: 快速开始
description: 安装 Spark、配置模型，并完成第一次前台或交互运行。
sidebar:
  order: 2
---

## 环境要求

Spark 当前要求 Node.js `>=26 <27`。公开产品同时包含 CLI 分发器、原生 TUI、
daemon 与 Hub host。

## 安装

推荐使用 managed installation，以获得原子升级与回滚能力：

```bash
pnpm dlx @zendev-lab/spark install --managed
spark version --json
spark update status --json
```

也可以继续由 package manager 管理安装：

```bash
npm install --global @zendev-lab/spark
spark --help
```

全局 npm、pnpm、Yarn、Bun 与 Vite+ 安装会把精确版本更新委托给原安装所有者；源码
checkout 只报告迁移指引，不会替换自身。

在排查某个界面前，先运行健康检查：

```bash
spark doctor
```

## 配置模型

打开交互式 TUI：

```bash
spark
```

使用 `/login` 查看可用 provider 的认证状态并启动交互式登录流程，使用 `/model`
查看或选择当前模型。Spark 请求 API key 时应在提示框中输入；不要把密钥写进项目文件、
`config.json` 或 shell 历史。

## 完成第一次运行

需要前台、非交互式结果时：

```bash
spark run "总结这个仓库，并找出它的验证命令。"
```

脚本集成使用 JSON 模式：

```bash
spark run --json "列出顶层 packages。"
```

需要交互式会话时，可以停留在 `spark` 中，或运行：

```bash
spark tui "在提出修改前先检查当前项目。"
```

Spark 会按需启动或连接本地 daemon。应使用 `spark daemon status --json`
检查服务状态，不要从前端表现猜测 daemon 是否健康。

## 下一步

- 按照[运维与完整使用手册](/zh/guides/operator-handbook/)走通 daemon、Hub、工作区、
  会话和持久执行的完整路径。
- [规划并实现第一个修改](/zh/guides/plan-and-implement/)。
- 查看[完整功能地图](/zh/concepts/feature-map/)，不必先背全部命令。
- 了解 [TUI 的渐进式控制](/zh/guides/tui/)。
- 在[前台运行、后台工作和会话](/zh/guides/runs-and-sessions/)之间选择。
- 打开 [Hub Web 界面](/zh/guides/cockpit/)。
- 只有普通 Plan 和 Implement 不够时才使用[自动推进](/zh/guides/automation/)。
