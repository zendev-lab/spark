---
title: Configuration and paths
description: Inspect Spark configuration, credentials, runtime state, and workspace-owned files.
---

Never infer an active path from an old installation. Ask the dispatcher:

```bash
spark paths
spark paths --json
```

These commands inspect effective paths without creating files.

## Self-contained SPARK_HOME

Set `SPARK_HOME` when you want one explicit root:

```bash
export SPARK_HOME=/path/to/spark-home
```

Important paths under that root include:

```text
$SPARK_HOME/config.json
$SPARK_HOME/auth.json
$SPARK_HOME/sessions/
$SPARK_HOME/agent/
$SPARK_HOME/prompts/
$SPARK_HOME/themes/
$SPARK_HOME/apps/daemon/{data,cache,state,run}
$SPARK_HOME/apps/hub/{data,cache,state,run}
```

`auth.json` contains provider credentials. Do not commit or copy it into a
workspace.

## XDG defaults

Without `SPARK_HOME`, Spark uses the platform's XDG configuration, data, cache,
state, and runtime roots:

```text
$XDG_CONFIG_HOME/spark
$XDG_DATA_HOME/spark
$XDG_CACHE_HOME/spark
$XDG_STATE_HOME/spark
$XDG_RUNTIME_DIR/spark
```

Platform defaults apply when an individual XDG variable is unset.

## Cockpit-to-Hub upgrade

On first use of the default Hub database, Spark automatically migrates the
retired `cockpit.toml`, Cockpit XDG app directories, and `cockpit.sqlite` into
the Hub paths above. Stop the old Cockpit and Hub processes before upgrading.
The migration is idempotent and fail-closed: a live legacy database lock or an
existing source **and** target stops startup without overwriting either tree.

Copy any existing `SPARK_COCKPIT_*` values to their corresponding
`SPARK_HUB_*` names. The old aliases are accepted during the upgrade window,
but conflicting old and new values are rejected. Fresh state is written only
under Hub names. Existing registered daemons keep their stable deployment ID;
old Cockpit snapshot-v1 backups remain inspectable and restorable.

## Managed installation paths

A managed installation uses the XDG data, configuration, state, and cache
roots independently of `SPARK_HOME`:

```text
$XDG_DATA_HOME/spark/versions/<version>/
$XDG_DATA_HOME/spark/versions/current
$XDG_CONFIG_HOME/spark/update.toml
$XDG_STATE_HOME/spark/update/
$XDG_CACHE_HOME/spark/update/
```

Use `SPARK_UPDATE_POLICY` and `SPARK_UPDATE_CHANNEL` for temporary policy
overrides. Run `spark update status --json` to inspect the effective policy and
transaction state. The persisted `checkIntervalHours` defaults to `24` and can
be changed with `spark update configure --interval-hours <hours>`.

## Workspace and agent definitions

- `.spark/` contains workspace-owned Spark runtime state.
- `~/.agents/{roles,skills,workflows}` contains user-level reusable definitions.
- `.agents/{roles,skills,workflows}` contains project-level definitions.
- `.spark/skills` contains workspace-specific Spark skills.

There are no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows` directories.
