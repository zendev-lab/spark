# 2026-08-19: Local spark-web surface and package budget

## Decision

Add `apps/spark-web` as the local daemon browser workbench. It talks
to the daemon over `spark-daemon-client` and shares presentation with Hub
through `packages/spark-ui`. Workspace identity is bound to the daemon: web
shows every workspace on this daemon. Hub is a multi-daemon proxy plus
management, not the cross-workspace owner.

The search/fetch capability is `@zendev-lab/spark-tool-web`; `spark-web` is the app.

Raise `packageBudget` for the browser-runtime boundary, then reduce it when
`spark-web-dsh`, `spark-tui`, `spark-tui-adapter`, and `pi-spark` retire. The
closed budget after those retirements is 41.

`private-adapter` (`spark-ui`) may be imported from `@zendev-lab/spark-hub` and
`@zendev-lab/spark-web` only.

## Rationale

dsh web is an external CLI overlay, not a Spark product surface. A Spark-owned
loopback workbench is required before that overlay and the TUI can retire. The
capability rename avoids two packages competing for `spark-web`.

## Consequences

- `spark web` starts `apps/spark-web` with loopback bind and a one-shot token.
- The UI lists daemon workspaces; cwd is only a launch context and may be
  unregistered.
- Shared command/event vocabulary stays in `spark-protocol`; each browser
  surface owns only its carrier.
- Do not vendor dsh web packages, introduce `ctx.sessionProjections`, or keep a
  `--legacy` dsh web path.
