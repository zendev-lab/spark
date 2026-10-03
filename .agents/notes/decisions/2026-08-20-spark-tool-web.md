---
description: "Place search/fetch in spark-tool-web and spark web in apps/spark-web"
owner: zrr1999
created: 2026-08-20
---

# spark-tool-web capability and spark-web application

> This package placement is superseded by
> [the 2026-08-25 DSH Web decision](./2026-08-25-dsh-tool-web.md).

## Decision

- Search/fetch stays `@zendev-lab/spark-tool-web`.
- `@zendev-lab/spark-web` is the `apps/spark-web` application: a loopback
  workbench talking to the local daemon. It is not a DSH profile overlay.

## Compatibility

- `responseId` prefix remains `spark-web:`; store remains `.spark/web/content.json`.
- `@zendev-lab/spark-web/extension` rewrites to `@zendev-lab/spark-tool-web/extension`.
- `spark-web-dsh` remains the distinct DSH-hosted Spark application; it does not
  own this search/fetch capability and is not a compatibility alias for
  `spark-web`.

See `2026-08-19-spark-web-surface.md` for the workbench/TUI retirement.
