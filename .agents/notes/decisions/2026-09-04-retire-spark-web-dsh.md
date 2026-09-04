---
description: "Retire apps/spark-web-dsh after explicit owner approval; native spark-web is the only local browser surface"
owner: zrr1999
created: 2026-09-04
---

# Retire spark-web-dsh

## Approval

The
[2026-08-23 replacement decision](./2026-08-23-web-replacement-and-package-normalization.md)
requires "an explicit manual approval naming that application" before
`spark web-dsh` may be removed. On 2026-09-04 the repository owner approved
full removal, naming the application:

> spark-web-dsh 可以全量移除了，我们现在全力做原生 spark-web (dsh内核）

This note records that approval; the removal ships as a separate PR as the
replacement gate in `apps/spark-web/PARITY.md` requires.

## Decision

- `apps/spark-web-dsh`, its CLI route, npm distribution, build/updater
  inventory, and architecture entry are removed in one change.
- Native `spark web` (daemon-wide Session tree, DSH kernel inside the daemon)
  is the only local browser product. The `spark web-dsh` CLI command reports
  removal and points to `spark web`, following the `tui`/`server` precedent.
- The managed `spark-standard` / `spark-ptc` agent presets ship with no
  replacement. Investigation found they are purely a Web DSH profile-boot
  concept: outside `apps/spark-web-dsh` nothing in the daemon or any package
  consumes them (the only remaining `spark-standard` occurrences are DSH
  transcript-format test fixture values in `spark-session`, a serialized
  field, not a preset consumer).
- These Web-DSH-only surfaces, still `partial`/`blocked` in
  `apps/spark-web/PARITY.md`, are consciously dropped rather than reimplemented
  for native Web: Action Bar commands (Goal/Loop/Repro configuration and native
  Plan review), the extra `--browse-root` launch flag, Compaction admission on
  the native DSH implementation, Plan Review (DSH plan state, questions
  projection, Ask/Approval exit gate), and DSH Schedule live/cold/fork matrix.
- `~/.dsh` profiles and presets already on user machines become inert. Per the
  hard constraint in `apps/spark-web/PARITY.md`, removal must not delete user
  DSH profiles or Session data, so this change adds no cleanup code; stale
  preset directories are simply never read again.
- Deprecating the published npm package `@zendev-lab/spark-web-dsh` is a
  follow-up maintainer action and is intentionally not executed in this
  change.
