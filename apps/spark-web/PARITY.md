# Spark Web capability evidence index

This index connects each replacement capability to its authoritative owner,
automated coverage, and reproducible runtime evidence. A row is complete only
when both code-owned tests and real runtime evidence exist; prose is never
completion proof.

Status meanings:

- `verified`: owner tests and the listed runtime check have passed on this branch.
- `automated`: owner tests pass; a real-browser or daemon acceptance run is still required.
- `partial`: a bounded subset is implemented and the remaining boundary is named.
- `blocked`: the current dependency baseline does not expose the required owner capability.

| Capability | Status | Authoritative owner | Automated coverage | Runtime evidence |
| --- | --- | --- | --- | --- |
| Workspace and Session discovery | verified | daemon workspace/session registry | `apps/spark-daemon/src/local-rpc/service.test.ts`; Web server loads | Node 24 production build; isolated Chromium workspace registration and Session creation |
| Session snapshot pagination and cold history | automated | daemon session store; `spark-protocol` window contract | protocol snapshot tests; daemon local RPC tests | Real long-history browser run pending |
| Transcript, attachments, media, queue removal, cancel, retry, reconnect | automated | daemon invocation/session control; `spark-ui` conversation | daemon suite; Web unit tests; `spark-ui` browser tests | Full browser journey pending |
| Markdown, code, tables, math, Mermaid, quote/source/media rendering | automated | `spark-ui` safe rendering | `spark-ui` unit/component/catalog tests | Full content fixture browser run pending |
| Full-history and global search | automated | daemon snapshot/artifact/workspace projections | `workbench` service tests; protocol controller tests | Real cold-history search pending |
| Recursive Session tree lifecycle | automated | daemon spawn/fork/archive/restore/close | daemon service tests; shared `SessionTree` tests | Full lifecycle browser run pending |
| Ask and approval recovery | automated | daemon human-wait registry | daemon human-interaction tests; shared UI tests | Refresh-with-pending-Ask run pending |
| Action Bar commands | partial | protocol action catalog and daemon owner methods | protocol action-bar tests; Web explicit rejection paths | Goal/Loop/Repro configuration and rc.8 Plan/Fleet remain |
| Work, Tool, Task, Workflow, Jobs projections | automated | daemon Session Work projection | protocol/daemon projection tests; shared `SessionWorkPanel` tests | Live Cue Job navigation pending |
| Artifact list/read/preview | automated | `spark-artifacts` and daemon Git owner | artifact service tests; bounded preview route tests | Real GitChange/PR stack fixture pending |
| Provider API key, OAuth, logout, Pi import and model policy | automated | daemon model/auth control | daemon model-control tests; Web settings tests | Settings loaded without browser errors; live provider OAuth pending |
| Session Role/model/thinking/cwd context | automated | daemon Session control and Role catalog | daemon catalog/directory tests; Web type checks | Real Session creation passed; authenticated model run pending |
| Directory browsing and symlink confinement | automated | daemon workspace/GitChange cwd resolver | traversal, unregistered root, and symlink-escape service tests | Registered-root directory picker passed; owning worktree pending |
| Extra `--browse-root` | blocked | requires a daemon-owned launch capability | none | Web cannot safely authorize an extra daemon root on the current baseline |
| Role list/get/create and model list/get/set/delete; Skill list/get | automated | `spark-roles` stores through daemon controllers | catalog, model validation, same-name, and path-redaction tests | Real project/user precedence run pending |
| Compaction admission | partial | daemon `session.compact` | protocol/daemon idempotency tests | Native DSH compaction state/result needs rc.8 |
| Plan Review | blocked | DSH native Plan mode through Spark Ask/Approval | none | DSH rc.8 daemon-root adapter is absent |
| DSH Schedule | blocked | DSH native schedule owner | none | DSH rc.8 daemon-root adapter is absent |
| Memory reference feedback | automated | daemon turn authority and `spark-memory` verifier | receipt replay/stale/cross-turn tests; Web ref extraction and surface compatibility tests | Real referenced-memory turn pending |
| JSONL/JSON/text/HTML export | automated | daemon revision-pinned snapshot export | protocol/service and Web streaming tests | Very long history download pending |
| Process-local read-only Share | automated | Spark Web process memory only | token, capacity, sanitation, and lifetime tests | Browser open/expiry run pending |
| PWA shell and online notifications | automated | Spark Web static shell; browser notification API | Web build/static policy tests | Manifest returned 200; install/offline/notification run pending |
| Daemon status, bounded redacted logs and restart-after-drain | automated | daemon lifecycle owner | size/redaction/restart conflict tests | Active invocation drain run pending |
| Loopback and trusted LAN boundary | automated | Spark Web gateway | Host, Origin, Fetch Metadata, token, and CSRF tests | Loopback/trusted/invalid-host browser matrix pending |
| EN/ZH, light/dark/system, keyboard and focus | automated | Spark i18n catalogs and shared UI callbacks | catalog alignment; `svelte-check` 0 errors / 0 warnings | Chromium EN/ZH and Cmd+K passed; mobile/high-contrast/keyboard-only pending |

## Replacement gate

Do not remove `apps/spark-web-dsh`, its CLI route, build/updater inventory, or
architecture entry until every `partial` and `blocked` row required for
replacement is implemented and every pending runtime-evidence cell has a
reproducible passing run against fresh and existing daemon databases. Removal
must be a separate PR and must not delete user DSH profiles or Session data.
