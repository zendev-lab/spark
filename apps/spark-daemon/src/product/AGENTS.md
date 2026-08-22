# Daemon product composition guide

This file extends the daemon [`AGENTS.md`](../../AGENTS.md) for the internal
Spark product composition under `apps/spark-daemon/src/product`.

## Responsibility

This directory is the single Spark product composition root. It assembles
existing commands, tools, capabilities, DSH/Cordis plugins, and host policy for
daemon-supervised execution. It is application-internal, not a workspace
package or a discoverable Spark product policy surface.

## Boundaries

- Register existing capability and runtime owners; do not reimplement them.
- Keep reusable domain mechanisms in their existing package owner. Keep only
  Spark product policy and application composition here.
- Mount supported DSH/Cordis plugins explicitly. Do not add `spark-base`, a
  second Cordis root, arbitrary Spark product policy discovery, or `package.json#pi`.
- Durable Session, Invocation, Task, Evidence, Repro, and Channel state remains
  with the daemon or its declared capability owner. Product hooks coordinate
  through owner APIs and do not become hidden schedulers.
- Shared schema and semantics enter `spark-protocol` before another surface
  consumes them.

## Testing

Cover static registration, permission and failure behavior, owner delegation,
and DSH host integration. Run the daemon package checks plus architecture,
boundary, product-build, and source-process checks when composition changes.
