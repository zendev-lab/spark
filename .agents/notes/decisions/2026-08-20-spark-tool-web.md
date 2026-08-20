---
description: "Place search/fetch in spark-tool-web and spark web in apps/spark-web"
owner: zrr1999
created: 2026-08-20
---

# spark-tool-web capability and spark-web application

## Decision

- Search/fetch stays `@zendev-lab/spark-tool-web`.
- `@zendev-lab/spark-web` is the `apps/spark-web` application: a loopback
  workbench talking to the local daemon. It is not a DSH profile overlay.

## Compatibility

- `responseId` prefix remains `spark-web:`; store remains `.spark/web/content.json`.
- `@zendev-lab/spark-web/extension` rewrites to `@zendev-lab/spark-tool-web/extension`.
- The former `spark-web-dsh` overlay is retired.

See `2026-08-19-spark-web-surface.md` for the workbench/TUI retirement.
