# @zendev-lab/spark-protocol

JSON-safe schemas and types shared by native TUI, daemon, runtime WebSocket, and Hub surfaces. This package owns refs/errors, command/event envelopes, invocation lifecycle, registration, projections, interactions, and view models.

Local RPC turn methods map to `turn.submit.request`, `turn.status.request`, `turn.stream.subscribe`, and `turn.cancel.request`. Bounded invocation list/result/retry/retention payloads are also protocol-owned; retry results identify a new invocation and `retryOfInvocationId`. Runtime commands map to the same transport-neutral `SparkCommand` vocabulary. Facts use `SparkEvent`, including command status/rejection, projections, diagnostics, and errors.

The package must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark app internals. See [`../../docs/specs/turn.md`](../../docs/specs/turn.md).

The protocol package also owns the dependency-light A2UI v0.9/v0.9.1 basic
catalog normalizer. Workbench actions use the official client action envelope
plus Spark's revision- and generation-bound context. The public action schema is
closed to `pause`, `resume`, `run_now`, `retry_checkpoint`, and confirmed
`stop`; consumers map these to typed Loop control and must never treat an A2UI
event as a generic tool invocation.
