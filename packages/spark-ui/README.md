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

## Conversation API

Import reusable chat presentation from `@zendev-lab/spark-ui/conversation`.
The subpath exposes compound conversation, message, prompt, attachment, source,
model, and context-usage components alongside protocol-neutral view types and
pure presentation helpers.

Actions are explicit callback props such as `onRetry`, `onSelect`, `onCommit`,
and `onSave`. Components may own transient focus, disclosure, and menu state,
but the consumer owns transcript revisions, submission, feedback, sharing,
recording, URLs, and cleanup. Hub only renders actions backed by an owner
contract; catalog fixtures document controlled surfaces that are not yet
available in the product.

Media components receive explicit URLs, MIME types, names, and sizes. They do
not derive routes from artifact summaries or inspect protocol metadata.

## Workbench API

Import agent-work presentation from `@zendev-lab/spark-ui/workbench`. The
subpath provides compound Tool, Confirmation, Plan, Task, and Artifact surfaces
plus display-only CodeBlock, DiffView, FileTree, Terminal, TestResults,
StackTrace, SchemaView, Commit, and WebPreview components.

Workbench values are protocol-neutral, JSON-safe presentation facts. Consumer
adapters decide which owner data is safe to expose and supply localized status
labels and callbacks. Code, terminal, diff, and schema components never execute
agent-authored content. WebPreview provides composable navigation and body
surfaces; `WebPreviewBody` accepts an explicit validated URL or a canonical,
server-rendered document, and always embeds it with an empty iframe sandbox.
Consumers must not pass raw agent-authored HTML or infer a preview URL from
artifact summaries.

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
