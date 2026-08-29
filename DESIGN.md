---
name: Spark Conversation + Operations System
description: 让对话画布与多 daemon 操作台共享同一套安静、精确的耐久工作语言
colors:
  primary: "#2563eb"
  primary-hover: "#1d4ed8"
  primary-weak: "#eff6ff"
  on-primary: "#ffffff"
  canvas: "#f8fafc"
  surface: "#ffffff"
  surface-soft: "#f1f5f9"
  ink: "#0f172a"
  ink-muted: "#475569"
  ink-subtle: "#64748b"
  border: "#e2e8f0"
  border-strong: "#cbd5e1"
  success: "#16a34a"
  warning: "#f97316"
  danger: "#ef4444"
typography:
  display:
    fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, Geist Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  xxl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: "40px"
  input-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "40px"
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  attention-selected:
    backgroundColor: "{colors.primary-weak}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xs}"
    padding: "12px 16px"
---

# Design System: Spark Conversation + Operations System

## Overview

**Creative North Star: "对话画布与焦点脉搏"**

Spark 的界面由两种互补的工作姿态构成：Web 是安静、开放的对话画布，Hub 是精确、紧凑的操作台。两者都以大面积冷灰画布承载白色工作面，用细边框明确结构，让 Spark 蓝只负责焦点、选择与主动作。界面不靠装饰制造“智能感”，而是让一次输入、一个等待状态或一项恢复动作都明确落回耐久 Session。

系统共享视觉语言，不强迫共享页面拓扑。Web 用 Composer、最近对话和 Session transcript 建立纵向叙事；Hub 用注意力队列、持续详情和恢复面板建立横向判断。颜色只加强语义，不替代文字；导航、状态、焦点、移动抽屉和恢复语法在两个表面保持一致。

**Key Characteristics:**

- 冷静的 slate 中性色画布与白色工作面
- 1px 结构线优先，阴影只表达层级
- Spark 蓝用于选择、焦点与主动作
- 成功、警告、危险色仅服务于运行状态
- Web 使用 `工作空间 → Session → Invocation`，Hub 使用 `Daemon → 工作空间 → Session → Invocation`
- Web 对话画布与 Hub 队列—详情工作台各自采用任务匹配的拓扑

## Colors

配色以冷灰中性色为场，单一高纯度蓝色为动作声音，语义色保持低面积、强文字说明。

### Primary

- **Spark Action Blue** (`#2563eb`): 主按钮、当前选择、焦点与关键链接。
- **Spark Action Blue Deep** (`#1d4ed8`): 主动作悬停状态。
- **Spark Selection Mist** (`#eff6ff`): 选中队列行和轻量强调背景。

### Neutral

- **Slate Canvas** (`#f8fafc`): 页面底色。
- **Work Surface** (`#ffffff`): 壳层、队列、详情和表单工作面。
- **Soft Slate Surface** (`#f1f5f9`): 悬停、输入辅助面和弱分组。
- **Operational Ink** (`#0f172a`): 标题与主要事实。
- **Muted Ink** (`#475569`): 正文与次要操作。
- **Subtle Ink** (`#64748b`): 注释、时间与辅助标签。
- **Structural Rule** (`#e2e8f0`): 区域分隔和容器边界。

### Secondary

- **Execution Green** (`#16a34a`): 成功和已恢复状态。
- **Attention Orange** (`#f97316`): 人工介入、观测受限与可恢复警告。
- **Failure Red** (`#ef4444`): 失败、危险操作和不可继续状态。

### Named Rules

**The One Blue Voice Rule.** 同一视口中，Spark 蓝只标记当前选择、键盘焦点和最安全的下一步；普通信息不使用蓝色争夺注意力。

**The Semantic Pairing Rule.** 状态颜色必须同时出现文字状态或恢复说明，不能单独承载含义。

深色主题保持相同角色映射：画布转为 `#0b1120`，工作面转为 `#111827`，主动作转为 `#60a5fa`，不改变信息层级。

## Typography

**Display Font:** Inter（回退 Geist Sans、系统无衬线）
**Body Font:** Inter（回退 Geist Sans、系统无衬线）
**Label/Mono Font:** Geist Mono（仅用于代码、标识符和诊断值）

**Character:** 字体系统偏中性、紧凑和清晰，依靠字重、字号与留白建立层级。中文继承同一无衬线栈，不用英文大写或额外字距模拟层级。

### Hierarchy

- **Display**（600，32px，1.2）：极少量产品级标题。
- **Headline**（600，24px，1.25）：页面主标题；字距 `-0.01em`。
- **Section**（600，18px，1.35）：主要区域标题。
- **Title**（600，15px，1.4）：队列项、卡片和恢复标题。
- **Body**（400，14px，1.55）：说明与操作正文，理想行长不超过 72ch。
- **Label**（500，12px，1.45）：状态、元数据、字段名与时间。
- **Mono**（400，12px，1.5）：Invocation id、路径、命令和技术诊断。

### Named Rules

**The Facts Before Codes Rule.** 用户目标与状态使用正文体系；只有无法自然语言化的标识符、路径和诊断值使用等宽字体。

## Layout

应用壳层由 52px 命令栏、240–260px 导航侧栏和可滚动主工作区组成。主内容最大宽度为 1280px，桌面内边距 32px，页面区块用 20–24px 间距组织，跨区段最多使用 48px。

Web Conversation Canvas 在桌面将 Composer 和最近对话限制在约 920px 的中心列中，标题、输入、需要介入的对话与最近 Session 形成单一纵向阅读路径；工作空间表示项目/上下文及其 Session 组，只作为对话上下文，不是账号或首屏目录。Web 不呈现 daemon 名称、数量、选择器或连接拓扑。移动端保留同一路径，收起侧栏并让 Composer 主动作保持至少 44px 的触控尺寸。

Hub Focus + Pulse 在桌面使用约 `0.78fr / 1.22fr` 的队列—详情双栏；队列承担扫描，详情持续展示所选 Session 与 Invocation。无活跃工作时工作面收敛到 420px 高，避免空白被误认为内容；有活动项时可扩展到 660px。900px 以下侧栏变为有焦点陷阱的抽屉，760px 以下双栏按队列、详情顺序堆叠。

Hub 命令栏右侧只呈现 daemon 授权与连接上下文；工作空间目录、产物和注册表单属于第二层项目/上下文，用原生 disclosure 延后呈现。布局不得通过浏览器计时或转录内容推断运行状态。

## Elevation & Depth

系统以边框和色面分层为主，阴影为辅。工作区容器使用极轻的环境阴影；浮层与抽屉使用更深、更宽的软阴影。焦点环使用蓝色半透明外扩，不以发光效果装饰静态元素。

### Shadow Vocabulary

- **Card** (`0 1px 2px rgba(15, 23, 42, 0.04)`): 静态面板的最低层级提示。
- **Raised Work Surface** (`0 18px 48px rgba(15, 23, 42, 0.04)`): Focus + Pulse 主工作面。
- **Popover** (`0 16px 40px rgba(15, 23, 42, 0.12)`): 菜单、对话框和移动侧栏。
- **Focus** (`0 0 0 3px rgba(147, 197, 253, 0.45)`): 键盘焦点状态。

### Named Rules

**The Border Before Shadow Rule.** 默认结构先由 1px 分隔线表达；只有工作面抬升、浮层或键盘焦点才增加阴影。

## Shapes

默认控件半径为 8px，主要工作容器为 12px，浮层可使用 12–16px。圆角矩形必须保留清晰边界，不使用模糊玻璃面。胶囊形只用于短状态标签和数量，不用于大按钮或容器。状态图标使用统一的 Lucide 线性图标，尺寸通常为 14–21px。

## Components

### Buttons

- **Shape:** 8px 圆角，默认高度 40px，紧凑高度 32px，触控环境统一至少 44px。
- **Primary:** Spark 蓝底、白字、`8px 14px`；悬停转为深蓝。
- **Secondary:** 白色工作面、强边框、muted ink；悬停时边框和文字向蓝色靠拢。
- **Ghost:** 透明背景和细边框；只在局部次要操作使用。
- **Focus / Disabled:** 键盘焦点显示共享 focus ring；disabled 使用边框灰和 disabled ink，并保留原因文本。

### Cards / Containers

- **Corner Style:** 工作容器 12px；内部不再嵌套另一张带边框卡片。
- **Background:** 画布 `#f8fafc`，工作面 `#ffffff`。
- **Shadow Strategy:** 参考 Elevation；静态列表内部使用分隔线，不给每行阴影。
- **Internal Padding:** 紧凑队列行为 12–16px，详情面板通常为 24–32px。

### Inputs / Fields

- **Style:** 白色背景、1px strong border、8px 圆角、`8px 12px`。
- **Focus:** 边框转 focus blue，并显示共享 focus ring；插入符使用 Spark 蓝。
- **Error / Disabled:** 错误与 disabled 均使用显式文字，不只改变边框颜色。

### Composer

Composer 是 Web 的首要工作面：12px 圆角的白色输入面把工作空间上下文、自由文本和提交动作组织在一个连续边界中。默认状态保持安静，输入后才让蓝色发送动作获得视觉重量；创建 Session 成功而首条消息失败时，必须保留可进入已创建 Session 的恢复入口。

### Navigation

命令栏维持 52px 高；桌面侧栏使用纵向导航，当前项以 selection mist 和蓝色文字标记。Web 的第一项是“新对话”，导航直接进入对话、会话、工作空间与设置，不增加本机服务层级。Hub 的第一组是跨 daemon 工作焦点，顶栏使用 daemon 菜单解释当前授权范围与连接状态，不提供 Workspace 身份切换。移动端使用遮罩抽屉，打开后焦点进入导航，Escape 或遮罩关闭后焦点返回触发按钮。搜索、主题和语言控件保留键盘标签与命令提示。

### Recent Conversations

最近对话使用分隔线列表而不是卡片网格。每行保持 Session 名称、工作空间、显式状态和进入动作的单一阅读顺序；等待人工介入的 Session 同时显示橙色状态文字，不能只靠色点提示。

### Attention Queue

队列固定按 `需要你 / 运行中 / 失败 / 最近完成` 排序。每行包含标题、工作空间、所属 daemon、摘要、更新时间、状态和一个安全动作；选择按钮与导航动作独立可达。选中行使用 1px 蓝色内侧线与 selection mist，并触发一次 420ms 的 Pulse Handoff；降低动态偏好时禁用动画。

### Recovery Panel

恢复面板必须说明问题、影响、投影新鲜度或连接状态，并提供最安全的修复入口；技术详情放入 disclosure。在主工作面的详情区域内采用无外框 embedded 形态，避免卡片套卡片；独立页面级恢复状态才使用弱语义底色与边框。

## Do's and Don'ts

### Do:

- **Do** 让主动作指向拥有事实的 Session、Invocation 或连接设置。
- **Do** 只在 Hub 用 daemon 表达授权与连接范围；Web 直接以工作空间组织 Session，并用 Invocation 表达一次执行。
- **Do** 在 Web 与 Hub 中复用同一状态语义、间距、焦点和恢复语法，同时让页面拓扑匹配各自任务。
- **Do** 为文本选择、插入符、滚动条、焦点环和表格数字使用共享 token。
- **Do** 在离线或投影受限时明确写出“不完整”，并区分缓存事实与实时状态。

### Don't:

- **Don't** 用计时器、转录文本或客户端乐观状态伪造运行状态。
- **Don't** 在同一层级堆叠多张带圆角和边框的容器；优先用分隔线组织信息。
- **Don't** 让状态颜色替代文字、图标或恢复说明。
- **Don't** 把 Workspace 呈现成用户身份、账号或 daemon 范围；Web 可以把“工作空间”作为项目/上下文/Session 组，但不呈现 daemon 名称、数量、选择器或连接清单。
- **Don't** 把 Web 做成缩小版 Hub，也不要把 Hub 做成放大版聊天页。
- **Don't** 在移动端隐藏范围与状态；折叠导航后仍须保留可见入口和上下文。
