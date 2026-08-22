# spark-text

Spark-owned text layout helpers (`truncateToWidth`, `visibleWidth`,
`wrapTextWithAnsi`, `ToolCallText`) for packages that should not take a
presentation-host dependency.

This package measures terminal columns, including CJK, emoji, and ANSI
sequences.
