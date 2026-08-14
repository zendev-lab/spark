# Native TUI validation

Spark validates the native terminal surface in two owner-aligned lanes. Neither
lane requires a terminal multiplexer or a developer-owned daemon.

## Component contract

The in-process Vitest harness owns deterministic component behavior:

```bash
pnpm exec vp test run --config apps/spark-tui/vitest.config.ts \
  apps/spark-tui/src/__tests__/spark-native-tui-component-contract.test.ts
```

`SparkNativeTuiComponentHarness` drives the real app component and editor over a
small fake `TUI` boundary. It covers renderer-neutral state transitions, editor
input and submission, fixed-size rendering, and configured shortcut semantics.
It does not claim to emulate a process terminal.

Use the larger adjacent component suite when changing native TUI composition or
rendering:

```bash
pnpm exec vp test run --config apps/spark-tui/vitest.config.ts \
  apps/spark-tui/src/__tests__/spark-native-tui-component-harness.test.ts
```

## Direct PTY contract

The app-local Direct PTY test launches `runNativeSparkTui()` in a real child
pseudo-terminal:

```bash
pnpm exec vp test run --config apps/spark-tui/vitest.config.ts \
  apps/spark-tui/src/__tests__/spark-native-tui-direct-pty.test.ts
```

The harness owns process-terminal behavior that the component lane cannot
represent:

- stdin and stdout are real TTY endpoints;
- `ProcessTerminal` enables raw mode while the TUI is active and restores it on
  exit;
- input and rendered output cross the PTY master as terminal bytes;
- PTY resize reaches the child dimensions and causes a full-width redraw;
- `/reload` returns a process-reload intent only after raw mode is restored;
- the configured exit chord terminates the child cleanly.

Every fixture run receives a temporary `SPARK_HOME` and report path. Cleanup
kills only the fixture process when needed and removes only its temporary root.
The responder is local and deterministic, so this lane neither starts nor
reuses a Spark daemon.

## Process reload contract

The app-local process test launches the real TUI supervisor and disposable
workers without a daemon:

```bash
pnpm exec vp test run --config apps/spark-tui/vitest.config.ts \
  apps/spark-tui/src/__tests__/spark-tui-process-supervisor.test.ts
```

It proves that `/reload`-style handoff replaces the worker PID, preserves the
exact session target and supervisor cwd, requires both the private reload exit
code and a bounded valid IPC message, exits workers that retain live handles,
and escalates repeated termination signals without leaving an orphan. The
component and CLI suites separately cover the slash exit intent, daemon
admission guard, and lease-release-before-handoff ordering.

## Full app validation

Run the package suite and typecheck before changing the validation boundary:

```bash
pnpm --filter @zendev-lab/spark-tui test -- --runInBand
pnpm --filter @zendev-lab/spark-tui exec tsc --noEmit -p tsconfig.json
```

Renderer replacement remains a separate architecture decision backed by the
component, Direct PTY, packaged-product, and platform validation appropriate to
the proposed renderer.
