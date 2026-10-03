---
title: Side Threads
description: 在只读的旁支会话中提问，并有意识地把有用上下文交回主会话。
---

Side Thread 是 daemon 拥有、附属于父 Session 的只读子 Session 功能，不是另一种
运行时实体；子 Session 会作为 subsession 显示在普通 Session tree 中。它适合调查
旁支问题，同时避免污染父对话。

## 基本流程

在 Hub Web 中打开一个对话，点击对话标题栏里的**旁路线程**。尚未创建子 Session
时先选择**开启旁路线程**，输入一个有界调查问题，例如“这个模块对 retry 有哪些
假设？”，再选择**发送调查**。

对话框会显示 generation、状态、实际模型与 thinking level、待处理工作和最近可见
exchange。结论确实属于主对话时，选择**回传摘要**或**回传完整记录**，并可补充主
对话应如何使用该结论。

## 重置与配置

使用**重置代次**为新 generation 选择 contextual 或 tangent 模式。对话框也可为
子 Session 单独设置 provider、model 和 thinking level；留空则继承父 Session。

重置会先关闭当前子 Session incarnation 并封存有界关闭回执，再以同一个稳定 Session
ID 开始新的 Side Thread generation 和 Session incarnation。模型和 thinking override
只影响子会话。

## 只读边界

Side Threads 只能使用只读 tool effect。写入、命令执行、策略变更和外部副作用会被
host 拒绝。回答可以建议修改，但不能声称已经执行了修改。

`handoff full` 或 `handoff summary` 会把选定结果显式接纳到主会话，并在接纳后
重置子会话。只有当旁支结论确实属于主线时才进行 handoff。

父 Session 关闭时，daemon 会先关闭 Side Thread。完整 transcript 与 Invocation
内容会被删除；有界摘要、用量、执行画像和显式 Evidence 仍可供授权诊断查询。
重置会保留上一 incarnation 的回执元数据，但不会恢复其 transcript 或重新打开子
Session。
