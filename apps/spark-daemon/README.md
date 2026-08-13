# @zendev-lab/spark-daemon

Spark's local execution service. Public operator commands use `spark daemon`.

```bash
spark daemon status
spark daemon login --server-url http://127.0.0.1:5173
spark daemon workspace register /path/to/workspace --server-url http://127.0.0.1:5173 --token <workspace-token>
spark daemon workspace stop <workspace-name>
spark daemon workspace unregister <workspace-id> --dry-run
spark daemon workspace move <workspace-id> /new/path --dry-run
spark daemon workspace merge --into <target-id> --path /common/parent --all-nested --dry-run
spark daemon submit --session <id> --prompt <text> --json
spark daemon invocation status <invocation-id> --json
spark daemon invocation stream <invocation-id> --after <cursor> --limit 500 --json
spark daemon invocation cancel <invocation-id> --reason <text> --json
spark daemon restart --yes
spark daemon sync --wait
```

Use `--token -` to read a one-line registration token from stdin. Browser/device login stores a private machine credential for connectivity and refresh only; every workspace registration consumes a fresh workspace token. A successful registration prints a separate one-time browser key for `/{slug}/login`. Mint additional workspace browser keys on the Hub host with `spark hub workspace access create --workspace <id>` (list/revoke there too; name is display-only). Hub-level remote login uses `spark hub access create` and `/login`. Remote Hub URLs require HTTPS unless both login and registration explicitly use `--allow-insecure-http` on a trusted private network.

The daemon owns workspace arbitration, the Session registry and Owner-derived lifecycle, Administrator provisioning, channels, SQLite Invocations/receipts, per-Session execution fencing, cancellation, timeout, restart recovery, and the runtime WebSocket uplink. Hub receives projections; it is not execution truth.

Daemon SQLite startup uses the static registry under `src/store/migrations/`.
Each step declares a stable diagnostic ID and its state owner; startup executes
the registry in source order. Migrations remain idempotent and retain any
historical `daemon_meta` markers they already own, so compatibility cleanup and
registration backfills can still run on every database open.

`workspace stop` pauses a workspace but deliberately keeps its path reserved.
Use `workspace unregister` to free an idle path without deleting history,
`workspace move` to preserve an ID at a new path, or `workspace merge` to fold
nested workspaces into a parent. A merge keeps source IDs as durable aliases;
`workspace ls --all` exposes those retained records. Lifecycle mutations fail
closed while invocations or clients are active and require confirmation unless
`--yes` is supplied.

`spark daemon restart` requests a drain restart. Before admission closes, the daemon starts an external watchdog and atomically persists a restart fence with an exact restart ID and target process generation. Queued work stays durable. Active local/web session turns that reach the model-to-tool boundary atomically requeue their transient prompt delta and exact pending tool calls, then yield without dispatching those calls; the successor restores the checkpoint and continues with that tool batch once. Turns already inside a tool, channel/driver work, reset sessions, and other unsupported surfaces keep the conservative drain-to-settlement behavior. The successor becomes active only after scheduled work, direct invocations, and already-received channel admissions are idle. The command returns after acceptance so a daemon-hosted caller cannot wait on its own invocation; use `--wait` from an external shell to require the fenced replacement RPC identity to become ready.

Keep source/package updates outside the daemon. An updater should build or install into a staging location, atomically replace the deployed package, then run `spark daemon sync --wait`. `sync` starts a stopped daemon, leaves an already-current daemon alone, and requests the same fenced drain restart when the running build fingerprint differs. A running daemon also watches its deployed entrypoint and automatically requests that safe restart after a changed fingerprint remains stable. On macOS the launchd service remains the process supervisor; the daemon never pulls Git or overwrites its own installation.

An unplanned daemon exit resumes durable invocations that were left `running`: the successor requeues them with `invocation.resume` and a resume notice for the model session. Invalid task payloads still fail closed with `DAEMON_EXECUTION_INTERRUPTED`. Invocations that were still `queued` remain eligible for the next daemon generation.
