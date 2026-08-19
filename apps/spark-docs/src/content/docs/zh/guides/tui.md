---
title: TUI
description: Spark 终端 UI 已移除。请改用 spark web 或 spark run。
---

Spark TUI 不再随安装分发。本地交互改用回环浏览器工作台；headless turn 走
daemon。

```bash
spark web
spark run --json "Summarize the current repository."
```

会话 attach、对话和设置见[本地 Web 工作台](/zh/guides/web/)。前台与后台
daemon turn 见[运行与会话](/zh/guides/runs-and-sessions/)。`spark tui`
会报错并退出。
