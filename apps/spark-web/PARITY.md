# Spark Web capability evidence index

This index connects each replacement capability to its authoritative owner,
automated coverage, and reproducible runtime evidence. A row is complete only
when both code-owned tests and real runtime evidence exist; prose is never
completion proof.

Status meanings:

- `verified`: owner tests and the listed runtime check have passed on this branch.
- `automated`: owner tests pass; a real-browser or daemon acceptance run is still required.
- `partial`: a bounded subset is implemented and the remaining boundary is named.
- `blocked`: the required capability cannot be added without first resolving the named owner or lifecycle boundary.

| Capability | Status | Authoritative owner | Automated coverage | Runtime evidence |
| --- | --- | --- | --- | --- |
| Daemon-wide Session and Workspace-context discovery | verified | daemon session/workspace registry | `apps/spark-daemon/src/local-rpc/service.test.ts`; Web dashboard tests | Node 24 production build; isolated Chromium workspace registration and Session creation |
| Invocation list and detail | automated | daemon Invocation store and scheduler | Web dashboard/detail tests; daemon turn handler tests | Live running/cancel/retry browser journey pending |
| Session snapshot pagination and cold history | automated | daemon session store; `spark-protocol` window contract | protocol snapshot tests; daemon local RPC tests | Real long-history browser run pending |
| Transcript, attachments, media, queue removal, cancel, retry, reconnect | automated | daemon invocation/session control; `spark-ui` conversation | daemon suite; Web unit tests; `spark-ui` browser tests | Full browser journey pending |
| Markdown, code, tables, math, Mermaid, quote/source/media rendering | automated | `spark-ui` safe rendering | `spark-ui` unit/component/catalog tests | Full content fixture browser run pending |
| Full-history and global search | automated | daemon snapshot/artifact/workspace projections | `workbench` service tests; protocol controller tests | Real cold-history search pending |
| Recursive Session tree lifecycle | automated | daemon spawn/fork/archive/restore/close | daemon service tests; shared `SessionTree` tests | Full lifecycle browser run pending |
| Ask and approval recovery | automated | daemon human-wait registry | daemon human-interaction tests; shared UI tests | Refresh-with-pending-Ask run pending |
| Action Bar commands | partial | protocol action catalog and daemon owner methods | protocol action-bar tests; Web one-shot directive turn submission; Web explicit rejection paths | Plan/execute/fleet one-shot commands are wired; Goal/Loop/Repro configuration and native Plan review remain |
| Work, Tool, Task, Workflow, Jobs projections | automated | daemon Session Work projection | protocol/daemon projection tests; shared `SessionWorkPanel` tests | Live Cue Job navigation pending |
| Artifact list/read/preview | automated | `spark-artifacts` and daemon Git owner | artifact service tests; bounded preview route tests | Real GitChange/PR stack fixture pending |
| Provider API key, OAuth, logout, Pi import and model policy | automated | daemon model/auth control | daemon model-control tests; Web settings tests | Settings loaded without browser errors; live provider OAuth pending |
| Session Role/model/thinking/cwd context | automated | daemon Session control and Role catalog | daemon catalog/directory tests; Web type checks | Real Session creation passed; authenticated model run pending |
| Directory browsing and symlink confinement | automated | daemon workspace/GitChange cwd resolver | traversal, unregistered root, and symlink-escape service tests | Registered-root directory picker passed; owning worktree pending |
| Extra `--browse-root` | blocked | requires a daemon-owned launch capability | none | Web cannot safely expand the daemon's registered workspace/worktree roots without an explicit launch-time authorization contract |
| Role list/create and model list/get/set/delete; Skill list | automated | `spark-roles` stores through daemon controllers | catalog, model validation, same-name, and path-redaction tests | Real project/user precedence run pending |
| Compaction admission | partial | daemon `session.compact` | protocol/daemon idempotency, queue, failure and replay tests | Native DSH compaction needs an ownership migration that removes the current competing auto/manual implementation before mounting its state and policy |
| Plan Review | partial | daemon-parsed one-shot `/plan` directive today; DSH native Plan mode after owner migration | Web Action Bar checks | Basic plan/execute/fleet one-shot commands are wired; DSH plan state, questions projection and Ask/Approval exit gate still require a single-owner migration |
| DSH Schedule | partial | `dsh-schedule` mounted on the persistent daemon root | native create/list/delete policy and persisted `schedule/change` integration test | Change events persist; cold-resume, live on-time delivery, and the full live/cold/fork daemon matrix remain blocked on Agent lifecycle integration |
| Memory reference feedback | automated | daemon turn authority and `spark-memory` verifier | receipt replay/stale/cross-turn tests; Web ref extraction and surface compatibility tests | Real referenced-memory turn pending |
| JSONL/JSON/text/HTML export | automated | daemon revision-pinned snapshot export | protocol/service and Web streaming tests | Very long history download pending |
| Process-local read-only Share | automated | Spark Web process memory only | token, capacity, sanitation, and lifetime tests | Browser open/expiry run pending |
| PWA shell and online notifications | automated | Spark Web static shell; browser notification API | Web build/static policy tests | Manifest returned 200; install/offline/notification run pending |
| Daemon status, bounded redacted logs and restart-after-drain | automated | daemon lifecycle owner | size/redaction/restart conflict tests | Active invocation drain run pending |
| Loopback and trusted LAN boundary | automated | Spark Web gateway | Host, Origin, Fetch Metadata, daemon-user token, and CSRF tests; loopback tokenless | Loopback/trusted/invalid-host browser matrix pending |
| EN/ZH, light/dark/system, keyboard and focus | automated | Spark i18n catalogs and shared UI callbacks | catalog alignment; `svelte-check` 0 errors / 0 warnings | Chromium EN/ZH and Cmd+K passed; mobile/high-contrast/keyboard-only pending |

## Replacement gate

Do not remove `apps/spark-web-dsh`, its CLI route, build/updater inventory, or
architecture entry until every `partial` and `blocked` row required for
replacement is implemented and every pending runtime-evidence cell has a
reproducible passing run against fresh and existing daemon databases. Removal
must be a separate PR and must not delete user DSH profiles or Session data.
