# @zendev-lab/spark-protocol

JSON-safe schemas and types shared by native TUI, daemon, runtime WebSocket, and
Hub surfaces. This package owns refs/errors, command and event envelopes,
RoleSpec, Session lineage, invocation lifecycle, interactions, and view models.

Session protocol v3 and registry v7 use one runtime entity: `Session`.
`lineage` is either root or `{ kind: "child", parentSessionId, origin }`.
Origins preserve provenance for session, side-thread, TaskRun, Task revision,
Workflow, driver, driver tick, and Invocation creation without defining another
runtime parent relation. Role identity remains in `roleBinding`. Old clients
receive an explicit protocol-version mismatch rather than compatibility aliases.

Repro terminal output uses the strict `spark.repro.lane-result/v2` schema from
`@zendev-lab/spark-protocol/repro-lane`. It rejects unknown fields and binds the
exact checkpoint, Session, TaskRef, RunRef, optional source checkpoint, and
Formalize parent checkpoint. Repository revisions are optional Evidence, not
Repro routing identity.

Local RPC turn methods map to `turn.submit.request`, `turn.status.request`,
`turn.stream.subscribe`, and `turn.cancel.request`. Invocation records include a
durable serialization key: ordinary children serialize on themselves, while a
driver or driver-tick child shares the parent Session key. The scheduler keeps
FIFO order across daemon restart.

The shared conversation model projects the message-part wire schema into
stateless rendering semantics. The package must not import terminal, Svelte, Pi
SDK, `pi-tui`, or Spark application internals. See
[`../../.agents/notes/contracts/turn.md`](../../.agents/notes/contracts/turn.md).
