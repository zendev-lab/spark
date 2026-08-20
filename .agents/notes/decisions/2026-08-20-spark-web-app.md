---
description: "Place spark web DSH boot in apps/spark-web"
owner: zrr1999
created: 2026-08-20
---

# spark-web application

## Decision

Make `@zendev-lab/spark-web` the `apps/spark-web` application that owns
`spark web` / `spark-web`. Absorb the former `spark-web-dsh` DSH client
plugin and the CLI in-process boot into that app. Keep the package budget
closed at 44: this is a capability-to-application reclassify, not a new
workspace.

## Why

`spark web` is a Spark-owned process: it boots the DSH web profile, writes
managed plugins into that profile, and is a dispatcher plane. Keeping the
DSH client in `packages/` implied a capability while the real process still
lived inside `spark-cli`.

## Compatibility

- The DSH overlay id stays `spark-web-dsh` so existing profiles skip a
  second insert. The profile still resolves the client plugin as
  `@zendev-lab/spark-web-dsh`.
- `spark web` dispatches to the `spark-web` companion the same way `spark
  hub` and `spark tui` dispatch, instead of importing the boot path
  in-process.

## Not in this change

Native-izing the web surface beyond DSH profile boot, `dsh-scope`, or
`dsh-tools` guard/pre-execute wiring.
