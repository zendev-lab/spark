# @zendev-lab/spark-ui

Spark-owned Svelte presentation boundary. It owns reusable UI primitives and
patterns, icons, design tokens, and the streaming Safe Markdown surface.

`spark-ui` is a component library name only. It is not an Artifact media type,
wire format, or executable MDX runtime.

`A2uiRenderer` is the native, schema-normalized A2UI v0.9/v0.9.1 basic-catalog
surface. It is read-only by default. Interaction requires an explicit
daemon-authenticated Repro Workbench binding; emitted actions remain revision
and Loop-generation bound and use the closed protocol action vocabulary.

Only this package may import Bits UI, Lucide, or `svelte-streamdown`; product
features consume its stable exports instead. Shared locale helpers and Hub
product copy stay in `@zendev-lab/spark-i18n` and its `/hub` subpath.
