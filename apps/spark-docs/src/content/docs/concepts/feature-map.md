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
| TUI | Describe work, steer one session, and inspect its local projection | Terminal presentation |
| Daemon | Keep sessions and work running after a frontend disconnects | Execution truth |
| Hub | Supervise workspaces and conversations from the browser | Web presentation and coordination |
| ACP | Connect compatible editor clients to daemon-owned sessions | Adapter only |
| Updater | Install, upgrade, roll back, and report build identity | Installed version |

The complete installation meta package is `@zendev-lab/spark`; it pins the
lockstep packages but contains no dispatcher implementation.
`@zendev-lab/spark-cli` owns the real `spark` command. Daemon, TUI, and Hub are
also independently installable app packages. Other source workspaces are private
implementation boundaries rather than supported products. See
[surfaces and ownership](/concepts/surfaces/) and the [CLI reference](/reference/cli/).

For contributors, the source topology stays compact by family:

| Source family | Responsibility |
| --- | --- |
| `apps/spark-cli`, `spark-tui`, `spark-daemon`, `apps/spark-cockpit` (Hub compatibility path) | Executable dispatcher and presentation/runtime hosts |
| `packages/spark-extension`, `spark-daemon-client` | Product composition and the shared daemon client boundary |
| Capability/runtime `packages/spark-*` | Files, Web, tasks, artifacts, memory, workflows, modes, roles, sessions, and other reusable behavior |
| `spark-protocol`, `spark-core`, `spark-runtime`, `spark-system`, `spark-tui-adapter` | Cross-surface contracts and dependency-light foundations |
| `packages/spark-cockpit-*` | Hub-private database, coordination, and localization implementation under compatibility paths |

Contributors can inspect `docs/specs/package-architecture.md` for dependency
rules and `architecture/packages.json` for the exhaustive owner/stability
inventory. Ordinary users do not need to learn individual workspace packages.

## 1. Core runtime: one daemon

The daemon owns durable sessions, queued and running work, event streams,
recovery, workspace binding, channel listeners, and autonomous continuation.
Foreground runs, background submissions, TUI prompts, and Hub Web messages all
reach this same execution owner.

Use `spark doctor` and `spark daemon status --json` for health. Use
[runs and sessions](/guides/runs-and-sessions/) for foreground, background,
attach, resume, and cancellation.

## 2. Interactive design: Hub Web and TUI

- Use the [TUI](/guides/tui/) for fast local conversation, Plan/Implement,
  steering, model selection, and the current session inspector.
- Use [Hub Web](/guides/cockpit/) for workspace overview, conversations,
  Inbox, artifacts, resources, and cross-daemon supervision.
- Use the CLI when you already know the operation and want a scriptable result.

The TUI's `/inspect` panel is local to the current session. `spark hub`
opens the separate browser control surface.

## 3. Base agent tools

Spark supplies tools for files, search, shell and scripts, tasks, artifacts,
questions, memory and context, models, roles, sessions, workflows, and durable
loops. Users normally describe the desired outcome; the agent selects tools
and asks for approval when policy requires it.

See the complete, profile-aware [agent tool catalog](/reference/tools/).

## 4. Tasks and autonomous progress

Ordinary project work follows:

```text
Project → Task plan → claim or assign → Run → Artifact → Review
```

`/plan` creates verifiable work without implementing it. `/implement` continues
through ready tasks until complete, blocked, validation fails, or a decision is
needed. Goal, Loop, Repro, and Workflow add daemon-owned continuation for work
that must persist or repeat. `/automate` is only a picker for those existing
modes.

Start with [plan and implement](/guides/plan-and-implement/), then read
[long-running automation](/guides/automation/).

## 5. Channels and multi-session collaboration

Spark distinguishes reusable Roles, durable Sessions, read-only Side Threads,
and message-platform Channels. Feishu, Infoflow, and QQ Bot conversations bind
to daemon sessions instead of creating another execution owner. Sessions can
send requests or notifications and receive completion summaries through their
Inbox.

See [collaboration and channels](/guides/collaboration/) and
[Side Threads](/guides/side-threads/).

## 6. Models, context, extensions, and operations

- Providers, model selection, and reasoning effort are shared runtime controls.
- Memory, bounded context providers, artifacts, and internal evidence
  preserve useful results with separate visibility.
- Saved workflows extend repeatable procedures; Fusion and Graft are explicit
  opt-in capabilities.
- Managed updates, backups, access keys, workspace registration, diagnostics,
  and recovery support operation beyond the first local run.

Use [configuration and paths](/reference/configuration-and-paths/) before
changing runtime storage, and [troubleshooting](/troubleshooting/) when a
surface and the daemon appear to disagree.
