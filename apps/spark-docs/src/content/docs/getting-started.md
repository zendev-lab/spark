---
title: Getting started
description: Install Spark, configure a model, and complete a first foreground or interactive run.
sidebar:
  order: 2
---

## Requirements

Spark currently requires Node.js `>=26 <27`. `@zendev-lab/spark` is the complete
installation and brings matching daemon, TUI, and Hub app packages. Those apps
can also be installed independently for single-process deployments.

## Install

The managed installation is recommended because it supports atomic upgrades
and rollback:

```bash
pnpm dlx @zendev-lab/spark install --managed
spark version --json
spark update status --json
```

You can instead keep the package manager in charge of the complete installation:

```bash
npm install --global @zendev-lab/spark
spark --help
```

Install an app package directly when a host needs only that executable:

```bash
npm install --global @zendev-lab/spark-daemon  # or spark-tui / spark-hub
spark-daemon --help
```

Global npm, pnpm, Yarn, Bun, and Vite+ installations delegate exact-version
updates to their installation owner. Source checkouts report migration guidance
but never replace themselves.

Run the health check before troubleshooting a host:

```bash
spark doctor
```

## Configure a model

Open the interactive TUI:

```bash
spark
```

Use `/login` to inspect available provider authentication and start the
provider's interactive login flow. Use `/model` to inspect or select the active
model. When Spark prompts for an API key, enter it in the prompt; do not put
secrets in project files, `config.json`, or shell history.

## Complete a first run

For a foreground, non-interactive answer:

```bash
spark run "Summarize this repository and identify its validation command."
```

Use JSON mode for scripts:

```bash
spark run --json "List the top-level packages."
```

For an interactive session, stay in `spark` or run:

```bash
spark tui "Inspect the current project before proposing a change."
```

Spark starts or contacts the local daemon as needed. Run `spark daemon status
--json` to inspect the service rather than guessing from frontend behavior.

## Next steps

- Follow the [operator handbook](/guides/operator-handbook/) for the complete
  daemon, Hub, workspace, session, and durable execution path.
- [Plan and implement your first change](/guides/plan-and-execute/).
- Browse the [complete feature map](/concepts/feature-map/) without learning every command.
- Learn the [TUI's progressive controls](/guides/tui/).
- Choose between [foreground runs, background work, and sessions](/guides/runs-and-sessions/).
- Open the [Hub Web surface](/guides/hub/).
- Use [automation](/guides/automation/) only when ordinary Plan and Implement are not enough.
