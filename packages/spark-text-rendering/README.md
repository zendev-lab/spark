# spark-text-rendering

Spark-owned text rendering primitives (`truncateToWidth`, `visibleWidth`,
`wrapTextWithAnsi`, `ToolCallText`, and copy-language detection) for packages
that should not take a presentation-host dependency.

This package measures terminal columns, including CJK, emoji, and ANSI
sequences.
