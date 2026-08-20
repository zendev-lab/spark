---
title: 快速开始
description: 安装 Spark、配置模型，并完成第一次前台或交互运行。
sidebar:
  order: 2
---

## 环境要求

Spark 当前要求 Node.js `>=24`。`@zendev-lab/spark` 是完整安装包，并会
安装版本匹配的 daemon、Hub 与本地 Web app package。仅部署单个进程时，也可以独立
安装对应 app。

## 安装

推荐使用 managed installation，以获得原子升级与回滚能力：

```bash
pnpm dlx @zendev-lab/spark install --managed
spark version --json
spark update status --json
```

也可以继续由 package manager 管理完整安装：

```bash
npm install --global @zendev-lab/spark
spark --help
```

如果某个 host 只需要一个可执行程序，可以直接安装对应 app package：

```bash
npm install --global @zendev-lab/spark-daemon  # 或 spark-hub / spark-web
spark-daemon --help
```

全局 npm、pnpm、Yarn、Bun 与 Vite+ 安装会把精确版本更新委托给原安装所有者；源码
checkout 只报告迁移指引，不会替换自身。

在排查某个界面前，先运行健康检查：

```bash
spark doctor
```

## 配置模型

Provider 认证和模型选择由 daemon 拥有。先发现当前安装支持的命令，再查看或设置
当前模型：

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

Spark 请求 API key 时应在提示中输入；不要把密钥写进项目文件、`config.json`
或 shell 历史。

## 完成第一次运行

需要前台、非交互式结果时：

```bash
spark run "总结这个仓库，并找出它的验证命令。"
```

脚本集成使用 JSON 模式：

```bash
spark run --json "列出顶层 packages。"
```

需要交互式会话时，从目标 workspace 打开本地工作台：

```bash
spark web
```

Spark 会按需启动或连接本地 daemon。应使用 `spark daemon status --json`
检查服务状态，不要从前端表现猜测 daemon 是否健康。

## 下一步

- 按照[运维与完整使用手册](/zh/guides/operator-handbook/)走通 daemon、Hub、工作区、
  会话和持久执行的完整路径。
- [规划并实现第一个修改](/zh/guides/plan-and-execute/)。
- 查看[完整功能地图](/zh/concepts/feature-map/)，不必先背全部命令。
- 了解[本地 Web 工作台](/zh/guides/web/)。
- 在[前台运行、后台工作和会话](/zh/guides/runs-and-sessions/)之间选择。
- 打开 [Hub Web 界面](/zh/guides/hub/)。
