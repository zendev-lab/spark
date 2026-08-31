---
title: Spark feature map
description: See every Spark capability by product surface, state owner, and user intent instead of by slash-command count.
---

Spark is easier to learn when features are grouped by what you want to
accomplish. Slash commands and agent tools are controls inside these
capabilities, not the product taxonomy.

## 0. Product surfaces and distribution

| You use | What it is for | State owner |
| --- | --- | --- |
| `spark` CLI | Install, dispatch, script, diagnose, and open another surface | Dispatcher only |
| Local web | Describe work, steer one session, and inspect its local projection | Browser presentation |
| Daemon | Keep sessions and work running after a frontend disconnects | Execution truth |
| Hub | Supervise workspaces and conversations from the browser | Web presentation and coordination |
| ACP | Connect compatible editor clients to daemon-owned sessions | Adapter only |
| Updater | Install, upgrade, roll back, and report build identity | Installed version |

The complete installation meta package is `@zendev-lab/spark`; it pins the
lockstep packages but contains no dispatcher implementation.
`@zendev-lab/spark-cli` owns the real `spark` command. Daemon, Hub, and local web are
also independently installable app packages. Other source workspaces are private
implementation boundaries rather than supported products. See
[surfaces and ownership](/concepts/surfaces/) and the [CLI reference](/reference/cli/).

For contributors, the source topology stays compact by family:

| Source family | Responsibility |
| --- | --- |
| `apps/spark-cli`, `spark-daemon`, `apps/spark-web`, `apps/spark-hub` | Executable dispatcher and presentation/runtime hosts |
| `apps/spark-daemon/src/product`, `spark-daemon-client` | Daemon-internal product composition and the shared daemon client boundary |
| Capability/runtime `packages/spark-*` | Files, Web, tasks, artifacts, memory, workflows, roles, sessions, and other reusable behavior |
| `spark-protocol`, `spark-invocation`, `spark-task-runtime`, `spark-platform-node`, `spark-text-rendering` | Cross-surface contracts and dependency-light foundations |
| `packages/spark-hub-*` | Hub-private database, coordination, and localization implementation |

Contributors can inspect `.agents/notes/contracts/package-architecture.md` for dependency
rules and `architecture/packages.json` for the exhaustive owner/stability
inventory. Ordinary users do not need to learn individual workspace packages.

## 1. Core runtime: one daemon

The daemon owns durable sessions, queued and running work, event streams,
recovery, workspace binding, channel listeners, and autonomous continuation.
Foreground runs, background submissions, local web prompts, and Hub Web messages all
reach this same execution owner.

Use `spark doctor` and `spark daemon status --json` for health. Use
[runs and sessions](/guides/runs-and-sessions/) for foreground, background,
attach, resume, and cancellation.

## 2. Interactive design: Hub Web and local web

- Use the [local web workbench](/guides/web/) for fast local conversation,
  steering, and the current session inspector.
- Use [Hub Web](/guides/hub/) for workspace overview, conversations,
  Inbox, artifacts, resources, and cross-daemon supervision.
- Use the CLI when you already know the operation and want a scriptable result.

The workbench session page is local to the current session. `spark hub`
opens the separate browser control surface.

## 3. Base agent tools

Spark supplies tools for files, search, shell and scripts, tasks, artifacts,
questions, memory and context, models, roles, sessions, workflows, and durable
loops. Users normally describe the desired outcome; the agent selects tools
and asks for approval when policy requires it.

See the [tool activation and permission model](/reference/tools/).

## 4. Tasks and autonomous progress

Ordinary project work follows:

```text
Project → Task plan → claim or assign → Run → Artifact → Review
```

`/plan` creates verifiable work without implementing it. `/execute` continues
through ready tasks until complete, blocked, validation fails, or a decision is
needed. `/fleet` coordinates a safe, target-disjoint ready frontier through
reusable daemon worker Sessions without letting the owner edit code directly.
Goal, Loop, Repro, and Workflow add daemon-owned continuation for work
that must persist or repeat. `/automate` is only a picker for those existing
continuation owners.

Repro owns three stable child Sessions: Implementation, Exactness, and
Formalize. The daemon advances their fixed five-checkpoint chain, and only
Formalize can set `formalizedRevision`. Goal remains a separate
TaskGraph-derived runtime projection.

Start with [plan and implement](/guides/plan-and-execute/), then read
[long-running automation](/guides/automation/).

## 5. Channels and multi-session collaboration

Spark has one runtime conversation entity: Session. Roles are reusable
static definitions bound onto a Session at runtime. subsession means any
Session with child lineage; a child with an explicit Role bind is a
subagent. The human operator is not a Role. Official DSH `subagent` tools
map onto `session spawn|fork` plus `session send`. The Side Thread
feature creates a read-only child Session. Feishu, Infoflow, and QQ Bot
conversations resolve to daemon-global root Channel Sessions without requiring
a Workspace or creating another execution owner. Sessions can send requests or
notifications and receive completion summaries through their Inbox.
Daemon-backed subagents select only from the Agent's creation-time
`enabledModels` snapshot; the daemon revalidates and freezes their route,
reasoning level, and output ceiling before admission.

See [collaboration](/guides/collaboration/), [daemon-global Channels](/guides/channels/),
and [Side Threads](/guides/side-threads/).

## 6. Models, context, capabilities, and operations

- Providers, model selection, and reasoning effort are shared runtime controls.
- Memory, bounded context providers, artifacts, and internal evidence
  preserve useful results with separate visibility.
- Saved workflows extend repeatable procedures. Fusion is part of the supported
  daemon and DSH-web product composition; Graft remains a Pi-compatibility path,
  not a discoverable Spark product extension.
- Managed updates, backups, access keys, workspace registration, diagnostics,
  and recovery support operation beyond the first local run.

Use [configuration and paths](/reference/configuration-and-paths/) before
changing runtime storage, and [troubleshooting](/troubleshooting/) when a
surface and the daemon appear to disagree.
