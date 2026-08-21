# 2026-08-19: Local spark-web surface and package budget

## Decision

Add `apps/spark-web` as the local daemon browser workbench. It talks
to the daemon over `spark-daemon-client` and shares presentation with Hub
through `packages/spark-ui`. Workspace identity is bound to the daemon: web
shows every workspace on this daemon. Hub is a multi-daemon proxy plus
management, not the cross-workspace owner.

The search/fetch capability is `@zendev-lab/spark-tool-web`; `spark-web` is the app.

Raise `packageBudget` for the browser-runtime boundary. `spark-tui`,
`spark-tui-adapter`, and `pi-spark` retire, while `spark-web-dsh` remains a
separate DSH-hosted Spark product application. The closed budget is therefore
42; DSH convergence must keep or reduce that number.

`private-adapter` (`spark-ui`) may be imported from `@zendev-lab/spark-hub` and
`@zendev-lab/spark-web` only.

## Rationale

`spark-web` is the daemon-backed local workbench. `spark-web-dsh` is a separate
Spark product application hosted on the DSH Web stack; it is not a temporary
fixture or a search-tool owner. The capability rename avoids either application
competing with the search/fetch package for `spark-web`.

## Consequences

- `spark web` starts `apps/spark-web` with loopback bind and a one-shot token.
- Workspace identity is daemon-local. Hub `serverUrl` belongs to daemon
  login/uplink scheduling, not the workspace row. The supervisor dials
  enrolled daemon profiles even when workspaces are still local-only.
- Shared command/event vocabulary stays in `spark-protocol`; each browser
  surface owns only its carrier.
- Do not introduce `ctx.sessionProjections` as a second Spark session owner or
  route `spark-web-dsh` through a `--legacy` path.
