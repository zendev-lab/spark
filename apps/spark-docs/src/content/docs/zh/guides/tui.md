---
title: TUI
description: 优先使用自然语言，只在需要时展开当前会话的本地控制。
---

在 Spark 应当操作的工作空间中启动终端界面：

```bash
spark
```

## 从结果开始

普通输入是主要交互方式：

```text
修复登录测试，但不要修改公开 API。验证通过并展示证据后再宣布完成。
```

不需要先选择工具、Loop 或 command plane。多步骤修改先用 `/plan`，计划确认后
再用 `/implement`。

## 日常控制

短帮助只保留常用路径：

```text
/help
/plan <目标>
/implement [范围]
/status
/stop [原因]
/retry
/inbox
```

模型、推理强度、会话选择和输入队列会在需要时出现。它们是当前交互的控制项，
不是独立产品功能。

## 查看当前会话

用 `/inspect` 或 Ctrl+K 打开本地会话检查器：

```text
/inspect
/inspect tasks
/inspect artifacts
/inspect off
```

这里只展示已经发布到当前 TUI 的投影，不是 Web Cockpit，也不会创建新的执行
所有者。需要跨会话和工作空间监督时，在另一个终端运行 `spark cockpit`。

旧的 `/cockpit` 拼写仍可作为兼容别名执行，但不会出现在普通补全中。

## 需要时再展开

- `/help` 显示日常短路径。
- `/help commands` 按常用工作、自动推进、workflow、session 和高级控制分组。
- `/help all` 额外显示兼容别名和诊断 metadata。
- `/automate` 帮助选择 Goal、Loop、Repro 或 Workflow，只预填已有 canonical
  命令，不会直接启动。

这套层级让完整命令目录仍然可搜索，同时避免用户在第一个任务前先学习所有
extension 命令。
