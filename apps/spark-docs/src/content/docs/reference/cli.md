---
title: Command discovery and CLI
description: Find the commands supported by the installed Spark version and use the stable command namespaces.
---

Spark's runtime help is the authoritative command catalog for the version you
are actually running. This page explains where to look and how the namespaces
fit together; it intentionally does not duplicate every subcommand and flag.

## Discover the installed command surface

Run help from the same installation and state root that you plan to operate:

```bash
spark --help
spark daemon --help
spark hub --help
```

Nested commands accept `--help` as well. Help is read-only: it must describe
the selected command without starting a daemon, Hub, or workflow.

Inside the TUI, use:

```text
/help
/help commands
/help all
```

`/help` gives task-oriented guidance, `/help commands` shows slash commands,
and `/help all` includes the complete active command surface. Archived
documentation remains frozen for its release; use current runtime help after an
upgrade.

## Command namespaces

| Surface | Purpose | Discovery |
| --- | --- | --- |
| `spark` | Start the TUI or invoke top-level foreground, background, installation, diagnostic, and version workflows | `spark --help` |
| `spark daemon` | Operate the daemon-owned execution, session, workspace, model, authentication, and channel state | `spark daemon --help` |
| `spark hub` | Run and administer Hub coordination and Web surfaces | `spark hub --help` |
| TUI slash commands | Act on the current interactive session | `/help commands` |
| ACP and MCP adapters | Connect compatible clients through their configured Spark adapter | See [collaboration and clients](/guides/collaboration/) |

The daemon owns persistent execution state. The top-level dispatcher and Hub
commands translate user intent into their owning runtime; they do not maintain
parallel session or execution state.

## Common entry points

These examples are representative starting points, not an exhaustive catalog:

```bash
# Open the interactive terminal.
spark

# Run foreground work or queue durable background work.
spark run --json "Summarize the current repository."
spark bg --json "Run the repository validation."

# Inspect the effective installation and state roots.
spark version --json
spark paths --json
spark doctor

# Inspect daemon and Hub command groups before operating them.
spark daemon --help
spark hub --help
```

Use `spark daemon auth --help` and `spark daemon model --help` to discover
the authentication and model operations supported by the installed version.
Use [configuration and paths](/reference/configuration-and-paths/) before
copying, migrating, or repairing state.

## Exit behavior and automation

- Successful commands exit `0`.
- Invalid syntax or an unknown command exits non-zero and prints actionable
  usage.
- State-changing commands should use `--json` when an automation needs a
  stable machine-readable result.
- Inspect owner state before retrying an operation whose outcome is unknown.
  Browser appearance, transcript text, and elapsed time are not execution
  truth.

For a guided workflow, continue with [getting started](/getting-started/),
[TUI](/guides/tui/), or the [operator handbook](/guides/operator-handbook/).
