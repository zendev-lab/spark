# spark-text

Spark-owned text layout helpers (`truncateToWidth`, `visibleWidth`,
`wrapTextWithAnsi`, `ToolCallText`) for packages that should not depend on
`@zendev-lab/spark-tui-adapter`.

This package measures terminal columns, including CJK, emoji, and ANSI
sequences. Direct `@earendil-works/pi-tui` usage stays behind
`@zendev-lab/spark-tui-adapter`.
