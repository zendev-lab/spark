# Spark zellij validation

Zellij is the required operator path for real Spark TUI interaction and capture when terminal UX is in scope. Contract tests remain responsible for non-visual behavior.

## Run

```bash
node --experimental-strip-types scripts/spark-zellij-harness.mts
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --exercise-spark-tui \
  --strict
```

The harness creates a unique session name, a short socket directory, an
isolated `SPARK_HOME`, and a real daemon session before launching the TUI. The
host Zellij session is created through an `expect`-backed PTY at a fixed size;
the default borderless floating TUI pane is `80x24`. Exercise the release matrix
with `--exercise-width` and `--exercise-height`:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --exercise-spark-tui \
  --exercise-width 60 \
  --exercise-height 18 \
  --strict
```

Use `--exercise-tiled` only when intentionally testing Zellij layout behavior.
The installed control surface uses `subscribe`; `subscript` is not a supported
command. On Zellij 0.44.x the harness uses `--new-session-with-layout`;
`--session` plus `--layout` addresses an existing session and is not a reliable
creation path.

## Session resume

Zellij manages the terminal process; the Spark daemon owns durable conversation
state. The harness selects its prepared session explicitly:

```bash
spark daemon session list --json
spark tui --session-id <session-id>
```

Session selection is current-workspace scoped. `spark tui --session-id <session-id>` must match the canonical cwd/workspace hash. Closing or detaching the zellij/TUI pane must not stop the daemon-managed persistent session.

## Controlled scenario

The focused scenario creates a temporary pane, sends `/help`, captures visible
output, closes only that pane, and compares daemon status before and after:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --scenario zellij-subscribe-control \
  --output /tmp/spark-zellij-subscribe-control-report.json
```

For a full native interaction:

```bash
pnpm exec node --experimental-strip-types scripts/spark-zellij-harness.mts \
  --exercise-spark-tui \
  --exercise-width 120 \
  --exercise-height 30 \
  --slash-command /status
```

Add `--ordinary-input <text>` only when a real model/daemon turn is intended. Use `--spark-session-dir <path>` and `--spark-session-id <id>` when the task graph/session root is outside the current repository.

## Side Thread acceptance

Run lifecycle acceptance in an isolated Zellij session and isolated `SPARK_HOME`; do not reuse a developer daemon. The release gate is behavioral rather than visual modal parity:

1. `/btw ask <question>` reaches a terminal child invocation and `/btw show` displays the durable exchange.
2. A second submit while the child has a queued/running invocation fails with the typed busy error and creates no second invocation.
3. `spark daemon restart --yes --wait` changes the daemon process identity while preserving the current generation, transcript, and configuration.
4. `/btw model <provider>/<model>` and `/btw thinking <level>` update the effective projection; an unavailable model returns its typed configuration error.
5. `/btw handoff full ...` and `/btw handoff summary ...` each create one successful parent invocation and advance to a fresh generation.

The native command/status presentation is sufficient for this gate. The Pi-product modal overlay remains compatibility UI, not a second state owner or a prerequisite for retiring that product host.

## Evidence

A valid report includes:

- daemon status before and after, with secrets redacted;
- pane discovery and the captured visible TUI output;
- exit codes for launch, input, capture, and cleanup;
- stable daemon identity and nondecreasing terminal invocation counts;
- semantic checks for the attached session, locally rendered `/help`, native
  app surface, and preserved latest input;
- `blockers: []` for strict success.

## Cleanup

Never kill a user-owned Zellij session or daemon. The default unique name,
socket, and `SPARK_HOME` make ownership explicit. Cleanup removes only the
harness-created pane/session, isolated daemon, socket directory, and temporary
home. An explicit `--spark-home` must name a non-existing path so cleanup cannot
erase a pre-existing directory.
