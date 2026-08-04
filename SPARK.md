---
description: "spark：以 Pi SDK 为内核，统一 TUI / Cockpit / 消息平台的本地智能开发编排"
owner: zrr1999
created: 2026-05-18
updated: 2026-08-03
---

# `spark` 项目意图

## 起源

`spark` 最初作为面向 Pi 产品的工作流套件起步，通过意图明确的用户命令与规范化工具，将项目意图、任务有向无环图、结构化提问、审查、证据制品、角色执行以及 `cue-shell` 执行能力组织为可追溯的本地工作流。仓库落地后，执行与会话中枢已迁移到 Spark daemon，产品面扩展为原生 TUI、Cockpit Web 与消息通道；**Pi SDK**（`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 及与之对齐的流式/会话形状）仍是模型与终端呈现内核，独立的 Pi 产品 extension facade 已退场，兼容加载器与原生宿主共用 `spark-extension`。

## 目标

- 以 daemon 为持久会话与调用调度真源；TUI、Cockpit、消息通道、本地 RPC 共用一套 registry 与 invocation，不维护并行会话状态机。
- 以 Spark Hub 作为同一 Hub 内跨 workspace 的逻辑协调真源；Hub 持有 registry、委托状态、投递幂等、审计和有限回执，目标 daemon/workspace 始终持有执行、工具副作用与本地成果真相，Cockpit 只负责呈现和收集决策。
- 本地 daemon 控制面以 `spark-protocol` 类型化契约和 oRPC 为唯一主路径；兼容传输只翻译旧 wire，不拥有业务语义或状态。
- 以 daemon 为 `goal | loop | repro | workflow` 定时驱动的唯一自治运行时；计时、generation、重试、恢复和 fresh 隐藏执行均进入 SQLite 与现有 invocation scheduler，前端只发控制命令并展示投影。`implement` 阶段与 session TODO 延续由 `spark-extension` 的受限 `agent_end` hook 协调，每个用户输入周期至多追加一次 follow-up，不进入 daemon tick。
- 在 `spark-protocol` 中沉淀跨表面交互协议（ask 判定、slash/action catalog、session status / pending turns、可展示错误），各表面只保留呈现与执行胶水。
- 保持 Pi SDK 为内核：模型流、provider、终端 UI 原语继续建立在 `pi-ai` / `pi-tui`（经 `spark-ai` / `spark-tui` 边界）之上，不把“退场 Pi 产品”误解为剥离 SDK。
- 由 `spark-extension` 统一拥有产品 extension 组合；`package.json#pi` 仅保留指向同一实现的兼容发现元数据，不保留第二套 facade 或 `pi-coding-agent` 运行时依赖。
- 将 side conversation、worktree/change/PR/CI/review feedback 与 provider runtime 建模为可组合的领域契约：产品表面消费同一状态与反馈闭环，而不是各自维护一套按钮、轮询器或终端启发式。
- 将用户成果收敛为原子 `issue | git_change | document` Artifact：`git_change` 内聚一个 owning worktree 与一个原生 GitHub PR stack，Task 只通过耐久 `artifactRefs` 组织成果；preview 是 Document 的视图，不是独立 kind。
- 为 invocation、provider、tool、delivery 与代码交付保留隐私安全的关联观测边界；执行真相仍在 daemon/SQLite，可选 exporter 或外部观察面不得成为状态所有者。
- 将 command policy 与实际执行隔离逐步对齐，在不改变 local-first 语义的前提下，为支持平台提供显式、fail-closed 的 sandbox runner。
- 让 Spark 在没有 `.spark/` 或 `SPARK.md` 预置状态时也能默认进行轻量调查，并让 project-bound 命令在需要时从用户意图创建或恢复本地 Spark 状态。
- 用持久化的项目与任务有向无环图、类型化证据制品、结构化提问与角色执行组织可追溯工作流；`cue-shell` 能力经 `spark-cue` 复用。

## 当前包边界

- **内核（Pi SDK）**：`spark-ai`（`pi-ai`）、`spark-tui` / `spark-text`（`pi-tui`）、以及与 pi-ai 流形状对齐的 `spark-turn`。
- **执行宿主**：`spark-host` + `spark-turn` 服务 TUI / headless / daemon；`apps/spark-daemon` 拥有会话、通道与 SQLite；`apps/spark-tui` 与 `apps/spark-cockpit` 是一等产品面。
- **跨表面契约**：`spark-protocol`（含 ask 语义、action-bar、session view、human-interaction 生命周期）；`spark-core`（由 `spark-extension-api` 重命名）是 Spark 宿主契约 + 轻量 primitives（`SparkHostAPI` 类型与依赖极轻的 helpers），不是复活已退场的能力袋 `spark-core`。
- **能力包**：`spark-ask`、`spark-artifacts`、`spark-tasks`、`spark-roles`、`spark-cue`、`spark-channels`、`spark-cockpit-coordination` 等；工具表面使用规范化 `tool({ action })`。
- **产品 extension 组合根**：`packages/spark-extension` 为原生与结构兼容宿主注册 command/tool/policy；历史 `pi-extension` workspace 已退场。根 `"pi": { "extensions": ... }` 只让兼容加载器发现同一 Spark 实现，不形成第二套能力或状态 owner。

已退场的工作区包包括历史能力袋 `spark-core`（与现 `@zendev-lab/spark-core` 无关）、`spark-goal`、`spark-learnings` 与 `spark-recall`。`spark-tasks`、`spark-workflows` 仍是当前包；learning / recall / reflection 由 `spark-memory` 拥有。`pi-* -> spark-*` 反向依赖由边界检查守门。`.spark/` 磁盘格式不因包名迁移而改名（reflection 落盘路径统一到 `.spark/memory/reflections/` 除外）。

## 非目标

- 不将本仓库泛化为公开模板或通用项目管理产品。
- 不剥离或重写 Pi SDK 内核去“去 Pi 化”；退场对象是 Pi **产品**宿主，不是 `pi-ai` / `pi-tui`。
- 不为兼容加载器新增独立能力；不重新建立双重 extension 实现或公开工具表面。
- 不把 TUI 进程内 follow-up 队列与 daemon `pendingTurns` 盲目合并成单一数组；采用双层模型：daemon `pendingTurns` 是跨表面耐久真相，TUI `queuedFollowUps` 只保留未 ack 的乐观 steer/followUp（合并、编辑器恢复），ack 后以 daemon 投影为准。
- 不把 Cockpit 专用 notice/error part 未经设计提升进协议。
- 不复制 OpenSpec/OpenArc 的完整文件树或重型流程。
- 不让结构化提问成为用户必须直接操作的独立产品面。
- 不因外部产品的功能表扩张 Spark；只采纳能进入现有 owner 边界、且有本地证据支持的机制。
- 不引入独立 Workstream aggregate，不在 Spark 内复制可写 PR 拓扑；`gh stack` 是 GitHub stack 的唯一可写 topology authority。
- 不用 Temporal、Restate、Inngest 等外部 durable engine 替换当前 daemon/SQLite 调度真相；只有隔离实验能证明本地 step journal 无法满足需求时才重新评估。
- 不实现 root 跨 Unix 用户 supervisor；多用户部署采用每个 Unix 用户独立运行一个 Spark daemon。
- Hub v1 不实现 `WorkspaceLink`、Artifact 复制/导入、直接控制目标 session 或跨 Hub Federation；同 Hub 默认互信只授予路由能力，目标主 session 仍可追问或拒绝。

## 成功信号

- 同一 ask 的“算不算有效回答 / gate 是否满足”在 TUI、Cockpit、通道结算路径上共用 `spark-protocol` 语义，表面只做 UI。
- Slash / action catalog 继续以协议为源；Cockpit 与 TUI 只做 i18n 与执行。
- 新功能默认可在 TUI 或 Cockpit 验证，消息通道按 channel policy 收窄；无需先在 Pi 产品里跑通。
- 兼容加载路径只指向 `spark-extension`：无第二个 facade package、无新 `"pi.extensions"` 扩张；文档与边界检查区分 SDK 内核与兼容发现元数据。宿主契约公开名为 `SparkHostAPI`（`spark-core`）；ask/tasks/context 注册入口为 `registerSpark*`。
- Spark 原生 TUI 与 Cockpit 通过同一 daemon controller 运行只读 Side Thread、恢复隔离历史并将全文或紧凑摘要显式 handoff 回主会话；TUI 使用单一 `/btw` 命令，Cockpit 提供同一组 ensure、ask、reset、model、thinking 与 handoff 操作，两个表面都不加载 `pi-coding-agent`。
- 用户可从 npm 安装单一 `@zendev-lab/spark` 产品包并获得 `spark` 命令；发布物只包含编译后的 JavaScript、声明过的运行时依赖以及 daemon migrations、TUI 和 Cockpit 资产，不暴露内部 workspace 包图。
- CI failure、review comment 与 merge conflict 能以幂等反馈事件回到创建该 change/PR 的原 session，并带可审查 evidence，而不是要求用户手工复制终端输出。
- 用户能以一个 `git_change` Artifact 查看、提交、同步并保守清理一个完整 PR stack；默认创建 draft PR，不产生重复进度评论或“stacked/tested”样板文本。
- Project-bound 命令、任务图、ask、roles、cue 的既有成功信号仍成立，并通过测试与 `vp check` / `prek` 守门。
- 每个活跃 workspace 都有唯一、重启稳定且禁止普通归档的 `workspace_main` session；跨 workspace 文本以不可信外部输入进入目标主 session，只有结构化 `delegation({ action })` 事件能推进委托状态。
- 两个同 Hub workspace 可完成 create → delivery → ask/reply → complete/reject/cancel 闭环；离线恢复复用原消息幂等键，最多四跳且拒绝 workspace 循环，回执仅公开目标 `artifact:` refs 与有限验证摘要。

## 当前开放问题

- 完成证据门禁应严格到什么程度：对人工任务、审查/设计任务和角色执行/工作流任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、每日记忆或 Git 历史中恢复。

## 近期收尾任务

- 继续对齐跨表面 ask / gate / submit 语义；Cockpit 已改用协议 option `value` 与 `parseSparkAskChoice`。
- 文档与 AGENTS 边界语言已统一为“Pi SDK 内核 + 单一 `spark-extension` 组合根”。
- 历史 `pi-extension` workspace 已并入 `spark-extension`；`"pi.extensions"` 兼容元数据只允许指向现有 Spark entries。
- Spark 原生 Side Thread 已通过隔离的真实 TUI/Zellij 验收：提交与繁忙并行拒绝、daemon 重启恢复、model/thinking 配置、全文和摘要 handoff 均由真实 daemon invocation 验证。Cockpit 使用同一 daemon controller 提供完整 BTW 操作；旧 `pi-btw` 包、skill 与 Pi discovery 已删除。
- 以 `pnpm run check` 的 architecture ratchet 守住工作区数量、生产文件体量和冻结 Pi manifest；前期 ceiling 保留适度扩展余量，但新增 workspace 仍须证明稳定依赖边界。先通过 `pnpm run report:hygiene` 分类 Knip/jscpd/complexity 的动态入口误报，再把稳定基线升级为非增长门禁。
- Spark v0.1 通过生成的自包含 `@zendev-lab/spark` 产物发布 npm；源码 workspace 保持 private，完整 check 校验公开产品与内部 owner 分类，`pnpm run smoke` 在仓库外安装 tarball 并验证 dispatcher、TUI、daemon migrations/lifecycle 与 Cockpit health。
- 本地 RPC 分两阶段收敛：0.1.x 将一方调用迁到统一 oRPC client，`daemon.sock` 只服务已发布的 N-1 客户端且不再承接新行为；仅在迁移版已发布、双向跨版本 IPC、精确 tarball smoke 与 updater/rollback 门禁通过后，0.2 才删除 legacy socket/client/adapter。
- 将现有 PR/CI 读取能力收敛成 change delivery feedback 事件，先完成“失败反馈回原 session”，再考虑 GitHub Checks 回写。
- Artifact v2 已收敛到 `issue | git_change | document`；旧 `pr`/`preview` 记录仅在读取时保持同 ref 懒归一化。`git({ action })` 管理 worktree/stack 生命周期，Task 通过 `artifactRefs` 幂等链接成果。
- `spark-files` 默认只注册 `read | write | edit | grep | find`，保留版本/SHA/LINE#HASH/CAS/原子写语义；`artifactRef` 可把相对路径路由到 `git_change` worktree。外部 Pi 兼容入口经 typed daemon RPC 执行，且只允许分发前自动启动并重试一次。
- 会话队列双层收敛：TUI 乐观层 ↔ daemon `pendingTurns` 真相；Cockpit 继续只投影 daemon。
- 自治 driver 的后续运维工作包括 systemd 安装、自检/doctor、更新、外部服务托管、profile 导入与日志保留；这些能力不得形成第二个运行时 owner。
- `memory` owns durable scoped memory, recall candidates (`recall` tool), the `LearningStore` / `learning` tool, and reflection pipelines (`.spark/memory/reflections/`).
- Hub v1 先留在现有 `spark-cockpit-coordination` / `spark-cockpit-db` owner 内：完成逻辑 Hub CLI、workspace 主 session、委托协议/状态机/outbox、Cockpit 委托视图和旧 Cockpit CLI 迁移提示；物理 package/数据库目录改名作为独立迁移。
