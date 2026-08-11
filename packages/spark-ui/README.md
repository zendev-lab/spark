# @zendev-lab/spark-ui

Spark-owned Svelte presentation boundary. It owns reusable UI primitives and
patterns, icons, design tokens, and the streaming Safe Markdown surface.

`@zendev-lab/spark-ui/conversation` owns protocol-neutral conversation
presentation types, pure formatting/visibility/scroll helpers, and reusable
Svelte shells for messages, parts, queues, status, composers, and slash-action
surfaces. Product adapters resolve wire schemas, media URLs, runtime actions,
copy, and localized product wording before passing structured props into it.

`spark-ui` is a component library name only. It is not an Artifact media type,
wire format, or executable MDX runtime.

`A2uiRenderer` is the native, schema-normalized A2UI v0.9/v0.9.1 basic-catalog
surface. It is read-only by default. Interaction requires an explicit
daemon-authenticated Repro Workbench binding; emitted actions remain revision
and Loop-generation bound and use the closed protocol action vocabulary.

Only this package may import Bits UI, Lucide, or `svelte-streamdown`; product
features consume its stable exports instead. Shared locale helpers and Hub
product copy stay in `@zendev-lab/spark-i18n` and its `/hub` subpath.

## Internal component catalog

Run `pnpm --filter @zendev-lab/spark-ui run catalog:dev` for the package-local
component catalog, or `catalog:build` for its CI build. The catalog is a test and
review surface only: it is not exported, packed, or mounted by Spark Hub.

Components inherit light tokens by default. A consumer or catalog fixture may
set `data-spark-theme="dark"` on any ancestor for the complete dark token set.
Theme selection remains a product concern; `spark-ui` does not persist or infer
the user's preference. Components use logical layout properties so controlled
`dir="rtl"` fixtures can verify directionality without adding product locale
policy to the package.
