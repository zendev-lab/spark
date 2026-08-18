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

## Daemon invocation concurrency

The daemon admits up to four root invocations from distinct sessions by
default. Configure a startup value from `1` through `64`, then restart the
daemon to apply it:

```bash
spark daemon configure --invocation-concurrency 8
spark daemon restart --yes
spark daemon status --json
```

The effective runtime value appears under `execution.rootConcurrency`; status
also reports the `in_process` backend and the one reserved blocking-question
overflow slot. This setting controls root invocation admission. It does not
create operating-system worker processes, and work in the same session remains
serialized.

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

Roles, Workflows, and Skills share this precedence (later roots override earlier
same-name resources):

```text
builtin -> user -> workspace -> cwd -> configured -> repository
```

- `.spark/` contains workspace-owned Spark runtime state.
- `~/.agents/{roles,skills,workflows}` contains user-level reusable definitions.
- `.agents/{roles,skills,workflows}` contains repository and cwd definitions; the
  repository ancestors are scanned before the cwd root.
- An explicitly configured user root replaces the default user root.
- Explicit configured Skill directories are scanned after cwd.
- Repository Skills are focused progressively by request matching or an explicit
  Skill Agent; they are not injected into the startup catalog.

Workflow and Role selectors keep their existing source names; their project roots
share the same precedence contract. `.spark/skills` contains workspace-specific
Spark skills.

There are no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows` directories.
