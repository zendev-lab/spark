# Adjacent-release compatibility

Spark publishes Hub, daemon, and TUI in lockstep, but deployments do not switch
all running processes atomically. Lockstep package versions therefore do not
permit lockstep-only runtime assumptions.

The machine-readable source of truth is
[`architecture/release-compatibility.json`](../../architecture/release-compatibility.json),
validated by
[`architecture/release-compatibility.schema.json`](../../architecture/release-compatibility.schema.json)
and `scripts/validate-release-compatibility.mjs`. This document defines its
semantics. Unknown contract fields, missing required fields, duplicate graph
identities, incomplete edge directions, and an exception outside its declared
release are invalid rather than forward-compatible policy extensions.

## Compatibility invariant

For every stable release `N`, each supported product edge must accept peers from
`N - 1`, `N`, and `N + 1`:

```text
Hub N-1 ─┐                 ┌─ TUI N-1
Hub N   ─┼─ daemon N-1/N/N+1 ─┼─ TUI N
Hub N+1 ─┘                 └─ TUI N+1
```

There is no direct Hub ↔ TUI compatibility promise. The daemon is the boundary
between control-plane projection and terminal interaction.

A release candidate can only test versions that already exist. Consequently,
the release gate for candidate `N` proves both directions of `N ↔ N - 1`; the
next release's gate proves the remaining `N ↔ N + 1` obligation. Same-version
smoke remains necessary but is not evidence of adjacent compatibility.

The first split release, `0.3.0`, has one bounded exception: published `0.2.1`
is the legacy all-in-one package and has no independent Hub or TUI artifacts.
Once `0.3.0` is the published baseline, every later stable release must run the
complete split-product matrix. The exception must not be copied forward.

## Required release matrix

The tag workflow must install the reviewed published baseline and the candidate
from exact immutable artifacts, then exercise these phases in isolated homes.
The canonical gate selects the newest published stable version older than the
candidate; a caller cannot choose an older convenient version after the split.
It records each installed package name, version, executable path, and tarball or
registry integrity before starting a process:

| Phase | Required proof |
| --- | --- |
| candidate Hub → baseline daemon | product identity, registration/handshake, projection read, command delivery, reconnect, cleanup |
| baseline Hub → candidate daemon | the same operations with the ownership reversed |
| candidate TUI → baseline daemon | product identity, local RPC status, session snapshot, event decoding, cursor reconnect, cancellation-safe detach, cleanup |
| baseline TUI → candidate daemon | the same operations with the ownership reversed |
| candidate ↔ candidate | current product identity, health, transport, and cleanup sanity |

The Hub probe uses the packaged Hub's registration, runtime WebSocket,
projection, and command owners. The TUI probe uses the packaged TUI's real
daemon client for workspace attachment, session snapshots, event cursors,
cancellation, and release. A root `spark` CLI, a source-checkout import, a fake
WebSocket, or an exit-zero placeholder is not evidence for either product edge.

Each phase must use a fresh `SPARK_HOME`, `HOME`, XDG directories, runtime
directory, database, ports, and process generation. Cleanup captures both PID
and process-start identity, proves that the exact process exited, verifies that
ports, sockets, PID files, and leases were released, and refuses to signal a
reused or unverifiable PID. An unverifiable cleanup preserves the fixture and
fails the release.

The runners write machine-readable product, database, and combined reports
under `dist/release/`. A report passes only when its phase and assertion IDs
exactly match this contract, every required assertion passes, and every cleanup
is verified. Missing, duplicate, skipped, `not-applicable`, or extra phases fail
closed after the first split exception. Reports are uploaded with the exact
artifacts; console output alone is not release evidence.

The current `test-release-migration.mjs` CLI ↔ daemon matrix remains valuable
for launcher and legacy transport compatibility, but it does not satisfy either
product edge above.

## Wire protocol rules

Product SemVer is not a wire-protocol version. Compatible adjacent releases may
share a protocol identifier.

- Additive fields are optional and have deterministic defaults.
- Peers negotiate the intersection of advertised capabilities.
- Unknown optional fields do not fail decoding.
- A required capability that cannot be negotiated fails before state mutation
  with both peer product versions, protocol versions, supported ranges, and the
  corrective action.
- A breaking schema or semantic change requires a bounded dual decoder/encoder
  bridge for one published release. The old path receives no new behavior and
  is removed only after the adjacent matrix no longer contains it.
- Persisted envelopes follow the same rule as transmitted envelopes.

Diagnostics must not tell operators that Hub and daemon must be from the exact
same release when the supported condition is an adjacent-version window.

## Database upgrade protocol

A successful SQL migration is not sufficient evidence that an installation is
upgrade-safe. Every durable database owner must publish a schema compatibility
contract and classify each immutable migration as one of:

1. **expand** — add nullable/defaulted columns, tables, indexes, or compatible
   representations. Both `N` and `N - 1` readers and writers remain valid.
2. **backfill** — populate or verify expanded structures without removing the
   old representation. It is restartable and idempotent.
3. **contract** — remove or reinterpret the old representation. It is never an
   automatic adjacent update and may occur no earlier than two releases after
   the corresponding expand migration.

Only `expand` migrations are eligible for automatic managed updates. A
`backfill` may run online only when explicitly declared bounded and restartable.
A `contract` migration requires an operator-confirmed maintenance path and a
verified backup.

### Migration metadata

Starting with the first release after `0.3.0`, each database migration set must
have machine-readable metadata. The contract inventories both product-level
SQLite owners and their required manifests:

- daemon: `apps/spark-daemon/src/store/migrations/manifest.json`;
- Hub: `packages/spark-hub-db/src/migrations/manifest.json`.

The Hub has numbered SQL migrations and binds every packaged SQL byte sequence
to a SHA-256 checksum. The daemon did not historically have a numbered ledger:
its pre-manifest initializer and repair functions are represented honestly as
the single `legacy-inline-v0` validated baseline. They must not be retroactively
invented as numbered migrations. The first future daemon schema change starts a
real immutable migration sequence from that baseline.

A database created before checksum metadata existed is adopted as
`legacy-unverified` only after its known migration identities or canonical
legacy shape validate. Adoption does not claim that the current SQL checksum is
the checksum historically applied. Fresh applications and all migrations added
after adoption are recorded `clean` with checksums. An unknown legacy shape is
not auto-repaired into a claimed baseline.

Each manifest must contain at least:

- immutable migration identity and SQL checksum;
- phase (`expand`, `backfill`, or `contract`);
- release that introduced it and, for contract, the expand migration it closes;
- minimum readable and writable schema heads;
- whether it is transactional, restartable, and backup-required.

On open, the owner validates the packaged manifest before touching the
database, obtains SQLite migration ownership with `BEGIN IMMEDIATE`, and rejects
an unknown/future applied identity, a modified clean checksum, a dirty or failed
record, an incompatible reader/writer head, or a malformed legacy adoption. A
transactional interruption rolls the migration back and a deterministic reopen
reapplies it; a persisted dirty fixture remains fail-closed until the declared
restartable recovery path repairs it. Two versions cannot migrate concurrently.

Only the owner executes or interprets migrations. The release runner invokes
product-owned hidden database probes from the installed Hub and daemon
packages; it does not copy SQL, insert owner rows directly, or infer success
from a database file existing.

### Database release tests

For every database owner, the release gate uses the exact candidate and
published baseline product binaries against copied, closed SQLite artifacts and
proves:

1. create, write, read, close, and checkpoint representative owner state with
   `N - 1`;
2. open/migrate/read/write the same database with `N`;
3. reopen/read/write it with `N - 1` when every candidate migration is in the
   declared adjacent writable window;
4. reopen with `N`, compare the manifest ledger and representative state, and
   prove migration idempotence;
5. create fresh state with `N` and prove `N - 1` can read/write it for an
   expand-only candidate;
6. interrupt each declared transactional boundary and prove rollback plus
   deterministic, idempotent recovery;
7. reject automatic backfill/contract execution, checksum mismatch, dirty and
   failed state, unknown applied identity, incompatible reader/writer head,
   concurrent migration ownership, and unsupported future schema.

Each phase uses a separate copy. Before copying, the owning process is stopped,
WAL is checkpointed, the connection is closed, and the database bytes and
manifest are hashed. A passing phase includes a verified cleanup result.

Executable rollback switches application versions. It does not restore an old
database snapshot or discard daemon sessions/messages. Destructive rollback is
a separate, explicit recovery operation.

## Change procedure

A change to a cross-product protocol, persisted envelope, database migration,
or release artifact must update the compatibility contract and its behavioral
fixtures in the same PR. A release cannot waive a failed adjacent phase by
marking the migration manual; manual migration only changes rollout mechanics,
not Hub/daemon/TUI wire compatibility.
