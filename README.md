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

Spark requires Node.js `>=26 <27`. The managed installation is recommended
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

Open the Hub management application:

```bash
spark-hub
```

The equivalent dispatcher form is:

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
  headless JSON commands, ACP-compatible clients, or the read-only MCP adapter
  over the same owning domains.
- **Local-first boundaries** — each daemon retains local execution and side
  effects; Hub coordination carries routing state, audit data, and bounded
  receipts.

## Architecture

Spark separates dispatch, presentation, coordination, and execution:

```text
spark CLI / spark-tui ─────────► local spark-daemon ───► workspace + providers
channels / spark-acp ────────────────────────┘

browser / future app ──────────► spark-hub ◄────────── registered spark-daemon
                                  │
                                  └── embedded Web UI + global control plane
```

| Component | Responsibility | Does not own |
| --- | --- | --- |
| `spark` | Stable command dispatch to companion executables | Product state |
| `spark-tui` | Local interactive presentation and session attachment | Durable business state |
| `spark-daemon` | Sessions, invocations, channels, execution, retry, and recovery | Cross-workspace coordination |
| `spark-hub` | Authentication, daemon gateway, workspace registry, delegation, audit, and embedded management UI | Target execution, repositories, or internal evidence |
| `spark-acp` | Stateless protocol translation | Sessions or invocations |
| `spark-mcp` | Read-only MCP translation | Memory state or lifecycle |

The detailed ownership and command grammar are specified in
[`docs/specs/command-planes.md`](./docs/specs/command-planes.md). Package
dependency direction and state writers are defined by
[`architecture/packages.json`](./architecture/packages.json) and the
[package architecture specification](./docs/specs/package-architecture.md).

## Typical workflow

1. Describe the intended outcome in the TUI or with `spark run`.
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
| `spark` / `spark-tui` | Interactive local coding sessions |
| `spark run` / `spark bg` | Foreground scripts and background work |
| `spark-daemon` | Execution inspection and operator control |
| `spark-hub` | Global browser management, coordination, and delegation |
| `spark-acp` | ACP-compatible clients over canonical daemon sessions |
| `spark-mcp` | Read-only MCP clients over canonical Spark Memory |

The top-level dispatcher accepts `spark daemon`, `spark hub`, `spark tui`,
`spark acp`, and `spark mcp` as convenience forms and executes the matching
`spark-*` companion.
Run `spark --help` for the current command map. The complete command reference is
maintained in the [user documentation][cli-reference].

## Documentation

- [User documentation][docs] — installation, workflows, interfaces, and
  troubleshooting.
- [`SPARK.md`](./SPARK.md) — project intent, goals, non-goals, and open
  questions.
- [`docs/README.md`](./docs/README.md) — internal contracts and operator
  procedures.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — source setup, repository workflow,
  validation, documentation ownership, and pull requests.
- [`AGENTS.md`](./AGENTS.md) — repository-wide constraints for coding agents.

## Distribution and status

`@zendev-lab/spark` is the only public npm product. It exposes the `spark`
dispatcher and the companion executables `spark-daemon`, `spark-hub`,
`spark-tui`, `spark-acp`, `spark-mcp`, and `spark-update`. Source workspaces are private
implementation boundaries compiled into that product rather than separately
supported packages.

Spark is under active development. Managed installations provide explicit
update and rollback behavior; source checkouts are never self-modified.

Spark is MIT-licensed. Source-derived component notices are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

[cli-reference]: https://spark-docs.2742392377.workers.dev/reference/cli/
[docs]: https://spark-docs.2742392377.workers.dev/
[getting-started]: https://spark-docs.2742392377.workers.dev/getting-started/
