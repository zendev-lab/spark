# @zendev-lab/spark-tui-adapter

Spark-owned TUI boundary over `@earendil-works/pi-tui`.

This package intentionally stays small. It centralizes:

- keyboard input parsing and key event types;
- current `pi-tui` component/runtime exports used by Spark native TUI adapters and UI-capable extensions.

Text measurement, truncation, and ANSI-aware wrapping live in
`@zendev-lab/spark-text`. This adapter re-exports those helpers for existing TUI
callers.

It is not Spark's full UI framework and should not contain task, workflow, artifact, daemon, or hub business logic. Those layers should depend on shared protocols/view models or app-local adapters rather than importing `@earendil-works/pi-tui` directly.
