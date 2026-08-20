# Spark

**A local-first coding-agent runtime for durable execution, verifiable workflows,
and multi-workspace coordination.**

Spark keeps agent work alive beyond one terminal process. A local daemon owns
persistent sessions, invocations, background execution, retries, and recovery.
The Hub coordinates registered workspaces and delegations without taking over
their repositories or execution state. The TUI, Hub Web UI, channels, and ACP
are interfaces over those owners rather than competing runtimes.

Use Spark when a coding task needs to continue, ask for a decision, produce
traceable artifacts, survive frontend restarts, or move between terminal and
browser supervision.

## Quick start

Spark requires Node.js `>=24`. The managed installation is recommended
because it supports atomic upgrades and rollback:

```bash
pnpm dlx @zendev-lab/spark install --managed
spark doctor
spark
```

Run a foreground task without opening the TUI:

```bash
spark run "Summarize this repository and identify its validation command."
```

Install an executable app independently when a host needs only that process:

```bash
npm install --global @zendev-lab/spark-hub
spark-hub
```

The complete `@zendev-lab/spark` package installs matching daemon, TUI, and Hub
companions, so its dispatcher can also use:

```bash
spark hub
```

Spark starts or contacts the local daemon as needed. Use `spark-daemon status
--json` when you need to inspect execution state directly.

See the [getting-started guide][getting-started] for provider configuration,
package-manager-owned installations, background runs, sessions, and remote
operation.

## What Spark provides

- **Durable execution** — sessions, invocations, background work, retries, and
  recovery belong to the daemon rather than a frontend process.
- **Controlled autonomy** — Plan and Implement cover ordinary changes; Goal,
  Loop, Repro, and Workflow add supervised long-running behavior.
- **Human decisions** — questions and approvals remain attached to the session
  and work that requested them.
- **Traceable outcomes** — tasks connect work to `issue`, `git_change`, and
  `document` artifacts, with verification kept separate from user-facing
  results.
- **Multiple interfaces** — use the native TUI, Hub Web UI, messaging channels,
  headless JSON commands, or the stateless ACP adapter over the same execution
  model.
- **Local-first boundaries** — each daemon retains local execution and side
  effects; Hub coordination carries routing state, audit data, and bounded
  receipts.

## Architecture

Spark separates dispatch, presentation, coordination, and execution:

```text
spark CLI / spark web ─────────► local spark-daemon ───► workspace + providers
channels / spark-acp ────────────────────────┘

browser / future app ──────────► spark-hub ◄────────── registered spark-daemon
                                  │
                                  └── embedded Web UI + global control plane
```

| Component | Responsibility | Does not own |
| --- | --- | --- |
| `spark` | Stable command dispatch to companion executables | Product state |
| `spark-web` | Local interactive presentation and session attachment | Durable business state |
| `spark-web-dsh` | Optional DeepSeek Harness compatibility presentation | Canonical Spark daemon state |
| `spark-daemon` | Sessions, invocations, channels, execution, retry, and recovery | Cross-workspace coordination |
| `spark-hub` | Authentication, daemon gateway, workspace registry, delegation, audit, and embedded management UI | Target execution, repositories, or internal evidence |
| `spark-acp` | Stateless protocol translation | Sessions or invocations |

The detailed ownership and command grammar are specified in
[`.agents/notes/contracts/command-planes.md`](./.agents/notes/contracts/command-planes.md). Package
dependency direction and state writers are defined by
[`architecture/packages.json`](./architecture/packages.json) and the
[package architecture specification](./.agents/notes/contracts/package-architecture.md).

## Typical workflow

1. Describe the intended outcome in `spark web` or with `spark run`.
2. Use Plan to turn the intent into durable, inspectable tasks.
3. Use Implement for ordinary execution, or opt into Goal, Loop, Repro, or
   Workflow when the work needs autonomous progress.
4. Answer questions and approvals from the owning session or Hub Inbox.
5. Inspect artifacts, changes, tasks, and verification before delivery.
6. Continue locally or delegate bounded work to another workspace through Hub.

The [user documentation][docs] explains these workflows without requiring
knowledge of internal packages or storage.

## Interfaces

| Interface | Best suited for |
| --- | --- |
| `spark` / `spark web` | Interactive local coding sessions |
| `spark run` / `spark bg` | Foreground scripts and background work |
| `spark-daemon` | Execution inspection and operator control |
| `spark-hub` | Global browser management, coordination, and delegation |
| `spark-acp` | ACP-compatible clients over canonical daemon sessions |

The top-level dispatcher accepts `spark daemon`, `spark hub`, `spark web`,
`spark acp`, and `spark mcp` as convenience forms and executes the matching
`spark-*` companion. The complete meta package installs every companion; the
real dispatcher remains in `@zendev-lab/spark-cli`. Run `spark --help` for the
current command map. The complete command reference is
maintained in the [user documentation][cli-reference].

## Documentation

- [User documentation][docs] — installation, workflows, interfaces, and
  troubleshooting.
- [`SPARK.md`](./SPARK.md) — project intent, goals, non-goals, and open
  questions.
- [`.agents/notes`](./.agents/notes) — on-demand internal contracts, decisions,
  and maintainer runbooks.
- [`.agents/AGENTS.md`](./.agents/AGENTS.md) — agent knowledge placement and
  progressive-disclosure rules.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — source setup, repository workflow,
  validation, documentation ownership, and pull requests.
- [`AGENTS.md`](./AGENTS.md) — repository-wide constraints for coding agents.

## Distribution and status

Spark publishes five lockstep-versioned npm distributions from the same private
monorepo:

- `@zendev-lab/spark` is the **complete installation meta package**. It pins the
  matching CLI, daemon, Hub, and web app packages and keeps `spark` available through
  a thin forwarding launcher, but contains no dispatcher or app implementation.
- `@zendev-lab/spark-cli` owns the real `spark` dispatcher, ACP, MCP and updater
  entrypoints, and companion command shims.

- `@zendev-lab/spark-daemon`, `@zendev-lab/spark-hub`, and
  `@zendev-lab/spark-web` are independently installable executable apps.

The split is a deployment and trust boundary, not a source-code ownership split.
The private app composition roots and internal adapter/capability workspaces
remain unpublished source boundaries. All five public tarballs share one release
version and protocol compatibility contract, while the app packages can be
installed and deployed independently.

Spark is under active development. Managed root installations provide explicit
update and rollback behavior; source checkouts are never self-modified. Direct
app installations are updated by their package manager or container deployment.

Spark is MIT-licensed. Source-derived component notices are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

[cli-reference]: https://spark-docs.2742392377.workers.dev/reference/cli/
[docs]: https://spark-docs.2742392377.workers.dev/
[getting-started]: https://spark-docs.2742392377.workers.dev/getting-started/
