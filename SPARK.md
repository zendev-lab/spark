---
description: "spark：以 Pi SDK 为内核，统一本地 Web / Hub / 消息平台的本地智能开发编排"
owner: zrr1999
created: 2026-05-18
updated: 2026-08-30
---

## 起源

`spark` 最初作为面向 Pi 产品的工作流套件起步，通过意图明确的用户命令与规范化工具，将项目意图、任务有向无环图、结构化提问、审查、证据制品、角色执行以及 `Cue` 执行能力组织为可追溯的本地工作流。仓库落地后，执行与会话中枢已迁移到 Spark daemon，产品面扩展为本地 Web 工作台、Hub 与消息通道。**Pi SDK** 中仅保留 `@earendil-works/pi-ai` 作为 `spark-llm-providers` 的模型 transport 内核；独立的 Pi 产品 extension facade、`pi-spark` 发现适配器、`pi-tui` 与原生 TUI 均已退场。产品组合由 daemon 内部模块唯一拥有。

## 目标

- 以 daemon 为 Session registry、scope/lineage 派生生命周期、关闭级联与 Invocation 调度真源；workspace-bound 与 daemon-global Session root 共用一套状态机，本地 Web、Hub、消息通道、本地 RPC 不维护并行会话状态。
- 将 Role 固定为静态行为/能力定义，Session 固定为执行上下文，Invocation 固定为一次执行；公开流程统一为创建 Role → `session spawn|fork` 创建 Role-bound Session → `session send(kind=request)` 触发 Invocation，三个阶段互不隐式代办。
- Session Owner 只表达生命周期与资源归属，不表达 Role 能力或子 Session 创建授权；Registry 只持久化严格 state，`lifetime` 与 `activity` 分别由 Owner 和 Invocation 真相投影。
- 以 Spark Hub 作为同一 Hub 内跨 workspace 的逻辑协调真源；Hub 持有 registry、委托状态、投递幂等、审计和有限回执，目标 daemon/workspace 始终持有执行、工具副作用与本地成果真相，Hub 只负责呈现和收集决策。
- 本地 daemon 控制面以 `spark-protocol` 类型化契约和 oRPC 为唯一主路径；兼容传输只翻译旧 wire，不拥有业务语义或状态。
- 以 daemon 为 `goal | loop | repro | workflow` 定时驱动的唯一自治运行时；计时、generation、重试、恢复和 fresh 隐藏执行均进入 SQLite 与现有 invocation scheduler，前端只发控制命令并展示投影。session TODO 延续由 daemon 内部产品组合的受限 `agent_end` hook 协调，每个用户输入周期至多追加一次 follow-up，不进入 daemon tick。
- `/plan`、`/execute`、`/fleet` 是 daemon 在 turn 提交通道上解析的一次性命令：仅向当前 Invocation 注入工作意图指导，不改变工具集合、sandbox、审批、授权或 admission，不持久化，普通下一轮恢复中性。持久 Session mode 已整体废除；fleet 协调复用现有 TaskGraph、TaskRun、资源调度器与 Session Registry，worker 只消费 Task 已关联的 `git_change` worktree，不新增 Fleet store 或调度器。
- 在 `spark-protocol` 中沉淀跨表面交互协议（ask 判定、slash/action catalog、session status / pending turns、可展示错误），各表面只保留呈现与执行胶水。
- 让 `spark web` 成为以 daemon-wide Session tree / active Invocation 为首页的默认本地浏览器产品，Workspace 只作为执行上下文、分组与过滤信息；`spark web-dsh` 保留为独立 DSH-hosted fallback，默认进入托管的 Cue-first `spark-standard` mode 并提供 PTC Mode 的 `spark-ptc`；受支持 DSH release 在 boot 时把 preset 发现 root 固定为内置 root，因此 stock preset 仍由 DSH 自身挂载，独占发现有待 DSH 支持可配置 roots。
- 保持 Pi SDK 为 transport 内核：provider 实现继续建立在 `pi-ai` 之上（经 `spark-llm-providers` 边界）。LLM *abstraction* 收敛到 `dsh-llm` 的 `LlmRuntime`；不把“退场 Pi 产品”误解为剥离 SDK。
- 由 daemon 内部产品模块静态组合 Spark 策略与受支持的 DSH/Cordis 插件；不新增 `spark-base`、Spark extension 发现路径或 Spark-owned `package.json#pi`。
- 将 side conversation、worktree/change/PR/CI/review feedback 与 provider runtime 建模为可组合的领域契约：产品表面消费同一状态与反馈闭环，而不是各自维护一套按钮、轮询器或终端启发式。
- 将用户成果收敛为原子 `issue | git_change | document` Artifact：`git_change` 内聚一个 owning worktree 与一个原生 GitHub PR stack，Task 只通过耐久 `artifactRefs` 组织成果；preview 是 Document 的视图，不是独立 kind。
- 为 invocation、provider、tool、delivery 与代码交付保留隐私安全的关联观测边界；执行真相仍在 daemon/SQLite，可选 exporter 或外部观察面不得成为状态所有者。
- 将 command policy 与实际执行隔离逐步对齐，在不改变 local-first 语义的前提下，为支持平台提供显式、fail-closed 的 sandbox runner。
- 让 Spark 在没有 `.spark/` 或 `SPARK.md` 预置状态时也能默认进行轻量调查，并让 project-bound 命令在需要时从用户意图创建或恢复本地 Spark 状态。
- 用持久化的项目与任务有向无环图、类型化证据制品、结构化提问与角色执行组织可追溯工作流；`Cue` 能力经 Cordis `dsh-cue` service 复用。

## 架构方向

精确的包清单、层级、owner、稳定性和依赖方向以
[`architecture/packages.json`](./architecture/packages.json) 为准；包创建、合并与依赖
规则由 [`.agents/notes/contracts/package-architecture.md`](./.agents/notes/contracts/package-architecture.md) 约束。

- Pi SDK 仅保留 `pi-ai` 作为模型 transport 内核，由 `spark-llm-providers` 拥有；Spark 不重建独立的 Pi 产品 facade，也不再提供 `package.json#pi` 发现路径。LLM abstraction 由 `dsh-llm` 拥有；`spark-llm-providers` 只作为 provider / `LlmAdapter` 实现族。Cordis 是 daemon 根、`dsh-llm` 小岛与 daemon 内部 agent runtime 的 process-local 组合运行时，不是 Spark Session；详见 [Cordis 生命周期决策](.agents/notes/decisions/2026-08-20-dsh-cordis-composition.md)与 [daemon 产品组合决策](.agents/notes/decisions/2026-08-21-daemon-product-composition.md)。
- daemon 是持久会话、调用、通道、本地执行、自治计时、重试与恢复的唯一 owner。
- `@zendev-lab/dsh-channel-transports` 是 daemon root 内的 Cordis transport/lifecycle 插件；Channel Session 是无需 Workspace 的 daemon-scoped root，私有 cwd 位于 daemon data root。Cordis 不接管 Registry、Invocation、outbox、retry、human wait 或 SQLite 权威；详见 [`.agents/notes/decisions/2026-08-21-daemon-global-channel-sessions.md`](.agents/notes/decisions/2026-08-21-daemon-global-channel-sessions.md)。
- 跨表面 schema 与语义进入 `spark-protocol`，传输层只校验和翻译。
- `apps/spark-daemon/src/product` 是唯一产品组合实现；daemon workspace 是唯一组合根。

## 非目标

- 不将本仓库泛化为公开模板或通用项目管理产品。
- 不剥离或重写 Pi SDK 内核去“去 Pi 化”；退场对象是 Pi **产品**宿主，不是 `pi-ai`。`pi-tui` 已随 TUI 退场，不得重新引入。
- 不为兼容加载器新增独立能力；不重新建立双重 extension 实现、`package.json#pi` 发现路径或公开工具表面。
- 不把浏览器进程内乐观队列与 daemon `pendingTurns` 盲目合并成单一数组；daemon `pendingTurns` 是跨表面耐久真相，表面队列只保留未 ack 的乐观 steer/followUp，ack 后以 daemon 投影为准。
- 不把 Hub 专用 notice/error part 未经设计提升进协议。
- 不复制 OpenSpec/OpenArc 的完整文件树或重型流程。
- 不让结构化提问成为用户必须直接操作的独立产品面。
- 不因外部产品的功能表扩张 Spark；只采纳能进入现有 owner 边界、且有本地证据支持的机制。
- 不引入独立 Workstream aggregate，不在 Spark 内复制可写 PR 拓扑；`gh stack` 是 GitHub stack 的唯一可写 topology authority。
- 不用 Temporal、Restate、Inngest 等外部 durable engine 替换当前 daemon/SQLite 调度真相；只有隔离实验能证明本地 step journal 无法满足需求时才重新评估。
- 不实现 root 跨 Unix 用户 supervisor；多用户部署采用每个 Unix 用户独立运行一个 Spark daemon。
- Hub v1 不实现 `WorkspaceLink`、Artifact 复制/导入、直接控制目标 session 或跨 Hub Federation；同 Hub 默认互信只授予路由能力，目标 Administrator Session 仍可追问或拒绝。

## 成功信号

- 同一 ask 的“算不算有效回答 / gate 是否满足”在本地 Web、Hub、通道结算路径上共用 `spark-protocol` 语义，表面只做 UI。
- Slash / action catalog 继续以协议为源；Hub 与本地 Web 只做 i18n 与执行。
- 新功能默认可在本地 Web 或 Hub 验证，消息通道按 channel policy 收窄；无需先在 Pi 产品里跑通。
- 无 Spark-owned `package.json#pi` 发现路径，无 Pi 产品兼容适配器，无第二套产品 composition。文档与边界检查区分 SDK 内核（`pi-ai` via 当前 `spark-llm-providers`）与已退场的 Pi 产品宿主；通用 `SparkHostAPI` 完成拆分后，剩余 Invocation 契约原位收敛为 `spark-invocation`。
- 本地 Web 与 Hub 通过同一 daemon controller 运行只读 Side Thread、恢复隔离历史并将全文或紧凑摘要显式 handoff 回主会话；两个表面都不加载 `pi-coding-agent`。
- 用户可从 npm 安装单一 `@zendev-lab/spark` 产品包并获得 `spark` 命令；发布物只包含编译后的 JavaScript、声明过的运行时依赖以及 daemon migrations、本地 Web 和 Hub 资产，不暴露内部 workspace 包图。
- CI failure、review comment 与 merge conflict 能以幂等反馈事件回到创建该 change/PR 的原 session，并带可审查 evidence，而不是要求用户手工复制终端输出。
- 用户能以一个 `git_change` Artifact 查看、提交、同步并保守清理一个完整 PR stack；默认创建 draft PR，不产生重复进度评论或“stacked/tested”样板文本。
- Project-bound 命令、任务图、ask、roles、cue 的既有成功信号仍成立，并通过测试与 `vp check` / `prek` 守门。
- `/fleet` 在本地 Web 与 Hub 使用同一协议目录；同 lane Task 串行复用 scoped worker Session，`fresh` 明确逃生，多 worktree 写授权与 completion reconcile 均由 daemon fail-closed 执行。
- 每个 Workspace 都能幂等补建唯一、重启稳定的 persistent Administrator Session；它禁止 archive/close/delete/retention，Hub 独立置顶且默认选中。跨 Workspace 文本以不可信外部输入进入目标 Administrator，只有结构化 `delegation({ action })` 事件能推进委托状态。
- builtin Role 只有 `administrator | explorer | executor | reviewer`；Administrator 的实际工具策略禁止 write/exec/net，Explorer/Reviewer 只有 read/net 且没有 exec，Role revision 在 Invocation 开始时冻结。
- registry v6、daemon SQLite、Task/Workflow/Repro、Role model settings 与 Evidence 的结构化 RoleRef 能在 daemon admission 前完成有备份、journal、校验与恢复入口的硬切迁移；EvidenceRef 保持稳定，正文 hash 重算，自由文本与 transcript 不改写。
- 两个同 Hub workspace 可完成 create → delivery → ask/reply → complete/reject/cancel 闭环；离线恢复复用原消息幂等键，最多四跳且拒绝 workspace 循环，回执仅公开目标 `artifact:` refs 与有限验证摘要。
- 不注册任何 Workspace 的 daemon 也能完成 Channel ingress → Session → Invocation → reply；两个账号使用同一 external key 时解析到不同 daemon Channel Session 与私有 cwd，Hub 不把它们混入 Workspace tree。

## 当前开放问题

- 完成证据门禁应严格到什么程度：对人工任务、审查/设计任务和角色执行/工作流任务是否采用不同要求。
- 历史任务中被完成摘要覆盖的原始意图是否需要进一步从聊天记录、每日记忆或 Git 历史中恢复。

## 当前方向

- [Web 替代与包规范化决策](.agents/notes/decisions/2026-08-23-web-replacement-and-package-normalization.md) 已完成源码拓扑硬切：native Web 使用 daemon-wide Session / Invocation 主路径，Web DSH 保持独立 fallback；owner 命名已经归一，过渡 facade 已并入 daemon product composition，持久 Session mode 已废除为一次性 `/plan`/`/execute`/`/fleet` 命令，不保留别名包。
- 公共 CLI argv 只使用 Optique 作为解析器。
- 对齐跨表面的 ask、gate 与 submit 语义，让协议成为唯一判定来源。
- 为本地 RPC 兼容层定义可验证的退出条件，不向兼容传输增加新行为。
- 将 PR、CI、review 与 conflict 读取收敛成幂等 delivery feedback 事件。
- 完善自治 driver 的部署、诊断、更新与日志运维，但不形成第二个运行时 owner。
- Hub 能力继续留在现有 owner 中，直到独立迁移能证明新的硬边界。
- Pi 产品兼容适配器 `pi-spark` 已退场；`package.json#pi` owner 为空。
  `spark-web-dsh` 作为独立的 DSH-hosted Spark 产品应用保留；新增 workspace
  必须更新 `architecture/packages.json` 并说明新的硬边界。
- DSH 组合已越过 LLM 小岛：daemon Cordis root 一次挂 Spark store、Session
  persistence、attachment、LLM、SystemPrompt、ToolRuntime、AgentRegistry 与
  AgentLoop。transcript v4 已把模型可见内容迁入原生 DSH surface，并在 daemon
  admission 前完成带备份和 journal 的 v3 硬切；Invocation 已在共享 root 上按
  Session ID create/resume Agent，flush 后释放 handle，并用 Invocation 隔离的
  provider route 避免共享 registry 冲突。daemon 的既有 ExecutionAttempt 是唯一
  attempt owner；`ctx.sparkInvocation` 以不可变 Cordis service 暴露
  `Invocation → Attempt → Turn` 关联，同一 attempt 只能保留一个 Turn。该关联只由
  daemon attempt store 与 epoch fence 持久化；新 DSH log 不再写重复的
  `spark/invocation` 事件，旧的可忽略事件仍可读取。模型/tool 驱动、投影与 host facade
  已收回 daemon 内部 product composition。`spark-driver` 仍拥有 goal/tick；不接入
  `dsh-llm-pi-ai` 或 `dsh-goal`。Invocation / channel / fleet / retry 数据权威仍是
  Spark SQLite。
- 会话 transcript 已切到 DSH session JSONL；Spark 只实现 `PersistenceBackend`。
  Session 投影仍由 Spark 拥有，不采用 `dsh-session-projection`；模型可见消息不再
  双写 `spark/record`，Spark 扩展事件只保留投影元数据、非模型记录和非活跃分支。
- Channel 已原位迁移为 `dsh-channels` Cordis 插件；配置、Session、cwd、delivery、
  human wait 与控制面均为 daemon scope。旧 Workspace Channel 只保留一次性、
  fail-closed 的 v7→v8 数据迁移，不保留新行为兼容层。
- **Hub 以 daemon 为绑定单位**：同一台机器一个 daemon，其上的 workspace（概念保留）归属该 daemon。workspace 身份在 daemon 本地持有，Hub 投影由 daemon 登录/上行链路调度；hub UI 层 workspace 与 daemon 统一呈现（workspace 作为会话的组织容器），console 导航不再单列 daemon 组。
- Goal/Loop/Repro 的 `manual_only` 旁路需要 Session 级 `driverAuthority`：交互
  启动 ask 一次，CLI/API/daemon tick 静默授予；拒绝则退化为逐工具批准。绑定本身
  不是同意。
- DSH Phase 2 已通过 `@zendev-lab/dsh-cue` service 与私有
  `@zendev-lab/dsh-tool-cue` adapter 接入 SystemPrompt + Tools：`dsh-cue`
  仍唯一拥有 Cue 语义，DSH
  只适配受支持 DSH release 的 host ABI、权限和 presenter；当前
  `spark-standard` / `spark-ptc` 用 Cue 取代 DSH Bash/Pwsh/Jobs，两个 preset 组合
  作为静态文件随 `@zendev-lab/spark-web-dsh` 版本化，启动时幂等安装进 DSH 用户
  preset root，并清理未被用户改过的 `spark-code` 遗留目录。两个托管 preset 的文本文件工具由
  `spark-files/dsh` 通过 DSH `ctx.fs` 提供显式版本 CAS 和逐调用沙箱策略；官方
  `read_image` 与 `dsh-tool-fs-search` 保留。
- DSH 包命名以依赖闭包区分 owner 与 consumer：本地 `dsh-*` 必须可脱离 Spark
  运行且通过 real-host smoke，通用模型工具通常命名为 `dsh-tool-*`；`spark-*`
  承载 Spark 产品状态、策略、daemon/protocol 或专用 provider。`spark-web-dsh`
  与 `spark-acp` 保持产品 owner；Web 工具已迁入 Cordis-native `dsh-tool-web`，
  使用官方 `ctx.web` provider seam，只保留 Agent 生命周期内的有界内存恢复缓存，并删除 `code_search` 与旧
  `fetch_content` 名称。`spark-fusion` 同样已改名为 `dsh-tool-fusion`，旧
  SparkHostAPI bridge 已删除；官方 `dsh-acp` 尚无 daemon durable admission seam，
  因此 `spark-acp` 暂不替换。完整处置见
  [DSH Web 决策](.agents/notes/decisions/2026-08-25-dsh-tool-web.md)。
- 产品 subagent 是 Role-bound 子 Session：官方 `@deepseek-ai/dsh-subagent`
  作为 HOST（`ctx.subagents`），`spark-session` 注册 spawn/fork provider。
  daemon 挂官方 HOST 再挂 session 插件（host → `createManagedChildSession`）；
  spark-web-dsh 插入同一插件并关掉 stock in-process spawn/fork。不重写
  `ctx.subagents`，不新增 `dsh-spark` 包。compaction 与 jobs 仍是后续 owner
  决策。
