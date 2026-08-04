# @zendev-lab/spark-ui

Spark-owned Svelte presentation boundary. It owns reusable UI primitives and
patterns, icons, design tokens, and the streaming Safe Markdown surface.

`spark-ui` is a component library name only. It is not an Artifact media type,
wire format, or executable MDX runtime.

Only this package may import Bits UI, Lucide, or `svelte-streamdown`; product
features consume its stable exports instead. Shared locale helpers and Cockpit
product copy stay in `@zendev-lab/spark-i18n` and its `/cockpit` subpath.
