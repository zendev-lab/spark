---
description: "Place search/fetch in spark-tool-web and make spark-web the DSH web application"
owner: zrr1999
created: 2026-08-20
---

# spark-tool-web capability and spark-web application

## Decision

- Rename the search/fetch capability from `@zendev-lab/spark-web` to
  `@zendev-lab/spark-tool-web` at `packages/spark-tool-web`.
- Make `@zendev-lab/spark-web` the `apps/spark-web` application that owns
  `spark web` / `spark-web`. Absorb the former `spark-web-dsh` DSH client
  plugin and the CLI in-process boot into that app.
- Keep the package budget closed at 44: this is a rename plus a
  capability-to-application reclassify, not a new workspace.

## Why

`spark-tool-<family>` is the inventory name for a stateless tool adapter.
Search and fetch do not own a Spark process. `spark web` does: it boots the
DSH web profile, writes managed plugins into that profile, and is a dispatcher
plane. Keeping the DSH client in `packages/` implied a capability while the
real process still lived inside `spark-cli`.

## Compatibility

- Persisted `responseId` prefix remains `spark-web:`; the store remains
  `.spark/web/content.json`.
- Persisted extension specifiers `@zendev-lab/spark-web/extension` rewrite to
  `@zendev-lab/spark-tool-web/extension`.
- The DSH overlay id stays `spark-web-dsh` so existing profiles skip a second
  insert. The profile still resolves the client plugin as
  `@zendev-lab/spark-web-dsh`.
- `spark web` dispatches to the `spark-web` companion the same way `spark hub`
  and `spark tui` dispatch, instead of importing the boot path in-process.

## Not in this change

Native-izing the web surface beyond DSH profile boot, `dsh-scope`, or
`dsh-tools` guard/pre-execute wiring.
