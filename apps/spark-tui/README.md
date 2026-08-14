# @zendev-lab/spark-tui

Spark's native terminal host. Prompts use the daemon `turn.submit` path; foreground streaming follows `turn.stream` and completion follows `turn.status`.

## Usage

```sh
spark
spark tui "initial prompt"
spark run "headless prompt"
spark run --json "headless prompt"
spark daemon model list --all
```

Spark 0.2 removes the Pi-style `--print`, `--mode`, and `--list-models`
compatibility flags. `@zendev-lab/spark-tui` is the public standalone terminal
app; the complete `@zendev-lab/spark` package installs the same lockstep version
and exposes it through `spark tui`.

The app's source workspace remains private, but the generated
`@zendev-lab/spark-tui` npm distribution is independently installable and
contains compiled JavaScript only.

## Configuration
Spark follows the standard XDG config, data, cache, state, and runtime roots by default. Set `SPARK_HOME` only when one self-contained root is preferred:

```sh
export SPARK_HOME=/path/to/spark-home
```

With `SPARK_HOME`, the main config is `$SPARK_HOME/config.json`, credentials are `$SPARK_HOME/auth.json`, sessions are under `$SPARK_HOME/sessions/`, keybindings under `$SPARK_HOME/agent/`, prompt templates under `$SPARK_HOME/prompts/`, and themes under `$SPARK_HOME/themes/`. Spark-owned role model settings, learnings, memory, recall, exports, and share files use sibling paths under the same root. App-specific daemon/Hub data uses `$SPARK_HOME/apps/<app>/{data,cache,state,run}`.

Without `SPARK_HOME`, these paths use `$XDG_CONFIG_HOME/spark`, `$XDG_DATA_HOME/spark`, `$XDG_CACHE_HOME/spark`, `$XDG_STATE_HOME/spark`, and `$XDG_RUNTIME_DIR/spark` according to ownership.

Workspace state remains in the current workspace `.spark/`. Cross-harness user roles, skills, and workflows load from `~/.agents/{roles,skills,workflows}`; project roles, skills, and workflows load from `.agents/{roles,skills,workflows}`, while workspace-specific Spark skills use `.spark/skills`; saved project workflows always use `.agents/workflows`. There are no `$SPARK_HOME/skills` or `$SPARK_HOME/workflows` directories. Run `spark paths --json` to inspect effective paths without creating files.

Retired Pi and component-specific storage variables no longer influence path resolution.

The native editor supports `@path`, image paths, `!command`, `!!command`, multiline input, steering, follow-ups, abort/restore, model selection, transcript export, and persisted session resume. Terminal-specific chords and binary clipboard images depend on terminal support.

When the daemon publishes an active Repro work projection, the TUI keeps its
bounded `work.repro` value in process-local presentation state. A compact
Implementation/Exactness/Formalize summary remains visible above the composer;
`Ctrl+K` opens the Repro inspector first, `Shift+Ctrl+K` cycles panels, and
`/inspect repro` opens it directly. Inside the panel, use `1`/`2`/`3` for lanes,
arrow keys or `j`/`k` for work items, Enter for associated Task/Run/GitChange
and Evidence projections, and Esc to collapse details or close the panel. The
TUI never derives lane state from transcript text or local timers. `/reload`
rebuilds panel focus and selection while the daemon reprojects the same durable
Session and Repro state.

## Daemon control

```sh
spark daemon status --json
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
```

Invocation status and streamed events come from the daemon. Attach and resume are restricted to the current workspace.

Run the component and Direct PTY validation lanes in [`../../.agents/notes/runbooks/native-tui-validation.md`](../../.agents/notes/runbooks/native-tui-validation.md) when changing native TUI interaction or process-terminal behavior.
