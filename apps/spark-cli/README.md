# @zendev-lab/spark-cli

The real package owner of the root `spark` dispatcher. The generated npm
artifact contains the dispatcher, ACP and updater entrypoints, plus companion
command shims. `@zendev-lab/spark` is only the complete-installation meta package
that pins this package and the executable apps.

## Usage

```sh
spark
spark tui "initial Spark goal"
spark run --wait --json "headless Spark prompt"
spark daemon auth import pi --json
spark daemon model status --json
spark daemon status --json
spark daemon workspace ls --json
spark --help
```

The dispatcher does not own terminal rendering, daemon execution, provider/model state, or host runtime code. It only routes:

- `spark` and `spark tui ...` to the interactive Spark TUI surface.
- `spark run ...` and `spark bg ...` to daemon-native headless execution.
- `spark daemon ...` to daemon execution, authentication, model, session, and
  administration surfaces.
- `spark version`, `spark install`, and `spark update` to the update executable.

Spark 0.2 rejects the former Pi-style `--print`, `--mode`, `--list-models`,
root session aliases, and resource-management commands. Provider authentication
is under `spark daemon auth`; `spark daemon login` remains machine connectivity
for daemon/Cockpit.

Unknown subcommands fail loudly and suggest `spark tui ...` for prompt text. The
dispatcher has no direct implementation dependency on companion app CLIs. A
generated complete installation injects exact daemon, TUI, and Hub app
entrypoints; source checkouts use adjacent executables and standalone installs
may resolve canonical `spark-*` commands from `PATH`.
