# Adjacent-release compatibility

Spark publishes Hub, daemon, and TUI in lockstep, but deployments do not switch
all running processes atomically. Lockstep package versions therefore do not
permit lockstep-only runtime assumptions.

The machine-readable source of truth is
[`architecture/release-compatibility.json`](../../../architecture/release-compatibility.json),
validated by
[`architecture/release-compatibility.schema.json`](../../../architecture/release-compatibility.schema.json)
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

The tag workflow installs the reviewed published baseline and candidate from
exact immutable artifacts, then exercises these phases in isolated homes:

| Phase | Required proof |
| --- | --- |
| candidate Hub → baseline daemon | product identity, registration/handshake, projection read, command delivery, reconnect, cleanup |
| baseline Hub → candidate daemon | the same operations with ownership reversed |
| candidate TUI → baseline daemon | product identity, local RPC status, session snapshot, event decoding, cursor reconnect, cancellation-safe detach, cleanup |
| baseline TUI → candidate daemon | the same operations with ownership reversed |
| candidate ↔ candidate | current product identity, health, transport, and cleanup sanity |

Each phase uses a fresh `SPARK_HOME`, runtime directory, database, ports, and
process generation. Cleanup captures PID and process-start identity, proves that
the exact process exited, verifies that ports, sockets, PID files, and leases were
released, and refuses to signal an unverifiable PID. An unverifiable cleanup
preserves the fixture and fails the release.

The runners write machine-readable product, database, and combined reports under
`dist/release/`. A report passes only when its phase and assertion IDs exactly
match this contract, every required assertion passes, and every cleanup is
verified. Missing, duplicate, skipped, `not-applicable`, or extra phases fail
closed after the first split exception. Reports are uploaded with the exact
artifacts; console output alone is not release evidence.

## Database upgrade protocol

A successful SQL migration is not sufficient evidence that an installation is
upgrade-safe. Every durable database owner must publish a schema compatibility
contract and classify each immutable migration as expand, backfill, or contract.
Only expand migrations are eligible for automatic managed updates. A contract
migration requires an operator-confirmed maintenance path and a verified backup.

The contract inventories both product-level SQLite owners and their manifests:

- daemon: `apps/spark-daemon/src/store/migrations/manifest.json`;
- Hub: `packages/spark-hub-db/src/migrations/manifest.json`.

The Hub has numbered SQL migrations and binds every packaged SQL byte sequence to
an SHA-256 checksum. The daemon did not historically have a numbered ledger: its
pre-manifest initializer and repair functions are represented honestly as the
single `legacy-inline-v0` validated baseline. They must not be retroactively
invented as numbered migrations. Future daemon schema changes start a real
immutable migration sequence from that baseline.

On open, each owner validates the packaged manifest before touching the database,
obtains SQLite migration ownership with `BEGIN IMMEDIATE`, and rejects an
unknown/future head, modified clean checksum, dirty or failed record, incompatible
reader/writer head, malformed legacy adoption, or required schema drift. A
transactional interruption rolls the migration back and deterministic reopen
reapplies it. Only the owner executes or interprets migrations.

The release runner invokes product-owned hidden database probes from the installed
Hub and daemon packages; it does not copy SQL, insert owner rows directly, or
infer success from a database file existing.

## Change procedure

A change to a cross-product protocol, persisted envelope, database migration, or
release artifact must update the compatibility contract and its behavioral
fixtures in the same PR. A release cannot waive a failed adjacent phase by
marking the migration manual; manual migration changes rollout mechanics, not
Hub/daemon/TUI wire compatibility.
