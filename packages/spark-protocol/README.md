# @zendev-lab/spark-protocol

JSON-safe schemas and types shared by native TUI, daemon, runtime WebSocket, and Hub surfaces. This package owns refs/errors, command/event envelopes, RoleSpec and Session lifecycle contracts, invocation lifecycle, registration, projections, interactions, and view models.

View-model protocol v2 is a coordinated daemon/TUI hard cut. It adds bounded
three-lane Repro summaries and single-line Goal readiness while the runtime
WebSocket envelope remains `spark.runtime.v1alpha1`; daemon and native TUI do
not negotiate mixed view-model versions.

The shared RoleSpec contract carries a content-addressed revision, semantic Model Type, capabilities, and tool/effect policy. Durable Session state carries immutable Owner and Role binding plus lifecycle, placement, state binding, visibility, retention, purpose, and transcript references; lifetime and activity exist only in the public projection. A discard-on-close Session may retain up to 16 daemon-sealed, 16 KiB close receipts while its transcript and Invocation payloads are deleted. Close candidates are strict owner reports, not Evidence or automatic Memory. Registry v6 is a hard cut: compatibility decoding belongs only to the explicit migration path.

`@zendev-lab/spark-protocol/conversation` projects the existing message-part
wire schema into shared, stateless conversation semantics. It normalizes text
phases, redacted thinking, images, tool lifecycle/result merging, and legacy
text-only messages; browser and terminal adapters continue to own their own
rendering and interaction behavior.

Local RPC turn methods map to `turn.submit.request`, `turn.status.request`, `turn.stream.subscribe`, and `turn.cancel.request`. Bounded invocation list/result/retry/retention payloads are also protocol-owned; retry results identify a new invocation and `retryOfInvocationId`. Runtime commands map to the same transport-neutral `SparkCommand` vocabulary. Facts use `SparkEvent`, including command status/rejection, projections, diagnostics, and errors.

The package must not import terminal, Svelte, Pi SDK, `pi-tui`, or Spark app internals. See [`../../.agents/notes/contracts/turn.md`](../../.agents/notes/contracts/turn.md).

The protocol package also owns the dependency-light A2UI v0.9/v0.9.1 basic
catalog normalizer. Workbench actions use the official client action envelope
plus Spark's revision- and generation-bound context. The public action schema is
closed to `pause`, `resume`, `run_now`, `retry_checkpoint`, and confirmed
`stop`; consumers map these to typed Loop control and must never treat an A2UI
event as a generic tool invocation.
