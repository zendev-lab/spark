---
title: Getting started
description: Install Spark, configure a model, and complete a first foreground or interactive run.
sidebar:
  order: 2
---

## Requirements

Spark currently requires Node.js `>=24` and npm. `@zendev-lab/spark` is the
complete product payload and brings matching daemon, Hub, and local web app
packages. The native bootstrap does not bundle a Node runtime.

## Install

The verified curl bootstrap is recommended. It detects the current macOS/Linux
x64/arm64 target, verifies the release SHA-256, then asks the exact native CLI
to install the matching managed npm payload:

```bash
curl -fsSL https://github.com/zendev-lab/spark/releases/latest/download/install.sh | sh
spark version --json
spark update status --json
```

The stable launcher defaults to `~/.local/bin/spark`. Use an explicit absolute
prefix when needed:

```bash
curl -fsSL https://github.com/zendev-lab/spark/releases/latest/download/install.sh \
  | sh -s -- --prefix /opt/spark
```

The installer prints an exact `PATH` repair if another global npm command wins
command resolution. It never silently runs an older Node dispatcher.

You can instead keep the package manager in charge of the complete installation:

```bash
npm install --global @zendev-lab/spark
spark --help
```

Install an app package directly when a host needs only that executable:

```bash
npm install --global @zendev-lab/spark-daemon  # or spark-hub / spark-web
spark-daemon --help
```

Global npm, pnpm, Yarn, Bun, and Vite+ installations delegate exact-version
updates to their installation owner. Source checkouts report migration guidance
but never replace themselves; their launcher incrementally builds the same Rust
CLI when its Cargo/source fingerprint changes.

Run the health check before troubleshooting a host:

```bash
spark doctor
```

## Configure a model

Provider authentication and model selection are daemon-owned. Discover the
installed commands, then inspect or set the active model:

```bash
spark daemon auth --help
spark daemon model --help
spark daemon model status --json
```

When Spark prompts for an API key, enter it in the prompt; do not put secrets
in project files, `config.json`, or shell history.

## Complete a first run

For a foreground, non-interactive answer:

```bash
spark run "Summarize this repository and identify its validation command."
```

Use JSON mode for scripts:

```bash
spark run --json "List the top-level packages."
```

For an interactive session, open the local workbench from the target workspace:

```bash
spark web
```

Spark starts or contacts the local daemon as needed. Run `spark daemon status
--json` to inspect the service rather than guessing from frontend behavior.

## Next steps

- Follow the [operator handbook](/guides/operator-handbook/) for the complete
  daemon, Hub, workspace, session, and durable execution path.
- [Plan and implement your first change](/guides/plan-and-execute/).
- Browse the [complete feature map](/concepts/feature-map/) without learning every command.
- Learn the [local web workbench](/guides/web/).
- Choose between [foreground runs, background work, and sessions](/guides/runs-and-sessions/).
- Open the [Hub Web interface](/guides/hub/).
