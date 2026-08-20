---
description: "Rename the search/fetch capability from spark-web to spark-tool-web"
owner: zrr1999
created: 2026-08-20
---

# spark-tool-web capability rename

## Decision

Rename the search/fetch capability from `@zendev-lab/spark-web` to
`@zendev-lab/spark-tool-web` at `packages/spark-tool-web`. Keep the package
budget closed at 44: this is a rename, not a new workspace.

## Why

`spark-tool-<family>` is the inventory name for a stateless tool adapter.
Search and fetch do not own a Spark process. The previous `spark-web` name
collided with the `spark web` dispatcher plane.

## Compatibility

- Persisted `responseId` prefix remains `spark-web:`; the store remains
  `.spark/web/content.json`.
- Persisted extension specifiers `@zendev-lab/spark-web/extension` rewrite to
  `@zendev-lab/spark-tool-web/extension`.
- `packages/spark-web-dsh` is unchanged in this layer.

## Not in this change

Moving the DSH web boot out of `spark-cli` into `apps/spark-web`.
