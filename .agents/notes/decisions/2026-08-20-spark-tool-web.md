---
description: "Place search/fetch in spark-tool-web and spark web in apps/spark-web"
owner: zrr1999
created: 2026-08-20
---

# spark-tool-web capability and spark-web application

## Decision

- Rename the search/fetch capability from `@zendev-lab/spark-web` to
  `@zendev-lab/spark-tool-web`.
- Make `@zendev-lab/spark-web` the `apps/spark-web` application that owns
  `spark web`. Absorb the former `spark-web-dsh` client plugin and the CLI
  in-process boot.
- Keep the package budget closed at 44.

## Compatibility

- `responseId` prefix remains `spark-web:`; store remains `.spark/web/content.json`.
- `@zendev-lab/spark-web/extension` rewrites to `@zendev-lab/spark-tool-web/extension`.
- DSH overlay id stays `spark-web-dsh`.
- `spark web` dispatches to the `spark-web` companion, like hub/tui.

## Not in this change

Native web surface, `dsh-scope`, or `dsh-tools` guard/pre-execute wiring.
