# Spark configuration and path contract

This specification owns path precedence, exact persistence layout, and migration
invariants. User-facing path inspection and configuration guidance belong in
[`apps/spark-docs/src/content/docs/reference/configuration-and-paths.md`](../../apps/spark-docs/src/content/docs/reference/configuration-and-paths.md).

## Path roots

Spark uses `SPARK_HOME` as an explicit all-in-one root when it is set. When it is
unset, Spark follows the XDG directories independently:

```text
explicit API sparkHome > SPARK_HOME > XDG roots
```

The XDG roots are:

```text
XDG_CONFIG_HOME                         default $HOME/.config
XDG_DATA_HOME                           default $HOME/.local/share
XDG_CACHE_HOME                          default $HOME/.cache
XDG_STATE_HOME                          default $HOME/.local/state
XDG_RUNTIME_DIR                         app runtime falls back to XDG state
```

`SPARK_HOME` is a user-level root, not the workspace state directory.

## Exact persistence layout

With `SPARK_HOME` set:

```text
$SPARK_HOME/
├── config.json                    # Spark TUI/provider configuration
├── auth.json                      # provider credentials
├── sessions/                      # local TUI transcripts
├── ask.json                       # ask capability settings
├── agent/keybindings.json         # TUI keybinding overrides
├── role-model-settings.json       # Spark user role-to-model bindings
├── prompts/                       # user prompt templates
├── themes/                        # user themes
├── memory/
│   ├── memory.json                # user Spark memory
│   ├── learnings/                 # user learning artifacts
│   └── recall-candidates.json     # user recall candidates
├── exports/                       # transcript exports
├── share/                         # shareable transcript exports
├── cache/cued-version.json        # cue-shell release discovery cache
├── workspaces/<id>/               # workspace-scoped channel settings
└── apps/
    ├── hub/{data,cache,state,run}/
    └── daemon/{data,cache,state,run}/
```

With `SPARK_HOME` unset, files are split by XDG ownership:

```text
$XDG_CONFIG_HOME/spark/        config, auth, ask, role model settings, prompts, themes, keybindings, app TOML files
$XDG_DATA_HOME/spark/          sessions, memory/, exports, share, workspaces, hub/, daemon/
$XDG_CACHE_HOME/spark/         model/release caches, hub/, daemon/
$XDG_STATE_HOME/spark/         hub/, daemon/ state and logs
$XDG_RUNTIME_DIR/spark/        hub/, daemon/ sockets and pid files (app state `run/` fallback)
```

The namespace is added after the XDG root, so the default config path is
`$HOME/.config/spark/config.json`, not `$HOME/.config/config.json`. If
`XDG_RUNTIME_DIR` is unset, each app uses `$XDG_STATE_HOME/spark/<app>/run`.

## Public agent definitions

User role, skill, and workflow definitions use the public cross-harness standard
and are independent of `SPARK_HOME` and XDG:

```text
$HOME/.agents/roles/
$HOME/.agents/skills/
$HOME/.agents/workflows/
```

There is no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows`. Project role,
skill, and workflow definitions remain under project
`.agents/{roles,skills,workflows}`; Spark retains only a workspace-specific
`.spark/skills` definition layer. `.spark/workflows` is retired and is not
discovered; move existing saved scripts to `.agents/workflows`. Workspace-owned
Spark state remains under the workspace `.spark/`. Memory-related workspace
state lives under `.spark/memory/`:

```text
.spark/memory/
├── memory.json
├── learnings/                 # replaces repository-root .learnings/
├── recall-candidates.json     # replaces .spark/recall-candidates.json
└── reflections/               # replaces .spark/reflections/
```

## Retired variables

These variables have no current path-resolution implementation and are ignored:

- `PI_ROLES_HOME`
- `PI_CODING_AGENT_DIR`
- `PI_MEMORY_DIR`
- `SPARK_MEMORY_HOME`
- `SPARK_MEMORY_COMPAT_DIR`
- `SPARK_AGENT_DIR`
- `SPARK_HUB_*_DIR`
- `SPARK_DAEMON_*_DIR`

Explicit API path overrides remain available for embedded hosts and tests.

## Migration

### Cockpit to Hub

Opening the default Hub database first runs the Hub-owned, idempotent Cockpit
layout migration. Stop old Cockpit and Hub processes before upgrading. The
migration moves only the known app-owned paths:

| Retired Cockpit path | Canonical Hub path |
| --- | --- |
| `$XDG_CONFIG_HOME/spark/cockpit.toml` | `$XDG_CONFIG_HOME/spark/hub.toml` |
| `$XDG_DATA_HOME/spark/cockpit/cockpit.sqlite` | `$XDG_DATA_HOME/spark/hub/hub.sqlite` |
| `$XDG_CACHE_HOME/spark/cockpit/` | `$XDG_CACHE_HOME/spark/hub/` |
| `$XDG_STATE_HOME/spark/cockpit/` | `$XDG_STATE_HOME/spark/hub/` |
| `$XDG_RUNTIME_DIR/spark/cockpit/` | `$XDG_RUNTIME_DIR/spark/hub/` |
| `$SPARK_HOME/apps/cockpit/{data,cache,state,run}` | `$SPARK_HOME/apps/hub/{data,cache,state,run}` |

Preflight happens before any rename. If both a source and target exist, or a
live legacy database lock is present, startup fails without changing either
tree. If a later rename fails, completed renames are reversed. Re-running after
success is a no-op. The SQLite owner then renames active Hub tables and setting
keys through migration `0022`; the stable legacy `cockpit_…` instance ID is
preserved so registered daemons continue to recognize the same deployment.
Legacy Cockpit snapshot-v1 manifests remain readable.

Canonical configuration uses `SPARK_HUB_*`. Supported `SPARK_COCKPIT_*`
aliases are read only for upgrade compatibility; specifying different values
under both names fails closed. New files, environment documentation, cookies,
tokens, snapshots, and database rows use Hub names only.

Spark does **not** automatically move unrelated credentials, sessions, or
user-authored files. Serialized marker names and paths under `.spark/` remain
public persistence contracts and are not rewritten by the product rename.

### Memory layout

Memory-related layout migration **is** automatic and idempotent via
`migrateSparkMemoryLayout` (triggered on memory `session_start` and memory tool
access):

| Old path | New path |
|----------|----------|
| `$dataRoot/learnings/` | `$dataRoot/memory/learnings/` |
| `$dataRoot/recall-candidates.json` | `$dataRoot/memory/recall-candidates.json` |
| `.learnings/` (workspace/repo) | `.spark/memory/learnings/` |
| `.spark/recall-candidates.json` | `.spark/memory/recall-candidates.json` |
| `.spark/reflections/` | `.spark/memory/reflections/` |

Rename is preferred; cross-device moves fall back to copy+verify. If the target
already exists and is non-empty, Spark merges directories or skips conflicting
files and records the outcome.

Public `$HOME/.agents/{roles,skills,workflows}` definitions should remain in
place. Old component variables and Pi-specific locations may still identify
migration sources, but they do not affect current path resolution.

pi-memory Markdown import remains explicit: `memory({ action: "import_legacy",
apply: false })` then `apply: true` after review.

## Inspection invariant

The dispatcher exposes a read-only path-inspection surface that reports effective
user, Hub, and daemon paths without creating directories or migrating files.
Exact user-facing command syntax is documented only in the public configuration
reference.
