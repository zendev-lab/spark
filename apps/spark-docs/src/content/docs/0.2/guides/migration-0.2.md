---
title: Migrating to Spark 0.2.0
description: Replace removed Pi-style CLI aliases, import Pi authentication, and
  verify the native Spark surfaces.
slug: 0.2/guides/migration-0.2
---

Spark 0.2.0 is a command-surface hard cut. Removed aliases fail with usage exit
code `2`; Spark does not silently invoke Pi.

## Command replacements

| Removed command | 0.2.0 command |
| --- | --- |
| `spark --print <prompt>` or `spark -p <prompt>` | `spark run <prompt>` |
| `spark --mode json --print <prompt>` | `spark run --json <prompt>` |
| `spark --list-models` | `spark daemon model list --all` |
| `spark session ...` / `spark sessions ...` | `spark daemon session ...` |
| root Pi-style resource commands | use managed installation or edit Spark-owned configuration explicitly |

`spark`, `spark run`, `spark bg`, `spark version`, `spark paths`,
`spark doctor`, `spark update`, and `spark install --managed` remain product
entrypoints.

## Import Pi authentication once

```bash
spark daemon auth import pi --json
spark daemon auth status --json
spark daemon model list --all --json
```

The importer reads `PI_CODING_AGENT_DIR/auth.json` when configured, otherwise
`~/.pi/agent/auth.json`. It accepts literal API keys and OAuth records only for
registered, type-compatible providers. Dynamic environment or command
references are reported as `dynamic_reference_unsupported` and are never
evaluated.

Existing Spark credentials are retained. Use `--overwrite` only after reviewing
the provider-only report. Source/store failures leave the Spark auth file
unchanged.

## Verify the cut

```bash
spark --print "must fail"
spark --list-models
spark daemon auth status --json
spark daemon model status --json
spark
```

The first two commands must fail. In the TUI, verify `/help`, `/login`,
`/model`, `/status`, and `/sessions`; `/help` must stay local and Esc must
cancel the model picker without changing the session model.

Spark 0.2.0 retains the Pi AI/TUI kernel behind Spark-owned adapters. The
product extension and public CLI are Spark-native; renderer replacement is a
separate gated architecture decision.
