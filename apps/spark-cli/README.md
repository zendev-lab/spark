# spark-cli

Thin dispatcher package for the root `spark` command.

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

Spark 0.2 rejects the former Pi-style `--print`, `--mode`, `--list-models`,
root session aliases, and resource-management commands. Provider authentication
is under `spark daemon auth`; `spark daemon login` remains machine connectivity
for daemon/Cockpit.

Unknown subcommands fail loudly and suggest `spark tui ...` for prompt text. The `@zendev-lab/spark-daemon` package remains an implementation dependency; users should prefer the public `spark daemon ...` command group.
